import { config } from '../../config'
import {
  ANON_RLS_CONTEXT,
  getSqliteStmt,
  withPgRls,
  type RlsContext,
} from '../client'

export interface SpatialLayerRecord {
  id: string
  slug: string
  name: string
  description: string
  layerType: 'vector_mvt' | 'raster_pmtiles'
  geometryType: 'Point' | 'LineString' | 'Polygon' | 'MultiPolygon' | 'Geometry' | 'Raster'
  r2PmtilesKey: string | null
  tileUrlTemplate: string | null
  pmtilesUrl: string | null
  minZoom: number
  maxZoom: number
  bbox: [number, number, number, number]
  styleConfig: Record<string, unknown>
  isPublic: boolean
  featureCount: number
  updatedAt: string
  createdAt: string
}

interface SqliteLayerRow {
  id: string
  slug: string
  name: string
  description: string
  layer_type: 'vector_mvt' | 'raster_pmtiles'
  geometry_type: SpatialLayerRecord['geometryType']
  r2_pmtiles_key: string | null
  min_zoom: number
  max_zoom: number
  bbox: string
  style_config: string
  is_public: number
  feature_count: number
  updated_at: string
  created_at: string
}

function mapRowToLayerRecord(row: {
  id: string
  slug: string
  name: string
  description: string
  layer_type: 'vector_mvt' | 'raster_pmtiles'
  geometry_type: SpatialLayerRecord['geometryType']
  r2_pmtiles_key: string | null
  min_zoom: number
  max_zoom: number
  bbox: string | [number, number, number, number]
  style_config: string | Record<string, unknown>
  is_public: number | boolean
  feature_count: number
  updated_at: string | Date
  created_at: string | Date
}): SpatialLayerRecord {
  const bboxParsed: [number, number, number, number] =
    typeof row.bbox === 'string' ? JSON.parse(row.bbox) : row.bbox
  const styleParsed: Record<string, unknown> =
    typeof row.style_config === 'string' ? JSON.parse(row.style_config) : row.style_config

  const isVector = row.layer_type === 'vector_mvt'
  const pmtilesUrl =
    !isVector && row.r2_pmtiles_key
      ? `${config.R2_PUBLIC_URL.replace(/\/$/, '')}/${row.r2_pmtiles_key}`
      : null

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    layerType: row.layer_type,
    geometryType: row.geometry_type,
    r2PmtilesKey: row.r2_pmtiles_key,
    tileUrlTemplate: isVector ? `/api/v1/tiles/${row.slug}/{z}/{x}/{y}.mvt` : null,
    pmtilesUrl,
    minZoom: Number(row.min_zoom),
    maxZoom: Number(row.max_zoom),
    bbox: bboxParsed,
    styleConfig: styleParsed,
    isPublic: Boolean(row.is_public),
    featureCount: Number(row.feature_count),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }
}

/**
 * Mengambil daftar layer spasial sesuai hak akses (RLS).
 */
export async function listSpatialLayers(
  rls: RlsContext = ANON_RLS_CONTEXT
): Promise<SpatialLayerRecord[]> {
  if (config.DB_PROVIDER === 'sqlite') {
    if (rls.role === 'admin') {
      const rows = getSqliteStmt<SqliteLayerRow, []>(
        `SELECT * FROM spatial_layers ORDER BY created_at DESC LIMIT 100`
      ).all()
      return rows.map(mapRowToLayerRecord)
    }

    const rows = getSqliteStmt<SqliteLayerRow, []>(
      `SELECT * FROM spatial_layers WHERE is_public = 1 ORDER BY created_at DESC LIMIT 100`
    ).all()
    return rows.map(mapRowToLayerRecord)
  }

  return withPgRls(rls, async (tx) => {
    const rows = await tx.unsafe(
      `SELECT * FROM spatial_layers ORDER BY created_at DESC LIMIT 100`
    )
    return (rows as SqliteLayerRow[]).map(mapRowToLayerRecord)
  })
}

/**
 * Mencari layer berdasarkan slug dalam O(log L) via UNIQUE index.
 */
export async function getLayerBySlug(
  slug: string,
  rls: RlsContext = ANON_RLS_CONTEXT
): Promise<SpatialLayerRecord | null> {
  if (config.DB_PROVIDER === 'sqlite') {
    const row = getSqliteStmt<SqliteLayerRow, [string]>(
      `SELECT * FROM spatial_layers WHERE slug = ? LIMIT 1`
    ).get(slug)
    if (!row) return null
    if (!row.is_public && rls.role !== 'admin') return null
    return mapRowToLayerRecord(row)
  }

  return withPgRls(rls, async (tx) => {
    const rows = await tx.unsafe(`SELECT * FROM spatial_layers WHERE slug = $1 LIMIT 1`, [slug])
    if (!rows || rows.length === 0) return null
    return mapRowToLayerRecord(rows[0] as SqliteLayerRow)
  })
}

export async function updateSpatialLayer(
  id: string,
  patch: {
    name?: string
    description?: string
    styleConfig?: Record<string, unknown>
    isPublic?: boolean
  },
  rls: RlsContext
): Promise<SpatialLayerRecord | null> {
  if (rls.role !== 'admin') {
    throw new Error('FORBIDDEN')
  }

  const nowIso = new Date().toISOString()

  if (config.DB_PROVIDER === 'sqlite') {
    const existing = getSqliteStmt<SqliteLayerRow, [string]>(
      `SELECT * FROM spatial_layers WHERE id = ? LIMIT 1`
    ).get(id)
    if (!existing) return null

    const nextName = patch.name ?? existing.name
    const nextDesc = patch.description ?? existing.description
    const nextStyle =
      patch.styleConfig !== undefined ? JSON.stringify(patch.styleConfig) : existing.style_config
    const nextPublic =
      patch.isPublic !== undefined ? (patch.isPublic ? 1 : 0) : existing.is_public

    getSqliteStmt<unknown, [string, string, string, number, string, string]>(
      `UPDATE spatial_layers
       SET name = ?, description = ?, style_config = ?, is_public = ?, updated_at = ?
       WHERE id = ?`
    ).run(nextName, nextDesc, nextStyle, nextPublic, nowIso, id)

    const updated = getSqliteStmt<SqliteLayerRow, [string]>(
      `SELECT * FROM spatial_layers WHERE id = ? LIMIT 1`
    ).get(id)
    if (updated) {
      const { invalidateTileCacheForLayer } = await import('./tiles')
      invalidateTileCacheForLayer(updated.slug)
    }
    return updated ? mapRowToLayerRecord(updated) : null
  }

  return withPgRls(rls, async (tx) => {
    const rows = await tx.unsafe(
      `UPDATE spatial_layers
       SET name = COALESCE($2, name),
           description = COALESCE($3, description),
           style_config = COALESCE($4::jsonb, style_config),
           is_public = COALESCE($5, is_public),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.name ?? null,
        patch.description ?? null,
        patch.styleConfig ? JSON.stringify(patch.styleConfig) : null,
        patch.isPublic ?? null,
      ]
    )
    if (!rows || rows.length === 0) return null
    const rec = mapRowToLayerRecord(rows[0] as SqliteLayerRow)
    const { invalidateTileCacheForLayer } = await import('./tiles')
    invalidateTileCacheForLayer(rec.slug)
    return rec
  })
}

export async function deleteSpatialLayer(id: string, rls: RlsContext): Promise<boolean> {
  if (rls.role !== 'admin') {
    throw new Error('FORBIDDEN')
  }

  if (config.DB_PROVIDER === 'sqlite') {
    const existing = getSqliteStmt<SqliteLayerRow, [string]>(
      `SELECT * FROM spatial_layers WHERE id = ? LIMIT 1`
    ).get(id)
    // Bersihkan R*Tree milik fitur di layer ini terlebih dahulu
    getSqliteStmt<unknown, [string]>(
      `DELETE FROM vector_features_rtree
       WHERE id IN (SELECT id FROM vector_features WHERE layer_id = ?)`
    ).run(id)
    const res = getSqliteStmt<unknown, [string]>(`DELETE FROM spatial_layers WHERE id = ?`).run(id)
    if (existing) {
      const { invalidateTileCacheForLayer } = await import('./tiles')
      invalidateTileCacheForLayer(existing.slug)
    }
    return res.changes > 0
  }

  return withPgRls(rls, async (tx) => {
    const rows = await tx.unsafe(`DELETE FROM spatial_layers WHERE id = $1 RETURNING slug`, [id])
    if (Array.isArray(rows) && rows.length > 0) {
      const { invalidateTileCacheForLayer } = await import('./tiles')
      invalidateTileCacheForLayer(String((rows[0] as { slug: string }).slug))
      return true
    }
    return false
  })
}
