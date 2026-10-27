# AGENTS.md — bekemitir (Backend API)

Backend API for a drought-monitoring Web GIS (KKN community-service project). It serves geospatial data to the web client (`webgiskemitir`) and the mobile app (`appgiskemitir`) over `/api/v1`.

Non-monorepo: this project is standalone. Its siblings are separate repos/projects, not workspace packages.

## Runtime: Bun, not Node

Bun is both the runtime and the package manager (`bun.lock` is present). Use `bun` / `bunx`. Never use npm, yarn, or pnpm.

Node-only APIs and `process`-centric patterns are discouraged. Prefer Web-standard APIs (`fetch`, `Request`/`Response`, WebCrypto, `URL`) plus Bun built-ins (`Bun.file`, `Bun.spawn`, `Bun.sql`, `Bun.serve`).

```bash
bun run dev          # dev server (bun run --hot src/index.ts)
bun test             # tests via bun:test
bunx tsc --noEmit    # typecheck (tsconfig has strict: true)
```

Run typecheck and tests before declaring any task done.

## Project layout

```
src/index.ts      # entry: create the Hono app, mount routers, export default
src/routes/       # one module per resource; each exports a Hono router
src/db/           # queries, migrations, connection setup
src/middleware/   # auth, validation, rate limiting, error handling
src/lib/          # pure helpers with no Hono/DB coupling
```

Keep handlers thin. Business logic belongs in `src/lib` or `src/db`, not inline in routes.

## Database: PostgreSQL + PostGIS

- Use **parameterized queries only**. Never build SQL with template literals or string interpolation.
- Every geometry column needs a **GiST index** (`CREATE INDEX ... ON t USING GIST (geom)`). Without it, spatial queries do full table scans.
- Filter with a bounding box (`geom && ST_MakeEnvelope(...)` or `ST_TileEnvelope`) before any expensive geometry operation, so the GiST index is used.
- Use **Row Level Security** for user-scoped tables. Set the request identity per connection/session (`SET LOCAL app.user_id = ...`) instead of hand-writing `WHERE user_id = ...` in every query. Roles: `anon` (public read), `petugas` (field input), `admin`.
- Pool connections. Cap Postgres `max_connections`; never open a connection per request.
- Migrations are versioned SQL files. Never edit an already-applied migration; add a new one.

## Spatial API: serve MVT, not GeoJSON

- Expose vector tiles with `ST_AsMVT` / `ST_AsMVTGeom` / `ST_TileEnvelope`, e.g. `GET /api/v1/tiles/:z/:x/:y.mvt`.
- Never stream large GeoJSON `FeatureCollection`s to clients.
- Compute heavy summaries (e.g. drought status per kecamatan) in **materialized views** refreshed on a schedule, not on every request.

## Async import pipeline (.shp / .tif)

Never parse shapefiles or rasters inside an HTTP handler — imports take minutes and will time out mobile clients.

1. Client uploads a `.zip` (shapefile sets must be zipped: `.shp` + `.shx` + `.dbf` + `.prj`) or a `.tif` to Cloudflare R2 via a presigned URL.
2. Insert a row into `import_jobs` with status `pending`.
3. A separate worker (`bun run worker.ts`) picks up jobs and shells out via `Bun.spawn` to GDAL CLI tools — `ogr2ogr` / `shp2pgsql` for vector, `gdal_translate` (→ COG) and `tippecanoe` (→ PMTiles) for raster.
4. Update job status; the client polls or subscribes for completion.

- Do not depend on native GDAL bindings for Bun; call the CLI binaries.
- Raster is served as **PMTiles from R2** — not from PostGIS raster and not from a dynamic tile server.
- Validate zip contents before extracting: reject path traversal / zip-slip, cap uncompressed size and file count.

## Security

- Validate every request body, query, and param with Zod at the route boundary. Never trust client-supplied geometry or coordinates; validate coordinate ranges.
- CORS: use an explicit origin allowlist. Never combine `origin: '*'` with credentials.
- Rate limit auth and upload endpoints.
- Uploads: validate magic bytes (not just the extension), enforce a size limit, store under a UUID-generated name, and never use a client-provided path.
- Auth has two client shapes and must stay that way: web uses httpOnly + Secure + SameSite cookies; mobile uses short-lived access tokens plus a refresh token. Do not collapse them into a single mechanism.
- Secrets come from `.env` only. Never log secrets, tokens, or full request bodies.
- `.gitignore` blocks `.env` and `.env.*`. Commit real values only to the untracked `.env`; keep `.env.example` (tracked) up to date with the required keys.

## Storage: Cloudflare R2

- Access via the S3-compatible API.
- Prefer presigned URLs so clients upload and download directly; the API must not proxy large files.
- Object keys are immutable/versioned. Set long-lived cache headers for tiles (`Cache-Control: public, max-age=31536000, immutable`).

## API contract

- All routes live under `/api/v1`.
- Return a consistent JSON envelope for both success and errors, with correct HTTP status codes.
- Paginate list endpoints and cap page size. Never `SELECT *` without a `LIMIT`.

## Anti-patterns

- `process.env.X` read ad hoc across modules instead of a single config module.
- Template-literal SQL.
- Per-feature queries inside a loop (use one set-based query or `UNNEST`).
- Doing import/GDAL work inside a request handler.
- Returning raw geometry as GeoJSON when a tile endpoint fits.
