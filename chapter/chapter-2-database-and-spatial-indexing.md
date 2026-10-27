# Chapter 2: Arsitektur Database Dual-Mode (PostGIS GiST + SQLite R\*Tree), RLS, & Prepared Statements

Dokumen ini merupakan bagian **2 dari 5** dari spesifikasi teknis implementasi backend `bekemitir`. Fokus Chapter 2 adalah skema database yang **dinamis (*schema-agnostic*)**, terindeks secara spasial di kedua mode (`GIST` pada PostgreSQL/PostGIS di VPS dan **Virtual Table R\*Tree** pada `bun:sqlite` di lokal), serta penggunaan *prepared statements* terparameterisasi.

---

## 1. Invarian Big-O & Keamanan pada Chapter 2

| Operasi Database | PostgreSQL + PostGIS (`DB_PROVIDER=postgres`) | SQLite Lokal (`DB_PROVIDER=sqlite`) | Kompleksitas Waktu |
| :--- | :--- | :--- | :--- |
| **Pencarian Spasial 2D (Bounding Box / Tile)** | `geom && ST_Transform(ST_TileEnvelope(z,x,y), 4326)` menggunakan **GiST Index** | `JOIN ..._rtree ON ... WHERE max_lng >= ? AND min_lng <= ? ...` menggunakan **SQLite R\*Tree Index** | **$O(\log N + M)$** ($M$ = fitur di dalam bbox, bukan scan $O(N)$) |
| **Lookup User / Refresh Token** | B-Tree `UNIQUE(email)` & `UNIQUE(token_hash)` | B-Tree `UNIQUE(email)` & `UNIQUE(token_hash)` | **$O(\log N)$** |
| **Cursor Pagination Observasi** | B-Tree `(observed_at DESC, id DESC)` dengan perbandingan tuple `(observed_at, id) < ($1, $2)` | B-Tree `(observed_at DESC, id DESC)` dengan klausa ekuivalen | **$O(\log N + L)$** ($L \le 100$ limit, konstan di halaman ke-berapa pun) |
| **Klaim Antrean Worker** | Partial Index `WHERE status = 'pending'` + `FOR UPDATE SKIP LOCKED` | Partial Index `WHERE status = 'pending'` + `UPDATE ... RETURNING` atomik | **$O(\log P)$** ($P$ = jumlah job pending) |
| **Kompilasi Query SQL** | Parameterized query via connection pool | Cached `db.query(sql)` (*Prepared Statement* dikompilasi 1x di memori) | **$O(1)$** lookup statement |

---

## 2. Skema PostgreSQL + PostGIS (`migrations/0001_init.sql`)

Dirancang untuk Docker VPS (`postgis/postgis:16-3.4-alpine`). Semua kolom geometri wajib menggunakan SRID `4326` dan memiliki indeks `GIST`.

```sql
-- 0001_init.sql (PostgreSQL + PostGIS)
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Tabel Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('anon', 'petugas', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Tabel Refresh Tokens (mendukung Token Reuse Detection via family_id)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  client_type TEXT NOT NULL CHECK (client_type IN ('web', 'mobile')),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family_id ON refresh_tokens(family_id);

-- 3. Katalog Layer Spasial (Vektor MVT & Raster PMTiles)
CREATE TABLE IF NOT EXISTS spatial_layers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  layer_type TEXT NOT NULL CHECK (layer_type IN ('vector_mvt', 'raster_pmtiles')),
  geometry_type TEXT NOT NULL CHECK (geometry_type IN ('Point', 'LineString', 'Polygon', 'MultiPolygon', 'Geometry', 'Raster')),
  r2_pmtiles_key TEXT,
  min_zoom INTEGER NOT NULL DEFAULT 0 CHECK (min_zoom BETWEEN 0 AND 22),
  max_zoom INTEGER NOT NULL DEFAULT 18 CHECK (max_zoom BETWEEN 0 AND 22),
  bbox JSONB NOT NULL DEFAULT '[110.0, -7.8, 110.5, -7.4]'::jsonb,
  style_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_public BOOLEAN NOT NULL DEFAULT true,
  feature_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Tabel Fitur Vektor Dinamis (Menampung seluruh atribut .shp di kolom properties JSONB)
CREATE TABLE IF NOT EXISTS vector_features (
  id BIGSERIAL PRIMARY KEY,
  layer_id UUID NOT NULL REFERENCES spatial_layers(id) ON DELETE CASCADE,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  geom GEOMETRY(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vector_features_layer_id ON vector_features(layer_id);
CREATE INDEX IF NOT EXISTS idx_vector_features_geom ON vector_features USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_vector_features_props ON vector_features USING GIN (properties);

-- 5. Tabel Observasi Lapangan (Mobile App Offline-First Sync)
CREATE TABLE IF NOT EXISTS field_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('normal', 'waspada', 'siaga', 'awas')),
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  photo_r2_key TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  geom GEOMETRY(Point, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_field_observations_geom ON field_observations USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_field_observations_cursor ON field_observations (observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_field_observations_severity ON field_observations (severity);

-- 6. Tabel Antrean Import Async (.zip Shapefile & .tif GeoTIFF)
CREATE TABLE IF NOT EXISTS import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  layer_name TEXT NOT NULL,
  layer_slug TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('shapefile_zip', 'geotiff')),
  source_r2_key TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes > 0),
  status TEXT NOT NULL CHECK (status IN ('pending_upload', 'pending', 'processing', 'completed', 'failed')),
  error_message TEXT,
  output_layer_id UUID REFERENCES spatial_layers(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_pending ON import_jobs (created_at ASC) WHERE status = 'pending';

-- 7. Materialized View untuk Ringkasan Cepat O(1)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_drought_summaries AS
SELECT
  severity,
  COUNT(*)::INTEGER AS observation_count,
  MAX(observed_at) AS latest_observed_at
FROM field_observations
GROUP BY severity;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_drought_summaries_sev ON mv_drought_summaries (severity);

-- 8. Row Level Security (RLS)
ALTER TABLE spatial_layers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vector_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;

-- Policy spatial_layers: anon/petugas hanya melihat is_public = true, admin melihat semua
CREATE POLICY policy_layers_select ON spatial_layers
  FOR SELECT USING (
    is_public = true OR current_setting('app.user_role', true) = 'admin'
  );

CREATE POLICY policy_layers_admin_all ON spatial_layers
  FOR ALL USING (current_setting('app.user_role', true) = 'admin');

-- Policy field_observations: semua bisa baca, petugas hanya bisa insert/update miliknya sendiri, admin penuh
CREATE POLICY policy_obs_select ON field_observations
  FOR SELECT USING (true);

CREATE POLICY policy_obs_write ON field_observations
  FOR INSERT WITH CHECK (
    current_setting('app.user_role', true) IN ('petugas', 'admin')
    AND user_id::text = current_setting('app.user_id', true)
  );

CREATE POLICY policy_obs_update ON field_observations
  FOR UPDATE USING (
    current_setting('app.user_role', true) = 'admin'
    OR (
      current_setting('app.user_role', true) = 'petugas'
      AND user_id::text = current_setting('app.user_id', true)
    )
  );
```

---

## 3. Skema SQLite + R\*Tree Spatial Index (`migrations/sqlite_init.sql`)

Pada mode uji coba lokal (`DB_PROVIDER=sqlite`), kita menggunakan modul **R\*Tree bawaan SQLite** (`USING rtree(...)`) agar pencarian bounding box 2D tetap memiliki kompleksitas **$O(\log N + M)$** dan tidak pernah melakukan *full table scan* $O(N)$.

```sql
-- sqlite_init.sql (bun:sqlite dengan R*Tree Spatial Index)
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('anon', 'petugas', 'admin')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  client_type TEXT NOT NULL CHECK (client_type IN ('web', 'mobile')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rt_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_rt_family_id ON refresh_tokens(family_id);

CREATE TABLE IF NOT EXISTS spatial_layers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  layer_type TEXT NOT NULL CHECK (layer_type IN ('vector_mvt', 'raster_pmtiles')),
  geometry_type TEXT NOT NULL CHECK (geometry_type IN ('Point', 'LineString', 'Polygon', 'MultiPolygon', 'Geometry', 'Raster')),
  r2_pmtiles_key TEXT,
  min_zoom INTEGER NOT NULL DEFAULT 0,
  max_zoom INTEGER NOT NULL DEFAULT 18,
  bbox TEXT NOT NULL DEFAULT '[110.0, -7.8, 110.5, -7.4]',
  style_config TEXT NOT NULL DEFAULT '{}',
  is_public INTEGER NOT NULL DEFAULT 1,
  feature_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vector_features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  layer_id TEXT NOT NULL REFERENCES spatial_layers(id) ON DELETE CASCADE,
  properties TEXT NOT NULL DEFAULT '{}',
  geojson TEXT NOT NULL,
  min_lng REAL NOT NULL,
  min_lat REAL NOT NULL,
  max_lng REAL NOT NULL,
  max_lat REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vf_layer_id ON vector_features(layer_id);

-- R*Tree Spatial Index O(log N) untuk vector_features
CREATE VIRTUAL TABLE IF NOT EXISTS vector_features_rtree USING rtree(
  id,
  min_lng, max_lng,
  min_lat, max_lat
);

CREATE TABLE IF NOT EXISTS field_observations (
  rowid_id INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('normal', 'waspada', 'siaga', 'awas')),
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  properties TEXT NOT NULL DEFAULT '{}',
  photo_r2_key TEXT,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lng REAL NOT NULL,
  lat REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fo_cursor ON field_observations (observed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_fo_severity ON field_observations (severity);

-- R*Tree Spatial Index O(log N) untuk field_observations
CREATE VIRTUAL TABLE IF NOT EXISTS field_observations_rtree USING rtree(
  rowid_id,
  min_lng, max_lng,
  min_lat, max_lat
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  layer_name TEXT NOT NULL,
  layer_slug TEXT NOT NULL,
  file_type TEXT NOT NULL CHECK (file_type IN ('shapefile_zip', 'geotiff')),
  source_r2_key TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_upload', 'pending', 'processing', 'completed', 'failed')),
  error_message TEXT,
  output_layer_id TEXT REFERENCES spatial_layers(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ij_pending ON import_jobs (status, created_at ASC);
```

---

## 4. `src/db/client.ts` — Prepared Statement Cache & RLS Context

Untuk mencegah kompilasi ulang query SQL di setiap HTTP request:
- Di SQLite (`bun:sqlite`), `getSqliteStmt(sql)` mengambil objek `Statement` yang sudah di-compile dari `Map<string, Statement>` dalam **$O(1)$**.
- Di PostgreSQL (`Bun.sql` / `SQL`), digunakan koneksi pool dengan helper `withPgRls(rlsContext, fn)` yang mengeksekusi:
  ```sql
  SELECT set_config('app.user_id', $1, true), set_config('app.user_role', $2, true);
  ```
  secara aman (parameterized) di awal transaksi sebelum query utama dijalankan.

---

## 5. `src/db/migrate.ts` & `src/db/seed.ts`
- `migrate.ts`: Menjalankan `migrations/sqlite_init.sql` (jika `DB_PROVIDER=sqlite`) atau `migrations/0001_init.sql` (jika `DB_PROVIDER=postgres`).
- `seed.ts`: Mengisi data awal untuk pengujian lokal di Desa Kemitir:
  1. Akun `admin@kemitir.id` (role: `admin`) dan `petugas@kemitir.id` (role: `petugas`).
  2. Layer Vektor contoh `batas-dusun-kemitir` (`Polygon`) beserta 3 fitur poligon dusun di Desa Kemitir lengkap dengan indeks R\*Tree-nya.
  3. 4 titik `field_observations` dengan variasi tingkat keparahan (`normal`, `waspada`, `siaga`, `awas`).
