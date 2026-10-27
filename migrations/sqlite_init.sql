-- sqlite_init.sql (bun:sqlite dengan R*Tree Spatial Index O(log N))
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
  bbox TEXT NOT NULL DEFAULT '[110.28, -7.24, 110.32, -7.20]',
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
