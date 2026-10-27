import { beforeEach, describe, expect, test } from 'bun:test'
import {
  computeGeoJsonBBox,
  getSqliteDb,
  getSqliteStmt,
  resetSqliteForTests,
} from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { SEED_IDS, seedDatabase } from '../src/db/seed'

describe('Chapter 2 — Iterative BBox O(V) & Prepared Statement Cache O(1)', () => {
  beforeEach(async () => {
    resetSqliteForTests(':memory:')
    await runMigrations()
  })

  test('computeGeoJsonBBox menghitung bbox secara iteratif O(V) untuk Point dan MultiPolygon', () => {
    const pointBBox = computeGeoJsonBBox({
      type: 'Point',
      coordinates: [110.301, -7.225],
    })
    expect(pointBBox).toEqual([110.301, -7.225, 110.301, -7.225])

    const multiPolyBBox = computeGeoJsonBBox({
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [110.28, -7.24],
            [110.30, -7.24],
            [110.30, -7.22],
            [110.28, -7.22],
            [110.28, -7.24],
          ],
        ],
        [
          [
            [110.31, -7.21],
            [110.35, -7.21],
            [110.35, -7.19],
            [110.31, -7.19],
            [110.31, -7.21],
          ],
        ],
      ],
    })
    expect(multiPolyBBox).toEqual([110.28, -7.24, 110.35, -7.19])
  })

  test('getSqliteStmt mengembalikan instance Statement yang sama dari cache dalam O(1)', () => {
    const sql = 'SELECT id, email, role FROM users WHERE email = ?'
    const stmt1 = getSqliteStmt(sql)
    const stmt2 = getSqliteStmt(sql)
    expect(stmt1).toBe(stmt2)
  })
})

describe('Chapter 2 — Seeding Idempotensi & R*Tree Spatial Index O(log N + M)', () => {
  beforeEach(() => {
    resetSqliteForTests(':memory:')
  })

  test('seedDatabase mengisi data Desa Kemitir secara idempoten tanpa duplikasi', async () => {
    await seedDatabase()
    // Panggil kedua kali untuk membuktikan idempotensi
    await seedDatabase()

    const db = getSqliteDb()
    const userCount = db.query<{ cnt: number }, []>('SELECT COUNT(*) AS cnt FROM users').get()
    const layerCount = db
      .query<{ cnt: number }, []>('SELECT COUNT(*) AS cnt FROM spatial_layers')
      .get()
    const featureCount = db
      .query<{ cnt: number }, []>('SELECT COUNT(*) AS cnt FROM vector_features')
      .get()
    const obsCount = db
      .query<{ cnt: number }, []>('SELECT COUNT(*) AS cnt FROM field_observations')
      .get()

    expect(userCount?.cnt).toBe(2)
    expect(layerCount?.cnt).toBe(1)
    expect(featureCount?.cnt).toBe(3)
    expect(obsCount?.cnt).toBe(4)
  })

  test('pencarian spasial menggunakan R*Tree Virtual Table Index O(log N + M), bukan full table scan', async () => {
    await seedDatabase()

    const spatialSql = `
      SELECT vf.id, vf.properties
      FROM vector_features vf
      INNER JOIN vector_features_rtree rt ON vf.id = rt.id
      WHERE vf.layer_id = ?
        AND rt.max_lng >= ? AND rt.min_lng <= ?
        AND rt.max_lat >= ? AND rt.min_lat <= ?
    `

    const db = getSqliteDb()
    const planRows = db
      .query<{ detail: string }, [string, number, number, number, number]>(
        `EXPLAIN QUERY PLAN ${spatialSql}`
      )
      .all(SEED_IDS.dusunLayerId, 110.286, 110.290, -7.234, -7.228)

    const planText = planRows.map((r) => r.detail).join(' | ')
    // Pastikan query planner SQLite menggunakan VIRTUAL TABLE INDEX dari R*Tree
    expect(planText).toContain('VIRTUAL TABLE INDEX')

    // Hanya Dusun Krajan Kemitir (KMT-01: 110.285..110.298, -7.235..-7.222) yang berpotongan dengan bbox sempit ini
    const stmt = getSqliteStmt<{ id: number; properties: string }, [string, number, number, number, number]>(
      spatialSql
    )
    const matched = stmt.all(SEED_IDS.dusunLayerId, 110.286, 110.290, -7.234, -7.228)
    expect(matched.length).toBe(1)
    const props = JSON.parse(matched[0].properties) as { kode_dusun: string }
    expect(props.kode_dusun).toBe('KMT-01')
  })
})
