# Chapter 4: Pipeline Import Async, Proteksi Zip-Bomb $O(E)$, Cloudflare R2, & GDAL Worker

Dokumen ini merupakan bagian **4 dari 5** dari spesifikasi teknis implementasi backend `bekemitir`. Fokus Chapter 4 adalah keamanan dan efisiensi pemrosesan file geospasial berukuran besar (`.zip` Shapefile dan `.tif` GeoTIFF) tanpa pernah membebani memori HTTP server maupun membuka celah keamanan *Zip-Bomb*, *Zip-Slip*, atau *Command Injection*.

---

## 1. Invarian Big-O & Keamanan pada Chapter 4

| Komponen | Operasi | Time Complexity | Space Complexity | Jaminan Keamanan |
| :--- | :--- | :--- | :--- | :--- |
| `src/lib/zip-guard.ts` | `inspectMagicBytes(buf)` | **$O(1)$** (cek 4 byte pertama) | **$O(1)$** | Menolak file yang menyamar dengan ekstensi `.zip` atau `.tif` palsu. Wajib cocok dengan signature biner (`PK\x03\x04` untuk ZIP; `II*\x00` Little-Endian atau `MM\x00*` Big-Endian untuk TIFF). |
| `src/lib/zip-guard.ts` | `validateZipCentralDirectory(tailBuf)` | **$O(E)$** ($E \le 30$ file entry) | **$O(1)$** ($\le 65\text{ KB}$ buffer) | Membaca hanya **End of Central Directory (EOCD)** di bagian akhir file tanpa mengekstrak kompresi. Menolak **Zip-Bomb** (rasio `uncompressed / compressed > 100` atau `totalUncompressed > 250 MB`), menolak **Zip-Slip** (`..`, `/`, `\`, null byte), membatasi jumlah entry $\le 30$, dan memastikan ada `.shp`, `.shx`, `.dbf`, `.prj`. |
| `src/lib/r2.ts` | `createPresignedPutUrl`, `fetchObjectRange` | **$O(1)$** | **$O(1)$** | Server API **tidak pernah mem-proxy upload file besar**. Klien unggah langsung ke R2. Saat validasi `enqueue`, API hanya meminta `Range: bytes=0-65535` / `bytes=-65536` untuk memeriksa header & EOCD. |
| `src/lib/gdal.ts` | `runCommandSafe(args, timeoutMs)` | Sesuai ukuran file | Streamed / bounded | Menggunakan `Bun.spawn(argsArray)` **tanpa shell** (`/bin/sh -c` dilarang keras $\to$ mustahil terkena *command injection*). Dilengkapi `AbortSignal.timeout(180_000)` yang otomatis melakukan `proc.kill()` jika GDAL macet. |

---

## 2. Spesifikasi `src/lib/zip-guard.ts` — Anti Zip-Bomb & Zip-Slip dalam $O(E)$

### Mengapa Tidak Langsung `unzip`?
Penyerang dapat mengunggah file `.zip` berukuran 1 MB yang ketika diekstrak mengembang menjadi 50 GB (*Zip-Bomb*), langsung membuat disk atau RAM VPS penuh (*Denial of Service*), atau menyisipkan nama file `../../../../etc/cron.d/pwn` (*Zip-Slip*).

### Algoritma Inspeksi Binary ZIP (Tanpa Dekompresi):
1. **Validasi Magic Bytes $O(1)$**:
   - ZIP: Byte `[0..3]` wajib `0x50, 0x4B, 0x03, 0x04` (`PK\x03\x04`).
   - GeoTIFF: Byte `[0..3]` wajib `0x49, 0x49, 0x2A, 0x00` (`II*\0` - Little Endian) atau `0x4D, 0x4D, 0x00, 0x2A` (`MM\0*` - Big Endian) atau BigTIFF (`0x49, 0x49, 0x2B, 0x00`).
2. **Pencarian End of Central Directory (EOCD) $O(\min(N, 65557))$**:
   - Memindai mundur dari akhir buffer untuk menemukan signature EOCD `0x06054b50` (`PK\x05\x06`).
   - Membaca `totalEntries` (offset +10, uint16) dan `cdOffset` (offset +16, uint32).
   - Jika `totalEntries === 0` atau `totalEntries > 30`, langsung tolak!
3. **Iterasi Central Directory Header $O(E)$ ($E \le 30$)**:
   - Untuk setiap entry (signature `0x02014b50` / `PK\x01\x02`):
     - Baca `compressedSize` (uint32), `uncompressedSize` (uint32), dan `fileNameLength` (uint16).
     - Jika `compressedSize === 0 && uncompressedSize > 0` atau `uncompressedSize / compressedSize > 100`: tolak sebagai **Zip-Bomb (`ZIP_BOMB_DETECTED`)**.
     - Akumulasikan `totalUncompressedBytes`. Jika `> 250 * 1024 * 1024` (250 MB): tolak (`ZIP_TOO_LARGE`).
     - Periksa `fileName`:
       - Tolak jika mengandung `\0`, `..`, diawali `/` atau `\`, atau mengandung `:` (drive letter Windows).
     - Catat ekstensi file dasar (`.shp`, `.shx`, `.dbf`, `.prj`).
4. **Validasi Kelengkapan Shapefile**:
   - Pastikan keempat ekstensi wajib (`.shp`, `.shx`, `.dbf`, `.prj`) ditemukan pada nama dasar (*basename*) yang sama.

```typescript
export interface ZipValidationResult {
  valid: boolean
  code?:
    | 'INVALID_MAGIC_BYTES'
    | 'CORRUPT_ZIP_EOCD'
    | 'TOO_MANY_FILES'
    | 'ZIP_SLIP_DETECTED'
    | 'ZIP_BOMB_DETECTED'
    | 'UNCOMPRESSED_LIMIT_EXCEEDED'
    | 'MISSING_SHAPEFILE_COMPONENTS'
  message?: string
  entriesCount?: number
  totalUncompressedBytes?: number
  shapefileBaseName?: string
}

const MAX_ZIP_ENTRIES = 30
const MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024 // 250 MB
const MAX_COMPRESSION_RATIO = 100
const REQUIRED_SHP_EXTS = ['.shp', '.shx', '.dbf', '.prj'] as const
```

---

## 3. Spesifikasi `src/lib/r2.ts` — Cloudflare R2 & Fallback Lokal

Menggunakan `AwsClient` dari `aws4fetch` yang dibangun di atas WebCrypto (`crypto.subtle`) dan `fetch` bawaan Bun:
1. **`createUploadTarget(jobId, fileType)`**:
   - Menghasilkan object key immutable berbasis UUID: `imports/${jobId}/source.${ext}` (tidak pernah menggunakan nama file asli dari user untuk mencegah path traversal atau konflik karakter).
   - Jika `config.isR2Configured === true`, menandatangani URL `PUT` ke `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${key}?X-Amz-Expires=900`.
   - Jika `config.isR2Configured === false` (mode uji coba lokal), mengembalikan URL endpoint lokal `/api/v1/imports/${jobId}/local-upload`.
2. **`readObjectHeaderAndTail(key, totalSize)`**:
   - Untuk validasi ZIP tanpa mengunduh file penuh: mengambil byte awal dan 64 KB terakhir melalui HTTP `Range` request ke R2 (atau `Bun.file(localPath).slice(...)` pada mode lokal) dalam waktu **$O(1)$**.
3. **`getPublicPmTilesUrl(r2Key)`**:
   - Mengembalikan URL publik CDN R2 dengan header `Cache-Control: public, max-age=31536000, immutable`.

---

## 4. Spesifikasi `src/lib/gdal.ts` & `src/worker.ts`

### Alur Worker (`bun run src/worker.ts`):
1. Polling tabel `import_jobs` dengan interval eksponensial ringan (1 detik saat aktif, hingga 5 detik saat idle).
2. Mengambil 1 job berstatus `'pending'` secara atomik (`claimNextPendingJob()`):
   - Di PostgreSQL:
     ```sql
     UPDATE import_jobs
     SET status = 'processing', updated_at = NOW()
     WHERE id = (
       SELECT id FROM import_jobs
       WHERE status = 'pending'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *;
     ```
3. **Jika `file_type === 'shapefile_zip'`**:
   - Unduh file `.zip` ke direktori kerja sementara `/tmp/bekemitir-job-${job.id}`.
   - Jalankan `validateShapefileZipBuffer` sekali lagi sebagai pertahanan lapis kedua.
   - Ekstrak komponen `.shp`, `.shx`, `.dbf`, `.prj` yang sudah tervalidasi aman, lalu konversi ke GeoJSON (`EPSG:4326`) menggunakan `ogr2ogr`:
     ```ts
     await runCommandSafe([
       'ogr2ogr',
       '-f', 'GeoJSON',
       '-t_srs', 'EPSG:4326',
       '-nlt', 'PROMOTE_TO_MULTI',
       outputGeoJsonPath,
       inputShpPath,
     ], 180_000)
     ```
   - Masukkan seluruh fitur beserta atribut DBF-nya (`feature.properties`) ke tabel `vector_features` dan daftarkan layer di `spatial_layers`.
   - Jika di mode uji coba lokal `ogr2ogr` belum terinstal di Windows host, sediakan parser fallback untuk bundel GeoJSON/Shapefile sederhana atau laporkan pesan diagnostik yang jelas.
4. **Jika `file_type === 'geotiff'`**:
   - Konversi `.tif` menjadi Cloud-Optimized GeoTIFF / `.pmtiles` menggunakan `gdal_translate` & `pmtiles` CLI, unggah ke R2 dengan key `pmtiles/${job.id}.pmtiles`, dan daftarkan di `spatial_layers` dengan `layer_type = 'raster_pmtiles'`.
5. Bersihkan direktori `/tmp/bekemitir-job-${job.id}` pada blok `finally` agar disk VPS tidak pernah bocor.
