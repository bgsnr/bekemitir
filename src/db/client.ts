import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite'
import { SQL } from 'bun'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from '../config'
import type { UserRole } from '../lib/crypto'

export interface RlsContext {
  userId: string
  role: UserRole
}

export const ANON_RLS_CONTEXT: RlsContext = Object.freeze({
  userId: '00000000-0000-0000-0000-000000000000',
  role: 'anon',
})

export interface GeoJsonGeometry {
  type: 'Point' | 'MultiPoint' | 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon'
  coordinates: unknown
}

let sqliteInstance: Database | null = null
const sqliteStmtCache = new Map<string, Statement>()

let pgPoolInstance: SQL | null = null

/**
 * Mengambil koneksi singleton SQLite (bun:sqlite).
 */
export function getSqliteDb(): Database {
  if (sqliteInstance) return sqliteInstance

  const dbPath = config.SQLITE_PATH
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
  }

  sqliteInstance = new Database(dbPath, { create: true })
  sqliteInstance.exec('PRAGMA journal_mode = WAL;')
  sqliteInstance.exec('PRAGMA synchronous = NORMAL;')
  sqliteInstance.exec('PRAGMA foreign_keys = ON;')
  return sqliteInstance
}

/**
 * Mengambil Prepared Statement SQLite dari cache dalam O(1).
 * Mencegah overhead kompilasi ulang query SQL pada setiap HTTP request.
 */
export function getSqliteStmt<
  Row = unknown,
  Params extends SQLQueryBindings[] = SQLQueryBindings[]
>(sqlText: string): Statement<Row, Params> {
  const cached = sqliteStmtCache.get(sqlText)
  if (cached) {
    return cached as Statement<Row, Params>
  }
  const db = getSqliteDb()
  const stmt = db.query<Row, Params>(sqlText) as unknown as Statement<Row, Params>
  sqliteStmtCache.set(sqlText, stmt as unknown as Statement)
  return stmt
}

/**
 * Mereset instance SQLite dan statement cache (khusus untuk isolasi unit/integration test).
 */
export function resetSqliteForTests(customPath = ':memory:'): Database {
  sqliteStmtCache.clear()
  if (sqliteInstance) {
    try {
      sqliteInstance.close()
    } catch {
      // Abaikan jika sudah tertutup
    }
    sqliteInstance = null
  }
  sqliteInstance = new Database(customPath, { create: true })
  sqliteInstance.exec('PRAGMA foreign_keys = ON;')
  return sqliteInstance
}

/**
 * Mengambil connection pool PostgreSQL (Bun.SQL) dengan batas max_connections terjaga.
 */
export function getPgPool(): SQL {
  if (pgPoolInstance) return pgPoolInstance
  if (!config.DATABASE_URL) {
    throw new Error('DATABASE_URL belum dikonfigurasi untuk mode postgres.')
  }
  pgPoolInstance = new SQL(config.DATABASE_URL, {
    max: 20,
    idleTimeout: 30,
  })
  return pgPoolInstance
}

/**
 * Menjalankan fungsi query di dalam transaksi PostgreSQL dengan konteks Row Level Security (RLS)
 * yang di-set melalui parameterized query (SET LOCAL app.user_id & app.user_role).
 */
export async function withPgRls<T>(
  rls: RlsContext,
  fn: (tx: SQL) => Promise<T>
): Promise<T> {
  const pool = getPgPool()
  return pool.begin(async (tx) => {
    await tx.unsafe(
      `SELECT set_config('app.user_id', $1, true), set_config('app.user_role', $2, true)`,
      [rls.userId, rls.role]
    )
    return fn(tx)
  })
}

/**
 * Menghitung bounding box [minLng, minLat, maxLng, maxLat] dari geometri GeoJSON
 * dalam satu lintasan O(V) (V = jumlah verteks) tanpa alokasi array rekursif.
 */
export function computeGeoJsonBBox(
  geom: GeoJsonGeometry
): [number, number, number, number] {
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity

  // Stack iteratif O(depth) untuk menghindari call-stack overflow pada poligon besar
  const stack: unknown[] = [geom.coordinates]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!Array.isArray(current) || current.length === 0) continue

    if (typeof current[0] === 'number' && typeof current[1] === 'number') {
      const lng = current[0]
      const lat = current[1]
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    } else {
      for (let i = 0; i < current.length; i++) {
        stack.push(current[i])
      }
    }
  }

  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) {
    throw new Error('Geometri GeoJSON tidak memiliki koordinat valid.')
  }

  return [minLng, minLat, maxLng, maxLat]
}
