import { config } from '../../config'
import type { ConvertedVectorDataset } from '../../lib/gdal'
import type { ImportFileType } from '../../lib/zip-guard'
import {
  computeGeoJsonBBox,
  getSqliteDb,
  getSqliteStmt,
  withPgRls,
  type RlsContext,
} from '../client'
import { invalidateTileCacheForLayer } from './tiles'

export type ImportJobStatus =
  | 'pending_upload'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'

export interface ImportJobRecord {
  id: string
  userId: string
  layerName: string
  layerSlug: string
  fileType: ImportFileType
  sourceR2Key: string
  fileSizeBytes: number
  status: ImportJobStatus
  errorMessage: string | null
  outputLayerId: string | null
  createdAt: string
  updatedAt: string
  finishedAt: string | null
}

interface SqliteJobRow {
  id: string
  user_id: string
  layer_name: string
  layer_slug: string
  file_type: ImportFileType
  source_r2_key: string
  file_size_bytes: number
  status: ImportJobStatus
  error_message: string | null
  output_layer_id: string | null
  created_at: string | Date
  updated_at: string | Date
  finished_at: string | Date | null
}

function mapJobRow(row: SqliteJobRow): ImportJobRecord {
  return {
    id: row.id,
    userId: row.user_id,
    layerName: row.layer_name,
    layerSlug: row.layer_slug,
    fileType: row.file_type,
    sourceR2Key: row.source_r2_key,
    fileSizeBytes: Number(row.file_size_bytes),
    status: row.status,
    errorMessage: row.error_message,
    outputLayerId: row.output_layer_id,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    finishedAt: row.finished_at
      ? row.finished_at instanceof Date
        ? row.finished_at.toISOString()
        : String(row.finished_at)
      : null,
  }
}

export async function createImportJob(
  params: {
    id: string
    layerName: string
    layerSlug: string
    fileType: ImportFileType
    sourceR2Key: string
    fileSizeBytes: number
  },
  rls: RlsContext
): Promise<ImportJobRecord> {
  if (rls.role !== 'admin') {
    throw new Error('FORBIDDEN')
  }

  const nowIso = new Date().toISOString()

  if (config.DB_PROVIDER === 'sqlite') {
    getSqliteStmt<
      unknown,
      [string, string, string, string, string, string, number, string, string]
    >(
      `INSERT INTO import_jobs (
         id, user_id, layer_name, layer_slug, file_type, source_r2_key,
         file_size_bytes, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_upload', ?, ?)`
    ).run(
      params.id,
      rls.userId,
      params.layerName,
      params.layerSlug,
      params.fileType,
      params.sourceR2Key,
      params.fileSizeBytes,
      nowIso,
      nowIso
    )

    const row = getSqliteStmt<SqliteJobRow, [string]>(
      `SELECT * FROM import_jobs WHERE id = ? LIMIT 1`
    ).get(params.id)!
    return mapJobRow(row)
  }

  return withPgRls(rls, async (tx) => {
    const rows = await tx.unsafe(
      `INSERT INTO import_jobs (
         id, user_id, layer_name, layer_slug, file_type, source_r2_key, file_size_bytes, status
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'pending_upload')
       RETURNING *`,
      [
        params.id,
        rls.userId,
        params.layerName,
        params.layerSlug,
        params.fileType,
        params.sourceR2Key,
        params.fileSizeBytes,
      ]
    )
    return mapJobRow((rows as SqliteJobRow[])[0])
  })
}

export async function getImportJobById(
  id: string,
  rls: RlsContext
): Promise<ImportJobRecord | null> {
  if (rls.role !== 'admin') {
    throw new Error('FORBIDDEN')
  }

  if (config.DB_PROVIDER === 'sqlite') {
    const row = getSqliteStmt<SqliteJobRow, [string]>(
      `SELECT * FROM import_jobs WHERE id = ? LIMIT 1`
    ).get(id)
    return row ? mapJobRow(row) : null
  }

  return withPgRls(rls, async (tx) => {
    const rows = await tx.unsafe(`SELECT * FROM import_jobs WHERE id = $1::uuid LIMIT 1`, [id])
    return rows && rows.length > 0 ? mapJobRow(rows[0] as SqliteJobRow) : null
  })
}

export async function listImportJobs(
  rls: RlsContext,
  limit = 25
): Promise<ImportJobRecord[]> {
  if (rls.role !== 'admin') {
    throw new Error('FORBIDDEN')
  }
  const safeLimit = Math.max(1, Math.min(100, limit))

  if (config.DB_PROVIDER === 'sqlite') {
    const rows = getSqliteStmt<SqliteJobRow, [number]>(
      `SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT ?`
    ).all(safeLimit)
    return rows.map(mapJobRow)
  }

  return withPgRls(rls, async (tx) => {
    const rows = await tx.unsafe(
      `SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT $1`,
      [safeLimit]
    )
    return (rows as SqliteJobRow[]).map(mapJobRow)
  })
}

export async function updateImportJobStatus(
  id: string,
  status: ImportJobStatus,
  options: { errorMessage?: string | null; outputLayerId?: string | null } = {},
  rls: RlsContext = { userId: '00000000-0000-0000-0000-000000000000', role: 'admin' }
): Promise<ImportJobRecord | null> {
  const nowIso = new Date().toISOString()
  const isFinished = status === 'completed' || status === 'failed'

  if (config.DB_PROVIDER === 'sqlite') {
    getSqliteStmt<
      unknown,
      [string, string | null, string | null, string, string | null, string]
    >(
      `UPDATE import_jobs
       SET status = ?,
           error_message = ?,
           output_layer_id = COALESCE(?, output_layer_id),
           updated_at = ?,
           finished_at = ?
       WHERE id = ?`
    ).run(
      status,
      options.errorMessage ?? null,
      options.outputLayerId ?? null,
      nowIso,
      isFinished ? nowIso : null,
      id
    )

    const row = getSqliteStmt<SqliteJobRow, [string]>(
      `SELECT * FROM import_jobs WHERE id = ? LIMIT 1`
    ).get(id)
    return row ? mapJobRow(row) : null
  }

  return withPgRls(rls, async (tx) => {
    const rows = await tx.unsafe(
      `UPDATE import_jobs
       SET status = $2,
           error_message = $3,
           output_layer_id = COALESCE($4::uuid, output_layer_id),
           updated_at = NOW(),
           finished_at = CASE WHEN $5::boolean THEN NOW() ELSE finished_at END
       WHERE id = $1::uuid
       RETURNING *`,
      [
        id,
        status,
        options.errorMessage ?? null,
        options.outputLayerId ?? null,
        isFinished,
      ]
    )
    return rows && rows.length > 0 ? mapJobRow(rows[0] as SqliteJobRow) : null
  })
}

/**
 * Mengklaim satu job berstatus 'pending' (atau job 'processing' yang macet melewati batas staleThresholdMs)
 * secara atomik dalam O(log P).
 */
export async function claimNextPendingImportJob(
  staleThresholdMs = 10 * 60 * 1000
): Promise<ImportJobRecord | null> {
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const staleCutoffIso = new Date(nowMs - staleThresholdMs).toISOString()
  const systemAdminRls: RlsContext = {
    userId: '00000000-0000-0000-0000-000000000000',
    role: 'admin',
  }

  if (config.DB_PROVIDER === 'sqlite') {
    const db = getSqliteDb()
    let claimed: SqliteJobRow | null = null

    const tx = db.transaction(() => {
      const next = getSqliteStmt<SqliteJobRow, [string]>(
        `SELECT * FROM import_jobs
         WHERE status = 'pending'
            OR (status = 'processing' AND updated_at <= ?)
         ORDER BY created_at ASC
         LIMIT 1`
      ).get(staleCutoffIso)
      if (!next) return

      getSqliteStmt<unknown, [string, string]>(
        `UPDATE import_jobs SET status = 'processing', updated_at = ? WHERE id = ?`
      ).run(nowIso, next.id)

      claimed = getSqliteStmt<SqliteJobRow, [string]>(
        `SELECT * FROM import_jobs WHERE id = ? LIMIT 1`
      ).get(next.id)
    })

    tx()
    return claimed ? mapJobRow(claimed) : null
  }

  return withPgRls(systemAdminRls, async (tx) => {
    const rows = await tx.unsafe(
      `UPDATE import_jobs
       SET status = 'processing', updated_at = NOW()
       WHERE id = (
         SELECT id FROM import_jobs
         WHERE status = 'pending'
            OR (status = 'processing' AND updated_at <= $1::timestamptz)
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [staleCutoffIso]
    )
    return rows && rows.length > 0 ? mapJobRow(rows[0] as SqliteJobRow) : null
  })
}

/**
 * Menyimpan hasil ekstraksi Shapefile ke tabel spatial_layers + vector_features (+ R*Tree)
 * dalam satu transaksi atomik.
 */
export async function ingestConvertedVectorLayer(
  job: ImportJobRecord,
  dataset: ConvertedVectorDataset
): Promise<string> {
  const nowIso = new Date().toISOString()
  const layerId = crypto.randomUUID()
  const systemAdminRls: RlsContext = { userId: job.userId, role: 'admin' }

  if (config.DB_PROVIDER === 'sqlite') {
    const db = getSqliteDb()
    let finalLayerId: string = layerId

    const tx = db.transaction(() => {
      const existingLayer = getSqliteStmt<{ id: string }, [string]>(
        `SELECT id FROM spatial_layers WHERE slug = ? LIMIT 1`
      ).get(job.layerSlug)

      if (existingLayer) {
        finalLayerId = existingLayer.id
        getSqliteStmt<unknown, [string]>(
          `DELETE FROM vector_features_rtree
           WHERE id IN (SELECT id FROM vector_features WHERE layer_id = ?)`
        ).run(finalLayerId)
        getSqliteStmt<unknown, [string]>(
          `DELETE FROM vector_features WHERE layer_id = ?`
        ).run(finalLayerId)

        getSqliteStmt<unknown, [string, string, string, number, string, string]>(
          `UPDATE spatial_layers
           SET name = ?, geometry_type = ?, bbox = ?, feature_count = ?, updated_at = ?
           WHERE id = ?`
        ).run(
          job.layerName,
          dataset.geometryType,
          JSON.stringify(dataset.bbox),
          dataset.features.length,
          nowIso,
          finalLayerId
        )
      } else {
        getSqliteStmt<
          unknown,
          [string, string, string, string, string, number, string, string]
        >(
          `INSERT INTO spatial_layers (
             id, slug, name, description, layer_type, geometry_type,
             min_zoom, max_zoom, bbox, style_config, is_public, feature_count, updated_at, created_at
           ) VALUES (?, ?, ?, '', 'vector_mvt', ?, 0, 18, ?, '{}', 1, ?, ?, ?)`
        ).run(
          finalLayerId,
          job.layerSlug,
          job.layerName,
          dataset.geometryType,
          JSON.stringify(dataset.bbox),
          dataset.features.length,
          nowIso,
          nowIso
        )
      }

      const insFeat = getSqliteStmt<
        unknown,
        [string, string, string, number, number, number, number]
      >(
        `INSERT INTO vector_features (layer_id, properties, geojson, min_lng, min_lat, max_lng, max_lat)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      const insRtree = getSqliteStmt<unknown, [number, number, number, number, number]>(
        `INSERT INTO vector_features_rtree (id, min_lng, max_lng, min_lat, max_lat)
         VALUES (?, ?, ?, ?, ?)`
      )

      for (let i = 0; i < dataset.features.length; i++) {
        const feat = dataset.features[i]
        const [minLng, minLat, maxLng, maxLat] = computeGeoJsonBBox(feat.geometry)
        const res = insFeat.run(
          finalLayerId,
          JSON.stringify(feat.properties),
          JSON.stringify(feat.geometry),
          minLng,
          minLat,
          maxLng,
          maxLat
        )
        insRtree.run(Number(res.lastInsertRowid), minLng, maxLng, minLat, maxLat)
      }
    })

    tx()
    invalidateTileCacheForLayer(job.layerSlug)
    return finalLayerId
  }

  return withPgRls(systemAdminRls, async (tx) => {
    const layerRows = await tx.unsafe(
      `INSERT INTO spatial_layers (
         id, slug, name, layer_type, geometry_type, bbox, feature_count
       ) VALUES ($1::uuid, $2, $3, 'vector_mvt', $4, $5::jsonb, $6)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         geometry_type = EXCLUDED.geometry_type,
         bbox = EXCLUDED.bbox,
         feature_count = EXCLUDED.feature_count,
         updated_at = NOW()
       RETURNING id`,
      [
        layerId,
        job.layerSlug,
        job.layerName,
        dataset.geometryType,
        JSON.stringify(dataset.bbox),
        dataset.features.length,
      ]
    )
    const finalId = String((layerRows as { id: string }[])[0].id)
    await tx.unsafe(`DELETE FROM vector_features WHERE layer_id = $1::uuid`, [finalId])

    const propsArr: string[] = []
    const geomJsonArr: string[] = []
    for (let i = 0; i < dataset.features.length; i++) {
      propsArr.push(JSON.stringify(dataset.features[i].properties))
      geomJsonArr.push(JSON.stringify(dataset.features[i].geometry))
    }

    await tx.unsafe(
      `INSERT INTO vector_features (layer_id, properties, geom)
       SELECT
         $1::uuid,
         u.props::jsonb,
         ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(u.geom_json), 4326))
       FROM UNNEST($2::text[], $3::text[]) AS u(props, geom_json)`,
      [finalId, propsArr, geomJsonArr]
    )

    invalidateTileCacheForLayer(job.layerSlug)
    return finalId
  })
}

export async function registerRasterPmTilesLayer(
  job: ImportJobRecord,
  r2PmtilesKey: string
): Promise<string> {
  const nowIso = new Date().toISOString()
  const layerId = crypto.randomUUID()
  const systemAdminRls: RlsContext = { userId: job.userId, role: 'admin' }

  if (config.DB_PROVIDER === 'sqlite') {
    getSqliteStmt<
      unknown,
      [string, string, string, string, string, string]
    >(
      `INSERT INTO spatial_layers (
         id, slug, name, description, layer_type, geometry_type,
         r2_pmtiles_key, min_zoom, max_zoom, is_public, feature_count, updated_at, created_at
       ) VALUES (?, ?, ?, '', 'raster_pmtiles', 'Raster', ?, 0, 18, 1, 1, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         name = excluded.name,
         r2_pmtiles_key = excluded.r2_pmtiles_key,
         updated_at = excluded.updated_at`
    ).run(layerId, job.layerSlug, job.layerName, r2PmtilesKey, nowIso, nowIso)

    const row = getSqliteStmt<{ id: string }, [string]>(
      `SELECT id FROM spatial_layers WHERE slug = ? LIMIT 1`
    ).get(job.layerSlug)!
    return row.id
  }

  return withPgRls(systemAdminRls, async (tx) => {
    const rows = await tx.unsafe(
      `INSERT INTO spatial_layers (
         id, slug, name, layer_type, geometry_type, r2_pmtiles_key, feature_count
       ) VALUES ($1::uuid, $2, $3, 'raster_pmtiles', 'Raster', $4, 1)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         r2_pmtiles_key = EXCLUDED.r2_pmtiles_key,
         updated_at = NOW()
       RETURNING id`,
      [layerId, job.layerSlug, job.layerName, r2PmtilesKey]
    )
    return String((rows as { id: string }[])[0].id)
  })
}
