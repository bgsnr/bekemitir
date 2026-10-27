import type { SQLQueryBindings } from 'bun:sqlite'
import { config } from '../../config'
import type { BoundingBox } from '../../lib/mvt-lite'
import {
  ANON_RLS_CONTEXT,
  getSqliteDb,
  getSqliteStmt,
  withPgRls,
  type RlsContext,
} from '../client'
import { bumpObservationsTileVersion } from './tiles'

export type DroughtSeverity = 'normal' | 'waspada' | 'siaga' | 'awas'

export interface FieldObservationRecord {
  id: string
  clientId: string
  userId: string | null
  category: string
  severity: DroughtSeverity
  title: string
  notes: string
  properties: Record<string, unknown>
  photoR2Key: string | null
  observedAt: string
  createdAt: string
  updatedAt: string
  lng: number
  lat: number
}

export interface ListObservationsFilter {
  limit?: number
  cursor?: string
  severity?: DroughtSeverity
  bbox?: BoundingBox
  updatedSince?: string
}

export interface SyncObservationInput {
  clientId: string
  category: string
  severity: DroughtSeverity
  title: string
  notes?: string
  properties?: Record<string, unknown>
  photoR2Key?: string | null
  observedAt: string
  lng: number
  lat: number
}

export function encodeObservationCursor(observedAt: string, id: string): string {
  return Buffer.from(`${observedAt}|${id}`).toString('base64url')
}

export function decodeObservationCursor(
  cursor: string
): { observedAt: string; id: string } | null {
  if (!cursor || cursor.length > 256) return null
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    const sepIdx = decoded.indexOf('|')
    if (sepIdx <= 0 || sepIdx === decoded.length - 1) return null
    const observedAt = decoded.slice(0, sepIdx)
    const id = decoded.slice(sepIdx + 1)
    if (Number.isNaN(Date.parse(observedAt))) return null
    return { observedAt, id }
  } catch {
    return null
  }
}

interface SqliteObsRow {
  id: string
  client_id: string
  user_id: string
  category: string
  severity: DroughtSeverity
  title: string
  notes: string
  properties: string | Record<string, unknown>
  photo_r2_key: string | null
  observed_at: string | Date
  created_at: string | Date
  updated_at: string | Date
  lng: number
  lat: number
}

function mapObsRow(row: SqliteObsRow, hideUserId = false): FieldObservationRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    userId: hideUserId ? null : row.user_id,
    category: row.category,
    severity: row.severity,
    title: row.title,
    notes: row.notes,
    properties:
      typeof row.properties === 'string'
        ? (JSON.parse(row.properties) as Record<string, unknown>)
        : row.properties,
    photoR2Key: row.photo_r2_key,
    observedAt:
      row.observed_at instanceof Date ? row.observed_at.toISOString() : String(row.observed_at),
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    lng: Number(row.lng),
    lat: Number(row.lat),
  }
}

/**
 * Mengambil daftar observasi lapangan dengan Keyset/Cursor Pagination O(log N + L)
 * dan pemfilteran spasial 2D R*Tree (dengan post-filter presisi 64-bit) / GiST O(log N + M).
 */
export async function listObservations(
  filter: ListObservationsFilter = {},
  rls: RlsContext = ANON_RLS_CONTEXT
): Promise<{ items: FieldObservationRecord[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(100, filter.limit ?? 25))
  const fetchLimit = limit + 1 // Ambil 1 ekstra untuk deteksi halaman berikutnya tanpa COUNT(*) O(N)
  const parsedCursor = filter.cursor ? decodeObservationCursor(filter.cursor) : null
  const hideUserId = rls.role === 'anon'

  if (config.DB_PROVIDER === 'sqlite') {
    const conditions: string[] = []
    const params: SQLQueryBindings[] = []
    let joinRtree = ''

    if (filter.bbox) {
      const [minLng, minLat, maxLng, maxLat] = filter.bbox
      joinRtree = 'INNER JOIN field_observations_rtree rt ON fo.rowid_id = rt.rowid_id'
      // R*Tree SQLite menggunakan float 32-bit; tambahkan post-filter REAL 64-bit untuk akurasi tepi
      conditions.push(
        'rt.max_lng >= ? AND rt.min_lng <= ? AND rt.max_lat >= ? AND rt.min_lat <= ? AND fo.lng BETWEEN ? AND ? AND fo.lat BETWEEN ? AND ?'
      )
      params.push(minLng, maxLng, minLat, maxLat, minLng, maxLng, minLat, maxLat)
    }

    if (filter.severity) {
      conditions.push('fo.severity = ?')
      params.push(filter.severity)
    }

    if (filter.updatedSince) {
      conditions.push('fo.updated_at >= ?')
      params.push(filter.updatedSince)
    }

    if (parsedCursor) {
      conditions.push('(fo.observed_at < ? OR (fo.observed_at = ? AND fo.id < ?))')
      params.push(parsedCursor.observedAt, parsedCursor.observedAt, parsedCursor.id)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const sql = `
      SELECT fo.id, fo.client_id, fo.user_id, fo.category, fo.severity, fo.title, fo.notes,
             fo.properties, fo.photo_r2_key, fo.observed_at, fo.created_at, fo.updated_at,
             fo.lng, fo.lat
      FROM field_observations fo
      ${joinRtree}
      ${whereClause}
      ORDER BY fo.observed_at DESC, fo.id DESC
      LIMIT ?
    `
    params.push(fetchLimit)

    const rows = getSqliteStmt<SqliteObsRow, SQLQueryBindings[]>(sql).all(...params)
    const hasMore = rows.length > limit
    const slice = hasMore ? rows.slice(0, limit) : rows
    const items = slice.map((r) => mapObsRow(r, hideUserId))
    const last = items[items.length - 1]
    const nextCursor = hasMore && last ? encodeObservationCursor(last.observedAt, last.id) : null

    return { items, nextCursor }
  }

  return withPgRls(rls, async (tx) => {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter.bbox) {
      const [minLng, minLat, maxLng, maxLat] = filter.bbox
      const p1 = params.push(minLng)
      const p2 = params.push(minLat)
      const p3 = params.push(maxLng)
      const p4 = params.push(maxLat)
      conditions.push(`fo.geom && ST_MakeEnvelope($${p1}, $${p2}, $${p3}, $${p4}, 4326)`)
    }

    if (filter.severity) {
      const idx = params.push(filter.severity)
      conditions.push(`fo.severity = $${idx}`)
    }

    if (filter.updatedSince) {
      const idx = params.push(filter.updatedSince)
      conditions.push(`fo.updated_at >= $${idx}::timestamptz`)
    }

    if (parsedCursor) {
      const pTime = params.push(parsedCursor.observedAt)
      const pId = params.push(parsedCursor.id)
      conditions.push(`(fo.observed_at, fo.id) < ($${pTime}::timestamptz, $${pId}::uuid)`)
    }

    const pLimit = params.push(fetchLimit)
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = await tx.unsafe(
      `SELECT fo.id, fo.client_id, fo.user_id, fo.category, fo.severity, fo.title, fo.notes,
              fo.properties, fo.photo_r2_key, fo.observed_at, fo.created_at, fo.updated_at,
              ST_X(fo.geom) AS lng, ST_Y(fo.geom) AS lat
       FROM field_observations fo
       ${whereClause}
       ORDER BY fo.observed_at DESC, fo.id DESC
       LIMIT $${pLimit}`,
      params
    )

    const typedRows = rows as SqliteObsRow[]
    const hasMore = typedRows.length > limit
    const slice = hasMore ? typedRows.slice(0, limit) : typedRows
    const items = slice.map((r) => mapObsRow(r, hideUserId))
    const last = items[items.length - 1]
    const nextCursor = hasMore && last ? encodeObservationCursor(last.observedAt, last.id) : null

    return { items, nextCursor }
  })
}

/**
 * Normalisasi timestamp observedAt agar jam HP yang salah stel ke masa depan (> now + 5 menit)
 * atau masa silam ekstrem (< 2020-01-01) tidak merusak urutan waktu dan latestObservedAt.
 */
export function normalizeObservedAtTimestamp(rawIso: string, nowMs = Date.now()): string {
  const parsedMs = Date.parse(rawIso)
  if (Number.isNaN(parsedMs)) {
    return new Date(nowMs).toISOString()
  }
  const maxAllowedMs = nowMs + 5 * 60 * 1000 // Toleransi drift jam 5 menit
  const minAllowedMs = 1577836800000 // 2020-01-01T00:00:00.000Z
  if (parsedMs > maxAllowedMs) {
    return new Date(nowMs).toISOString()
  }
  if (parsedMs < minAllowedMs) {
    return new Date(minAllowedMs).toISOString()
  }
  return new Date(parsedMs).toISOString()
}

/**
 * Deduplikasi array SyncObservationInput berdasarkan clientId dalam waktu O(B).
 * Jika ada clientId kembar di dalam satu batch, simpan yang memiliki observedAt paling baru.
 * Mencegah error PostgreSQL "ON CONFLICT DO UPDATE command cannot affect row a second time".
 */
export function deduplicateSyncBatchByClientId(
  items: readonly SyncObservationInput[],
  nowMs = Date.now()
): SyncObservationInput[] {
  const byClientId = new Map<string, SyncObservationInput>()

  for (let i = 0; i < items.length; i++) {
    const raw = items[i]
    const normalizedObservedAt = normalizeObservedAtTimestamp(raw.observedAt, nowMs)
    const candidate: SyncObservationInput = {
      ...raw,
      category: raw.category.trim().toLowerCase(),
      observedAt: normalizedObservedAt,
    }

    const existing = byClientId.get(candidate.clientId)
    if (!existing || candidate.observedAt >= existing.observedAt) {
      byClientId.set(candidate.clientId, candidate)
    }
  }

  return Array.from(byClientId.values())
}

/**
 * Sinkronisasi batch observasi lapangan secara idempoten dalam satu transaksi O(B log N).
 * - Deduplikasi client_id kembar di dalam 1 batch dalam O(B).
 * - Menolak pengambilalihan client_id milik user lain.
 * - Mencegah paket lama yang terlambat menimpa data yang lebih baru (observed_at guard).
 */
export async function syncObservationsBatch(
  rawItems: readonly SyncObservationInput[],
  rls: RlsContext
): Promise<{ syncedCount: number; items: FieldObservationRecord[] }> {
  if (rls.role !== 'petugas' && rls.role !== 'admin') {
    throw new Error('FORBIDDEN')
  }
  if (rawItems.length === 0) {
    return { syncedCount: 0, items: [] }
  }
  if (rawItems.length > 100) {
    throw new Error('BATCH_TOO_LARGE')
  }

  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const items = deduplicateSyncBatchByClientId(rawItems, nowMs)

  if (config.DB_PROVIDER === 'sqlite') {
    const db = getSqliteDb()
    const upsertStmt = getSqliteStmt<
      SqliteObsRow & { rowid_id: number },
      [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        string,
        string,
        string,
        number,
        number,
        string,
        string,
      ]
    >(
      `INSERT INTO field_observations (
         id, client_id, user_id, category, severity, title, notes, properties,
         photo_r2_key, observed_at, created_at, updated_at, lng, lat
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET
         category = CASE WHEN excluded.observed_at >= field_observations.observed_at THEN excluded.category ELSE field_observations.category END,
         severity = CASE WHEN excluded.observed_at >= field_observations.observed_at THEN excluded.severity ELSE field_observations.severity END,
         title = CASE WHEN excluded.observed_at >= field_observations.observed_at THEN excluded.title ELSE field_observations.title END,
         notes = CASE WHEN excluded.observed_at >= field_observations.observed_at THEN excluded.notes ELSE field_observations.notes END,
         properties = CASE WHEN excluded.observed_at >= field_observations.observed_at THEN excluded.properties ELSE field_observations.properties END,
         photo_r2_key = COALESCE(excluded.photo_r2_key, field_observations.photo_r2_key),
         observed_at = CASE WHEN excluded.observed_at >= field_observations.observed_at THEN excluded.observed_at ELSE field_observations.observed_at END,
         updated_at = CASE WHEN excluded.observed_at >= field_observations.observed_at THEN excluded.updated_at ELSE field_observations.updated_at END,
         lng = CASE WHEN excluded.observed_at >= field_observations.observed_at THEN excluded.lng ELSE field_observations.lng END,
         lat = CASE WHEN excluded.observed_at >= field_observations.observed_at THEN excluded.lat ELSE field_observations.lat END
       WHERE (field_observations.user_id = ? OR ? = 'admin')
       RETURNING rowid_id, id, client_id, user_id, category, severity, title, notes,
                 properties, photo_r2_key, observed_at, created_at, updated_at, lng, lat`
    )

    const rtreeStmt = getSqliteStmt<unknown, [number, number, number, number, number]>(
      `INSERT OR REPLACE INTO field_observations_rtree (rowid_id, min_lng, max_lng, min_lat, max_lat)
       VALUES (?, ?, ?, ?, ?)`
    )

    const syncedRecords: FieldObservationRecord[] = []

    const tx = db.transaction(() => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const row = upsertStmt.get(
          crypto.randomUUID(),
          item.clientId,
          rls.userId,
          item.category,
          item.severity,
          item.title,
          item.notes ?? '',
          JSON.stringify(item.properties ?? {}),
          item.photoR2Key ?? null,
          item.observedAt,
          nowIso,
          nowIso,
          item.lng,
          item.lat,
          rls.userId,
          rls.role
        )
        if (row) {
          const authLng = Number(row.lng)
          const authLat = Number(row.lat)
          rtreeStmt.run(row.rowid_id, authLng, authLng, authLat, authLat)
          syncedRecords.push(mapObsRow(row, false))
        }
      }
    })

    tx()
    bumpObservationsTileVersion()
    return { syncedCount: syncedRecords.length, items: syncedRecords }
  }

  // Mode PostgreSQL: Set-based UNNEST query dalam 1 round-trip
  const result = await withPgRls(rls, async (tx) => {
    const clientIds: string[] = []
    const categories: string[] = []
    const severities: string[] = []
    const titles: string[] = []
    const notesArr: string[] = []
    const propsArr: string[] = []
    const photoKeys: (string | null)[] = []
    const observedAts: string[] = []
    const lngs: number[] = []
    const lats: number[] = []

    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      clientIds.push(it.clientId)
      categories.push(it.category)
      severities.push(it.severity)
      titles.push(it.title)
      notesArr.push(it.notes ?? '')
      propsArr.push(JSON.stringify(it.properties ?? {}))
      photoKeys.push(it.photoR2Key ?? null)
      observedAts.push(it.observedAt)
      lngs.push(it.lng)
      lats.push(it.lat)
    }

    const rows = await tx.unsafe(
      `INSERT INTO field_observations (
         client_id, user_id, category, severity, title, notes, properties, photo_r2_key, observed_at, geom
       )
       SELECT
         u.client_id,
         $1::uuid,
         u.category,
         u.severity,
         u.title,
         u.notes,
         u.properties::jsonb,
         u.photo_r2_key,
         u.observed_at::timestamptz,
         ST_SetSRID(ST_MakePoint(u.lng, u.lat), 4326)
       FROM UNNEST(
         $2::uuid[],
         $3::text[],
         $4::text[],
         $5::text[],
         $6::text[],
         $7::text[],
         $8::text[],
         $9::text[],
         $10::float8[],
         $11::float8[]
       ) AS u(client_id, category, severity, title, notes, properties, photo_r2_key, observed_at, lng, lat)
       ON CONFLICT (client_id) DO UPDATE SET
         category = CASE WHEN EXCLUDED.observed_at >= field_observations.observed_at THEN EXCLUDED.category ELSE field_observations.category END,
         severity = CASE WHEN EXCLUDED.observed_at >= field_observations.observed_at THEN EXCLUDED.severity ELSE field_observations.severity END,
         title = CASE WHEN EXCLUDED.observed_at >= field_observations.observed_at THEN EXCLUDED.title ELSE field_observations.title END,
         notes = CASE WHEN EXCLUDED.observed_at >= field_observations.observed_at THEN EXCLUDED.notes ELSE field_observations.notes END,
         properties = CASE WHEN EXCLUDED.observed_at >= field_observations.observed_at THEN EXCLUDED.properties ELSE field_observations.properties END,
         photo_r2_key = COALESCE(EXCLUDED.photo_r2_key, field_observations.photo_r2_key),
         observed_at = CASE WHEN EXCLUDED.observed_at >= field_observations.observed_at THEN EXCLUDED.observed_at ELSE field_observations.observed_at END,
         updated_at = CASE WHEN EXCLUDED.observed_at >= field_observations.observed_at THEN NOW() ELSE field_observations.updated_at END,
         geom = CASE WHEN EXCLUDED.observed_at >= field_observations.observed_at THEN EXCLUDED.geom ELSE field_observations.geom END
       WHERE (field_observations.user_id = $1::uuid OR $12 = 'admin')
       RETURNING id, client_id, user_id, category, severity, title, notes,
                 properties, photo_r2_key, observed_at, created_at, updated_at,
                 ST_X(geom) AS lng, ST_Y(geom) AS lat`,
      [
        rls.userId,
        clientIds,
        categories,
        severities,
        titles,
        notesArr,
        propsArr,
        photoKeys,
        observedAts,
        lngs,
        lats,
        rls.role,
      ]
    )

    await tx.unsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_drought_summaries`)
    const mapped = (rows as SqliteObsRow[]).map((r) => mapObsRow(r, false))
    return { syncedCount: mapped.length, items: mapped }
  })

  bumpObservationsTileVersion()
  return result
}
