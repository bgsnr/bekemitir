# Chapter 3: Engine Spasial (MVT Vector Tiles, ETag LRU Cache, Cursor Pagination, & Set-Based Offline Sync)

Dokumen ini merupakan bagian **3 dari 5** dari spesifikasi teknis implementasi backend `bekemitir`. Fokus Chapter 3 adalah algoritma spasial berkinerja tinggi: konversi koordinat tile Web Mercator $O(1)$, pembangkitan Mapbox Vector Tile (`.mvt`) satu lintasan $O(V)$, caching tile dengan `ETag`, *cursor pagination* $O(\log N + L)$, dan sinkronisasi batch offline idempoten $O(B \log N)$.

---

## 1. Invarian Big-O & Keamanan pada Chapter 3

| Fungsi / Endpoint | Kompleksitas Waktu | Kompleksitas Memori | Penjelasan Algoritmik |
| :--- | :--- | :--- | :--- |
| `tileToBBox(z, x, y)` | **$O(1)$** | **$O(1)$** | Rumus proyeksi balik Web Mercator (`EPSG:3857` tile grid $\to$ `EPSG:4326` `[minLng, minLat, maxLng, maxLat]`) menggunakan operasi trigonometri dasar. |
| `encodeMvtTile(layers)` (`src/lib/mvt-lite.ts`) | **$O(V + P)$** ($V$ = jumlah verteks, $P$ = jumlah pasang key-value properti) | **$O(V + P)$** | Deduplikasi dictionary `keys` dan `values` per layer menggunakan `Map<string, number>` dalam **$O(1)$** per atribut (bukan `Array.indexOf` yang $O(P^2)$!). Geometri dikodekan dengan ZigZag + Varint dalam satu lintasan (*single-pass*). |
| `getVectorTile(slug, z, x, y)` (`src/db/queries/tiles.ts`) | Cache Hit: **$O(1)$**<br>Cache Miss: **$O(\log N + M)$** | Bounded $\le 32\text{ MB}$ (`BoundedLruCache`) | Mengecek LRU Cache dengan key `${layerSlug}:${layerUpdatedAt}:${z}/${x}/${y}`. Jika hit, langsung mengembalikan buffer & mengecek `If-None-Match` (`304 Not Modified` dalam **$O(1)$**). Jika miss, query dibatasi `LIMIT 5000` fitur agar tidak pernah membebani RAM. |
| `listObservations(filter)` (`src/db/queries/observations.ts`) | **$O(\log N + L)$** ($L \le 100$) | **$O(L)$** | Menggunakan **Keyset/Cursor Pagination** `(observed_at, id) < (cursorTime, cursorId)` yang memanfaatkan B-Tree index `(observed_at DESC, id DESC)`. Tidak menggunakan `OFFSET` besar yang berbiaya $O(\text{offset})$. |
| `syncObservationsBatch(userId, items)` | **$O(B \log N)$** ($B \le 100$) | **$O(B)$** | Tanpa loop jaringan. Di Postgres: 1 query `UNNEST(...) ON CONFLICT (client_id) DO UPDATE`. Di SQLite: 1 transaksi `db.transaction()` menggunakan *prepared statement* yang sudah dikompilasi. |

---

## 2. Spesifikasi `src/lib/mvt-lite.ts` — Kalkulator Tile & Encoder Protobuf MVT $O(V)$

Sesuai aturan `AGENTS.md`, klien (`webgiskemitir` & `appgiskemitir`) wajib mengonsumsi **MVT (`/api/v1/tiles/:layer/:z/:x/:y.mvt`)**, bukan GeoJSON besar.
- Saat `DB_PROVIDER=postgres`, MVT dibuat langsung oleh C-engine PostGIS (`ST_AsMVT` + `ST_AsMVTGeom`).
- Saat `DB_PROVIDER=sqlite` (mode uji coba lokal & automated test), `mvt-lite.ts` mengodekan fitur yang lolos saringan R\*Tree menjadi binary Protobuf sesuai spesifikasi resmi **Mapbox Vector Tile v2.1** (`application/vnd.mapbox-vector-tile`).

### Detail Algoritma `mvt-lite.ts`:
1. **Proyeksi Tile Envelope $O(1)$**:
   $$n = 2^z, \quad \text{lng} = \frac{x}{n} \cdot 360 - 180, \quad \text{lat} = \frac{180}{\pi} \arctan\!\left(\sinh\!\left(\pi \left(1 - \frac{2y}{n}\right)\right)\right)$$
2. **Transformasi Koordinat Lokal Tile (`extent = 4096`) $O(1)$ per verteks**:
   Mengubah `(lng, lat)` menjadi koordinat integer `[0..4096]` relatif terhadap tile `(z, x, y)`.
3. **Command & Parameter Encoding (MVT Spec Section 4.3)**:
   - `MoveTo(1)` dan `LineTo(2)` serta `ClosePath(7)` dikodekan dengan `commandInteger = (id & 0x7) | (count << 3)`.
   - Koordinat delta `(dx, dy)` dikodekan dengan **ZigZag encoding**: `((n << 1) ^ (n >> 31)) >>> 0` diikuti dengan **Protobuf Varint**.
4. **Dictionary Atribut $O(1)$**:
   Setiap layer MVT menyimpan tabel `keys` dan `values`. Kita menggunakan `keyIndexMap = new Map<string, number>()` dan `valIndexMap = new Map<string, number>()` sehingga pencarian indeks tag atribut berlangsung dalam **$O(1)$**, menghindari jebakan kuadratik $O(P^2)$.

---

## 3. Spesifikasi `src/db/queries/tiles.ts`

### Alur Eksekusi `getLayerTileMvt(layerSlug, z, x, y)`:
1. Validasi batas koordinat tile dalam **$O(1)$**:
   - $0 \le z \le 22$
   - $0 \le x < 2^z$ dan $0 \le y < 2^z$. Jika di luar rentang, tolak dengan `400 Bad Request`.
2. Lookup metadata layer (`getLayerBySlug(layerSlug)`) dalam **$O(\log L)$** (atau untuk layer spesial `'observations'` langsung mengarah ke tabel `field_observations`).
3. Bentuk `cacheKey = "${layerSlug}:${layer.updated_at}:${z}/${x}/${y}"` dan `etag = W/"${Bun.hash(cacheKey).toString(16)}"`.
4. Cek `tileLruCache.get(cacheKey)` dalam **$O(1)$**. Jika ada, kembalikan `{ buffer, etag, cacheHit: true }`.
5. Jika cache miss:
   - **Mode PostgreSQL (`DB_PROVIDER=postgres`)**:
     ```sql
     WITH tile_env AS (
       SELECT ST_TileEnvelope($1, $2, $3) AS env_3857,
              ST_Transform(ST_TileEnvelope($1, $2, $3), 4326) AS env_4326
     ),
     mvt_geom AS (
       SELECT
         vf.id,
         vf.properties,
         ST_AsMVTGeom(
           ST_Transform(vf.geom, 3857),
           tile_env.env_3857,
           4096,
           64,
           true
         ) AS geom
       FROM vector_features vf
       CROSS JOIN tile_env
       WHERE vf.layer_id = $4
         AND vf.geom && tile_env.env_4326
       LIMIT 5000
     )
     SELECT ST_AsMVT(mvt_geom.*, $5, 4096, 'geom', 'id') AS mvt
     FROM mvt_geom
     WHERE geom IS NOT NULL;
     ```
   - **Mode SQLite (`DB_PROVIDER=sqlite`)**:
     ```sql
     SELECT vf.id, vf.properties, vf.geojson
     FROM vector_features vf
     INNER JOIN vector_features_rtree rt ON vf.id = rt.id
     WHERE vf.layer_id = ?
       AND rt.max_lng >= ? AND rt.min_lng <= ?
       AND rt.max_lat >= ? AND rt.min_lat <= ?
     LIMIT 5000;
     ```
     Lalu di-encode menggunakan `encodeMvtTile(...)` dari `src/lib/mvt-lite.ts`.
6. Simpan hasil ke `tileLruCache` (kapasitas maks 500 tile / 32 MB, TTL 5 menit) dan kembalikan `{ buffer, etag, cacheHit: false }`.

---

## 4. Spesifikasi `src/db/queries/observations.ts`

### A. Cursor Pagination & Spatial BBox Filter (`listObservations`)
- Menerima parameter:
  - `limit`: dibatasi `1..100` (default `25`).
  - `cursor`: string base64url yang mengodekan `${observed_at}|${id}`.
  - `bbox`: opsional `[minLng, minLat, maxLng, maxLat]` (divalidasi $-180 \le \text{minLng} \le \text{maxLng} \le 180$ dan $-90 \le \text{minLat} \le \text{maxLat} \le 90$).
  - `severity`: opsional filter `'normal' | 'waspada' | 'siaga' | 'awas'`.
- Mengambil `limit + 1` baris untuk menentukan apakah ada halaman berikutnya (`hasMore = rows.length > limit`) dalam **1 kali query** tanpa perlu menjalankan `SELECT COUNT(*)` yang berbiaya $O(N)$!

### B. Idempotent Offline Sync (`syncObservationsBatch`)
- Menerima array `items` (maksimal `100` item per batch).
- Setiap item divalidasi memiliki `clientId` (UUID v4 yang di-generate oleh aplikasi mobile `appgiskemitir` saat di lapangan), `lng` ($[-180, 180]$), `lat` ($[-90, 90]$), `category`, `severity`, `title`, `notes`, `properties`, dan `observedAt`.
- **Jaminan Keamanan & Idempotensi**:
  - Jika `client_id` sudah pernah masuk sebelumnya dari `user_id` yang sama (misal karena koneksi HP terputus saat menerima respons lalu mobile app mengirim ulang antrean), klausa `ON CONFLICT (client_id) DO UPDATE ... WHERE field_observations.user_id = EXCLUDED.user_id` memperbarui baris secara aman tanpa menduplikasi data dan **menolak perubahan jika `client_id` milik user lain**.
  - Setelah transaksi batch selesai, cache tile layer `'observations'` dibersihkan agar peta langsung menampilkan titik terbaru.
