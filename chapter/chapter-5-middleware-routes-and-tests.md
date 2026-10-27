# Chapter 5: Middleware Pertahanan, Kontrak Route `/api/v1`, & Suite Verifikasi Otomatis

Dokumen ini merupakan bagian **5 dari 5** dari spesifikasi teknis implementasi backend `bekemitir`. Fokus Chapter 5 adalah pertahanan di boundary HTTP (Security Headers, CORS $O(1)$, Bounded Rate Limiter $O(1)$, Dual-Client Auth dengan *Token Reuse Detection*), definisi lengkap endpoint `/api/v1/*`, serta rencana pengujian otomatis (`bun test`).

---

## 1. Invarian Big-O & Keamanan pada Chapter 5

| Middleware / Route | Time Complexity | Space Complexity | Jaminan Keamanan |
| :--- | :--- | :--- | :--- |
| `src/middleware/security.ts` | **$O(1)$** | **$O(1)$** | Mengecek `Origin` terhadap `config.corsOriginsSet.has(origin)` dalam **$O(1)$**. Menolak request body JSON > 1 MB (`413 Payload Too Large`) sebelum JSON di-parse ke memori. Memasang header `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. |
| `src/middleware/rate-limit.ts` | **$O(1)$** amortized | **$O(K)$** bounded ($K \le 10.000$ key) | Menggunakan `BoundedLruCache` dari Chapter 1. Setiap IP + bucket route memiliki counter `{ count, resetAt }`. Saat kuota habis, langsung mengembalikan `429 Too Many Requests` + header `Retry-After` dalam **$O(1)$** tanpa menyentuh database. |
| `src/middleware/auth.ts` | **$O(1)$** | **$O(1)$** | Ekstraksi JWT dari cookie `kemitir_at` (Web) atau header `Authorization: Bearer` (Mobile). Verifikasi tanda tangan HMAC-SHA256 secara *constant-time* di memori tanpa query DB di setiap request. |
| `POST /api/v1/auth/refresh` | **$O(\log N)$** | **$O(1)$** | **Refresh Token Reuse Detection**: Setiap sesi login membuat `family_id` baru. Saat refresh token dipakai, token lama ditandai `revoked_at = NOW()` dan diterbitkan token baru dalam `family_id` yang sama. Jika token yang **sudah berstatus `revoked_at IS NOT NULL`** dikirim lagi (indikasi token dicuri!), backend langsung mencabut **seluruh token dalam `family_id` tersebut** dalam 1 query! |
| `GET /api/v1/tiles/:layer/:z/:x/:y.mvt` | Cache Hit: **$O(1)$**<br>Cache Miss: **$O(\log N + M)$** | Bounded $\le 32\text{ MB}$ | Mendukung negosiasi `If-None-Match` (`ETag`) $\to$ respons `304 Not Modified` 0-byte dalam **$O(1)$**. |

---

## 2. Spesifikasi Middleware (`src/middleware/`)

### 2.1. `src/middleware/security.ts`
1. **Security Headers & CORS $O(1)$**:
   - Jika request memiliki header `Origin`:
     - Cek `config.corsOriginsSet.has(origin)` dalam **$O(1)$**.
     - Jika cocok, set `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Credentials: true`, dan `Vary: Origin`.
     - Jika `c.req.method === 'OPTIONS'`, kembalikan `204 No Content` langsung dalam **$O(1)$**.
2. **Body Size Guard**:
   - Memeriksa `Content-Length` dan jumlah byte stream maksimum (`1_048_576` bytes = 1 MB untuk endpoint API JSON) agar penyerang tidak bisa mengirim JSON raksasa yang memblokir thread JS saat `JSON.parse`.

### 2.2. `src/middleware/rate-limit.ts`
- Menyediakan factory `rateLimit({ windowMs, maxRequests, keyPrefix })` di atas `BoundedLruCache<{ count: number; resetAt: number }>({ maxEntries: 10_000 })`.
- Profil proteksi:
  - **Auth endpoints (`/api/v1/auth/login`, `/api/v1/auth/refresh`)**: Maksimal **10 request / 60 detik** per IP (mencegah *brute-force* password).
  - **Upload/Import endpoints (`/api/v1/imports/*`)**: Maksimal **15 request / 60 detik** per IP.
  - **General API**: Maksimal **300 request / 60 detik** per IP.

### 2.3. `src/middleware/auth.ts` — Dual-Client Authentication & RBAC
Sesuai aturan `AGENTS.md`:
- **Web (`webgiskemitir`)**:
  - Saat login/refresh dengan `clientType: 'web'` (atau header `X-Client-Type: web`), server menyetel 2 cookie `httpOnly`:
    - `kemitir_at`: Access Token (`HttpOnly; Path=/api/v1; SameSite=Lax; Max-Age=900` + `Secure` di production).
    - `kemitir_rt`: Refresh Token (`HttpOnly; Path=/api/v1/auth; SameSite=Strict; Max-Age=2592000` + `Secure` di production).
- **Mobile (`appgiskemitir`)**:
  - Saat login/refresh dengan `clientType: 'mobile'` (atau header `X-Client-Type: mobile`), server mengembalikan `{ accessToken, refreshToken, expiresIn, user }` di dalam body JSON.
- Middleware `authenticateOptional` mengisi `c.set('auth', { userId, role, client })` (default ke `{ userId: '00000000-0000-0000-0000-000000000000', role: 'anon', client: 'web' }` jika tanpa token).
- Middleware `requireRole(...allowedRoles)` menolak request dengan `401 Unauthorized` (jika masih `anon`) atau `403 Forbidden` (jika role tidak mencukupi) dalam **$O(1)$**.

### 2.4. `src/middleware/error.ts`
- Menangkap `ZodError`, mendekode pesan validasi per field dengan rapi (`400 VALIDATION_ERROR`).
- Menangkap error tak terduga, mencatat log internal tanpa mencetak token/password, dan mengembalikan `500 INTERNAL_SERVER_ERROR` generik yang aman.

---

## 3. Spesifikasi Lengkap Endpoint `/api/v1` (`src/routes/`)

### 3.1. `src/routes/auth.ts` (`/api/v1/auth`)
- `POST /api/v1/auth/login`
  - Body (Zod): `{ email: z.string().email().max(255), password: z.string().min(8).max(128), clientType: z.enum(['web', 'mobile']).optional() }`
  - Memverifikasi password dengan Argon2id (`Bun.password.verify`). Jika email tidak ditemukan, tetap menjalankan dummy hash verify untuk mencegah *user enumeration via timing attack*.
- `POST /api/v1/auth/refresh`
  - Membaca refresh token dari cookie `kemitir_rt` (web) atau body `{ refreshToken }` (mobile).
  - Menjalankan **Token Reuse Detection** dan merotasi pasangan access + refresh token.
- `POST /api/v1/auth/logout`
  - Mencabut keluarga refresh token aktif dan menghapus cookie `kemitir_at` & `kemitir_rt`.
- `GET /api/v1/auth/me`
  - Mengembalikan profil user yang sedang login (`requireRole('petugas', 'admin')`).

### 3.2. `src/routes/layers.ts` (`/api/v1/layers`)
- `GET /api/v1/layers`
  - Mengembalikan daftar layer spasial beserta URL template MVT (`/api/v1/tiles/{slug}/{z}/{x}/{y}.mvt`) atau URL publik PMTiles R2, `bbox`, dan `styleConfig`.
- `PATCH /api/v1/layers/:id` (`requireRole('admin')`)
  - Memperbarui `name`, `description`, `styleConfig`, atau `isPublic`, sekaligus mengubah `updated_at` agar ETag tile otomatis ter-invalidation.
- `DELETE /api/v1/layers/:id` (`requireRole('admin')`)
  - Menghapus layer beserta fitur vektor terkait (`ON DELETE CASCADE`).

### 3.3. `src/routes/tiles.ts` (`/api/v1/tiles`)
- `GET /api/v1/tiles/:layerSlug/:z/:x/:yFile`
  - Memastikan `:yFile` berakhiran `.mvt` (misal `123.mvt` $\to$ `y = 123`).
  - Memvalidasi $0 \le z \le 22$, $0 \le x < 2^z$, $0 \le y < 2^z$.
  - Mendukung `:layerSlug === 'observations'` (untuk me-render titik observasi lapangan sebagai vector tile MVT di peta) maupun slug layer hasil import Shapefile.
  - Menyetel header:
    - `Content-Type: application/vnd.mapbox-vector-tile`
    - `Cache-Control: public, max-age=3600`
    - `ETag: W/"..."`
    - `X-Tile-Cache: HIT | MISS`

### 3.4. `src/routes/observations.ts` (`/api/v1/observations`)
- `GET /api/v1/observations`
  - Query params (Zod): `limit` (`1..100`, default `25`), `cursor` (opsional), `severity` (opsional), `bbox` (`minLng,minLat,maxLng,maxLat` opsional).
  - Mengembalikan daftar observasi dengan *cursor pagination* $O(\log N + L)$ dan `meta.nextCursor`.
- `POST /api/v1/observations/sync` (`requireRole('petugas', 'admin')`)
  - Body (Zod): `{ items: z.array(observationItemSchema).min(1).max(100) }`
  - Memvalidasi rentang koordinat $-180 \le \text{lng} \le 180$ dan $-90 \le \text{lat} \le 90$.
  - Melakukan batch upsert idempoten berdasarkan `client_id` dalam 1 transaksi.
- `POST /api/v1/observations/photo-presign` (`requireRole('petugas', 'admin')`)
  - Menghasilkan presigned PUT URL ke R2 untuk unggah foto bukti lapangan (`contentType: 'image/jpeg' | 'image/png' | 'image/webp'`, maks 10 MB).

### 3.5. `src/routes/imports.ts` (`/api/v1/imports`)
- `POST /api/v1/imports/presign` (`requireRole('admin')`)
  - Body (Zod): `{ layerName, layerSlug, fileType: z.enum(['shapefile_zip', 'geotiff']), fileSizeBytes: z.number().int().min(100).max(200 * 1024 * 1024) }`
  - Membuat baris `import_jobs` berstatus `'pending_upload'` dan mengembalikan `{ jobId, uploadUrl, r2Key }`.
- `PUT /api/v1/imports/:id/local-upload` (`requireRole('admin')`)
  - Endpoint khusus saat mode uji coba lokal (ketika R2 tidak dikonfigurasi) untuk menulis file ke `./uploads` dan menguji alur import secara penuh di laptop.
- `POST /api/v1/imports/:id/enqueue` (`requireRole('admin')`)
  - Membaca magic bytes & EOCD ZIP menggunakan `zip-guard.ts` dalam **$O(E)$**. Jika tidak valid (bukan ZIP/TIFF asli, *Zip-Bomb*, *Zip-Slip*, atau kurang `.shp/.shx/.dbf/.prj`), status job diubah ke `'failed'` dan langsung mengembalikan `400 Bad Request`.
  - Jika valid, mengubah status job ke `'pending'` untuk diproses oleh `worker.ts`.
- `GET /api/v1/imports` & `GET /api/v1/imports/:id` (`requireRole('admin')`)
  - Memantau status antrean import.

### 3.6. `src/routes/summaries.ts` (`/api/v1/summaries`)
- `GET /api/v1/summaries/drought`
  - Mengembalikan agregasi jumlah laporan per tingkat keparahan (`normal`, `waspada`, `siaga`, `awas`), waktu observasi terbaru, dan total layer aktif secara instan dari Materialized View / indeks ringkasan.

---

## 4. Rencana Pengujian Otomatis (`tests/`)

Seluruh pengujian dijalankan menggunakan `bun test` dengan `DB_PROVIDER=sqlite` dan `SQLITE_PATH=:memory:` sehingga cepat, deterministik, dan terisolasi:

1. **`tests/lru-and-security.test.ts`**:
   - Membuktikan operasi `get`/`set` pada `BoundedLruCache` mengeviski elemen paling lama (LRU) dan menjaga batas `maxEntries` serta `maxBytes`.
   - Menguji `zip-guard.ts` terhadap:
     - File dengan magic bytes palsu (`INVALID_MAGIC_BYTES`).
     - File ZIP yang mengandung entry `../../etc/passwd` (`ZIP_SLIP_DETECTED`).
     - File ZIP dengan rasio kompresi ekstrem > 100:1 (`ZIP_BOMB_DETECTED`).
     - File ZIP yang tidak memiliki `.prj` atau `.dbf` (`MISSING_SHAPEFILE_COMPONENTS`).
     - File ZIP Shapefile valid yang memiliki `.shp`, `.shx`, `.dbf`, dan `.prj` (`valid: true`).
2. **`tests/auth.test.ts`**:
   - Menguji login Web (`Set-Cookie: kemitir_at=...; HttpOnly`) vs login Mobile (JSON `accessToken` & `refreshToken`).
   - Menguji **Token Reuse Detection**: memakai refresh token satu kali (sukses dapat token baru), lalu mencoba memakai refresh token lama sekali lagi $\to$ harus ditolak (`401`) dan token baru hasil rotasi sebelumnya otomatis ikut tercabut!
   - Menguji proteksi RBAC (`anon` ditolak di `/observations/sync`, `petugas` diizinkan di `/observations/sync` tapi ditolak di `/imports/presign`, `admin` diizinkan di semua).
3. **`tests/spatial-api.test.ts`**:
   - Menguji seed data Desa Kemitir, katalog `/api/v1/layers`, dan ringkasan `/api/v1/summaries/drought`.
   - Menguji batch offline sync idempoten (`POST /api/v1/observations/sync`): mengirim 2 titik baru, lalu mengirim ulang `clientId` yang sama dengan `severity` yang diperbarui $\to$ jumlah total baris tidak mengganda (*idempotent upsert*).
   - Menguji pencarian observasi dengan filter `bbox` (menggunakan `field_observations_rtree`) dan *cursor pagination*.
   - Menguji `/api/v1/tiles/batas-dusun-kemitir/:z/:x/:y.mvt` dan `/api/v1/tiles/observations/:z/:x/:y.mvt`: memastikan mengembalikan binary `application/vnd.mapbox-vector-tile` yang valid pada tile yang memuat Desa Kemitir, serta mengembalikan `304 Not Modified` saat header `If-None-Match` cocok dengan `ETag`.
