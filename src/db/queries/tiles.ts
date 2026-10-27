import { config } from '../../config'
import { BoundedLruCache } from '../../lib/lru-cache'
import {
  encodeMvtTile,
  isValidTileCoord,
  tileToBBox,
  type MvtInputFeature,
} from '../../lib/mvt-lite'
import {
  ANON_RLS_CONTEXT,
  getSqliteStmt,
  withPgRls,
  type GeoJsonGeometry,
  type RlsContext,
} from '../client'
import { getLayerBySlug } from './layers'

export interface TileResult {
  buffer: Uint8Array
  etag: string
  cacheHit: boolean
}

const tileCache = new BoundedLruCache<Uint8Array>({
  maxEntries: 512,
  maxBytes: 32 * 1024 * 1024, // Maksimal 32 MB RAM untuk tile cache
  ttlMs: 5 * 60 * 1000, // 5 menit
})

let observationsVersionToken = 'v1'

export function bumpObservationsTileVersion(): void {
  observationsVersionToken = `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  tileCache.deleteByPrefix('observations:')
}

export function invalidateTileCacheForLayer(layerSlug: string): void {
  tileCache.deleteByPrefix(`${layerSlug}:`)
}

export function clearAllTileCache(): void {
  tileCache.clear()
}

function makeWeakEtag(cacheKey: string): string {
  const hashHex = Bun.hash(cacheKey).toString(16)
  return `W/"${hashHex}"`
}

/**
 * Menghasilkan binary Vector Tile (.mvt) untuk layer tertentu pada koordinat (z, x, y).
 * Kompleksitas:
 * - Cache Hit: O(1)
 * - Cache Miss: O(log N + M) melalui indeks R*Tree (SQLite) atau GiST (PostGIS), dibatasi LIMIT 5000.
 */
export async function getLayerTileMvt(
  layerSlug: string,
  z: number,
  x: number,
  y: number,
  rls: RlsContext = ANON_RLS_CONTEXT
): Promise<TileResult | null> {
  if (!isValidTileCoord(z, x, y)) {
    throw new Error('INVALID_TILE_COORD')
  }

  if (layerSlug === 'observations') {
    return getObservationsTileMvt(z, x, y, rls)
  }

  const layer = await getLayerBySlug(layerSlug, rls)
  if (!layer || layer.layerType !== 'vector_mvt') {
    return null
  }

  if (z < layer.minZoom || z > layer.maxZoom) {
    return {
      buffer: new Uint8Array(0),
      etag: makeWeakEtag(`${layerSlug}:empty:${z}`),
      cacheHit: true,
    }
  }

  const cacheKey = `${layerSlug}:${layer.updatedAt}:${z}/${x}/${y}`
  const etag = makeWeakEtag(cacheKey)

  const cached = tileCache.get(cacheKey)
  if (cached) {
    return { buffer: cached, etag, cacheHit: true }
  }

  const bbox = tileToBBox(z, x, y)
  const [minLng, minLat, maxLng, maxLat] = bbox

  if (config.DB_PROVIDER === 'sqlite') {
    const rows = getSqliteStmt<
      { id: number; properties: string; geojson: string },
      [string, number, number, number, number]
    >(
      `SELECT vf.id, vf.properties, vf.geojson
       FROM vector_features vf
       INNER JOIN vector_features_rtree rt ON vf.id = rt.id
       WHERE vf.layer_id = ?
         AND rt.max_lng >= ? AND rt.min_lng <= ?
         AND rt.max_lat >= ? AND rt.min_lat <= ?
       LIMIT 5000`
    ).all(layer.id, minLng, maxLng, minLat, maxLat)

    const mvtFeatures: MvtInputFeature[] = new Array(rows.length)
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      mvtFeatures[i] = {
        id: r.id,
        properties: JSON.parse(r.properties) as Record<string, unknown>,
        geometry: JSON.parse(r.geojson) as GeoJsonGeometry,
      }
    }

    const buffer = encodeMvtTile(layer.slug, mvtFeatures, bbox)
    tileCache.set(cacheKey, buffer, Math.max(1, buffer.byteLength))
    return { buffer, etag, cacheHit: false }
  }

  // Mode PostgreSQL + PostGIS menggunakan ST_AsMVT & ST_TileEnvelope
  const buffer = await withPgRls(rls, async (tx) => {
    const rows = await tx.unsafe(
      `WITH tile_env AS (
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
         WHERE vf.layer_id = $4::uuid
           AND vf.geom && tile_env.env_4326
         LIMIT 5000
       )
       SELECT ST_AsMVT(mvt_geom.*, $5, 4096, 'geom', 'id') AS mvt
       FROM mvt_geom
       WHERE geom IS NOT NULL`,
      [z, x, y, layer.id, layer.slug]
    )

    const mvtRaw = rows?.[0]?.mvt
    return mvtRaw ? new Uint8Array(mvtRaw as ArrayBufferLike) : new Uint8Array(0)
  })

  tileCache.set(cacheKey, buffer, Math.max(1, buffer.byteLength))
  return { buffer, etag, cacheHit: false }
}

async function getObservationsTileMvt(
  z: number,
  x: number,
  y: number,
  rls: RlsContext
): Promise<TileResult> {
  const cacheKey = `observations:${observationsVersionToken}:${z}/${x}/${y}`
  const etag = makeWeakEtag(cacheKey)

  const cached = tileCache.get(cacheKey)
  if (cached) {
    return { buffer: cached, etag, cacheHit: true }
  }

  const bbox = tileToBBox(z, x, y)
  const [minLng, minLat, maxLng, maxLat] = bbox

  if (config.DB_PROVIDER === 'sqlite') {
    const rows = getSqliteStmt<
      {
        rowid_id: number
        id: string
        category: string
        severity: string
        title: string
        observed_at: string
        lng: number
        lat: number
      },
      [number, number, number, number]
    >(
      `SELECT fo.rowid_id, fo.id, fo.category, fo.severity, fo.title, fo.observed_at, fo.lng, fo.lat
       FROM field_observations fo
       INNER JOIN field_observations_rtree rt ON fo.rowid_id = rt.rowid_id
       WHERE rt.max_lng >= ? AND rt.min_lng <= ?
         AND rt.max_lat >= ? AND rt.min_lat <= ?
       LIMIT 5000`
    ).all(minLng, maxLng, minLat, maxLat)

    const mvtFeatures: MvtInputFeature[] = new Array(rows.length)
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      mvtFeatures[i] = {
        id: r.rowid_id,
        properties: {
          observation_id: r.id,
          category: r.category,
          severity: r.severity,
          title: r.title,
          observed_at: r.observed_at,
        },
        geometry: {
          type: 'Point',
          coordinates: [r.lng, r.lat],
        },
      }
    }

    const buffer = encodeMvtTile('observations', mvtFeatures, bbox)
    tileCache.set(cacheKey, buffer, Math.max(1, buffer.byteLength))
    return { buffer, etag, cacheHit: false }
  }

  const buffer = await withPgRls(rls, async (tx) => {
    const rows = await tx.unsafe(
      `WITH tile_env AS (
         SELECT ST_TileEnvelope($1, $2, $3) AS env_3857,
                ST_Transform(ST_TileEnvelope($1, $2, $3), 4326) AS env_4326
       ),
       mvt_geom AS (
         SELECT
           fo.id AS observation_id,
           fo.category,
           fo.severity,
           fo.title,
           fo.observed_at,
           ST_AsMVTGeom(
             ST_Transform(fo.geom, 3857),
             tile_env.env_3857,
             4096,
             64,
             true
           ) AS geom
         FROM field_observations fo
         CROSS JOIN tile_env
         WHERE fo.geom && tile_env.env_4326
         LIMIT 5000
       )
       SELECT ST_AsMVT(mvt_geom.*, 'observations', 4096, 'geom') AS mvt
       FROM mvt_geom
       WHERE geom IS NOT NULL`,
      [z, x, y]
    )

    const mvtRaw = rows?.[0]?.mvt
    return mvtRaw ? new Uint8Array(mvtRaw as ArrayBufferLike) : new Uint8Array(0)
  })

  tileCache.set(cacheKey, buffer, Math.max(1, buffer.byteLength))
  return { buffer, etag, cacheHit: false }
}
