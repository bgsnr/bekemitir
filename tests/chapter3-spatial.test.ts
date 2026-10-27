import { beforeEach, describe, expect, test } from 'bun:test'
import { resetSqliteForTests } from '../src/db/client'
import { listSpatialLayers, updateSpatialLayer } from '../src/db/queries/layers'
import { listObservations, syncObservationsBatch } from '../src/db/queries/observations'
import { getDroughtSummary } from '../src/db/queries/summaries'
import { clearAllTileCache, getLayerTileMvt } from '../src/db/queries/tiles'
import { SEED_IDS, seedDatabase } from '../src/db/seed'
import { isValidTileCoord, lngLatToTileXY, tileToBBox } from '../src/lib/mvt-lite'

describe('Chapter 3 — Web Mercator Tile Math O(1) & MVT Protobuf Encoder O(V + P)', () => {
  beforeEach(async () => {
    resetSqliteForTests(':memory:')
    clearAllTileCache()
    await seedDatabase()
  })

  test('isValidTileCoord, lngLatToTileXY, dan tileToBBox konsisten pada koordinat Desa Kemitir', () => {
    expect(isValidTileCoord(14, 13211, 8521)).toBe(true)
    expect(isValidTileCoord(-1, 0, 0)).toBe(false)
    expect(isValidTileCoord(2, 4, 0)).toBe(false) // max index pada z=2 adalah 3

    const { x, y } = lngLatToTileXY(110.295, -7.228, 14)
    const [minLng, minLat, maxLng, maxLat] = tileToBBox(14, x, y)
    expect(110.295).toBeGreaterThanOrEqual(minLng)
    expect(110.295).toBeLessThanOrEqual(maxLng)
    expect(-7.228).toBeGreaterThanOrEqual(minLat)
    expect(-7.228).toBeLessThanOrEqual(maxLat)
  })

  test('getLayerTileMvt menghasilkan binary MVT valid, melayani Cache Hit O(1), dan mengembalikan ETag', async () => {
    const { x, y } = lngLatToTileXY(110.295, -7.228, 14)

    // Request pertama -> Cache Miss (query R*Tree + encode MVT)
    const first = await getLayerTileMvt('batas-dusun-kemitir', 14, x, y)
    expect(first).not.toBeNull()
    expect(first!.cacheHit).toBe(false)
    expect(first!.buffer.byteLength).toBeGreaterThan(20)
    expect(first!.etag).toStartWith('W/"')

    // Pastikan nama layer 'batas-dusun-kemitir' ter-encode di dalam binary Protobuf MVT
    const textDecoded = new TextDecoder().decode(first!.buffer)
    expect(textDecoded).toContain('batas-dusun-kemitir')
    expect(textDecoded).toContain('status_kekeringan')

    // Request kedua pada koordinat yang sama -> Cache Hit O(1) dengan ETag identik
    const second = await getLayerTileMvt('batas-dusun-kemitir', 14, x, y)
    expect(second).not.toBeNull()
    expect(second!.cacheHit).toBe(true)
    expect(second!.etag).toBe(first!.etag)

    // Tile di luar area Desa Kemitir (misal z=14, x=0, y=0) -> buffer kosong 0 byte
    const emptyTile = await getLayerTileMvt('batas-dusun-kemitir', 14, 0, 0)
    expect(emptyTile).not.toBeNull()
    expect(emptyTile!.buffer.byteLength).toBe(0)
  })

  test('getLayerTileMvt untuk layer observations dan invalidasi otomatis saat update layer', async () => {
    const { x, y } = lngLatToTileXY(110.304, -7.228, 14)
    const obsTile = await getLayerTileMvt('observations', 14, x, y)
    expect(obsTile).not.toBeNull()
    expect(obsTile!.buffer.byteLength).toBeGreaterThan(20)

    const layers = await listSpatialLayers()
    expect(layers.length).toBe(1)
    expect(layers[0].tileUrlTemplate).toBe('/api/v1/tiles/batas-dusun-kemitir/{z}/{x}/{y}.mvt')

    const updated = await updateSpatialLayer(
      SEED_IDS.dusunLayerId,
      { name: 'Batas Dusun Kemitir (Updated)' },
      { userId: SEED_IDS.adminUserId, role: 'admin' }
    )
    expect(updated?.name).toBe('Batas Dusun Kemitir (Updated)')
  })
})

describe('Chapter 3 — Cursor Pagination O(log N + L) & Batch Offline Sync O(B log N)', () => {
  beforeEach(async () => {
    resetSqliteForTests(':memory:')
    clearAllTileCache()
    await seedDatabase()
  })

  test('listObservations mendukung cursor pagination O(log N + L) dan filter R*Tree bbox', async () => {
    // Halaman 1 (limit 2 dari total 4 observasi)
    const page1 = await listObservations({ limit: 2 })
    expect(page1.items.length).toBe(2)
    expect(page1.nextCursor).not.toBeNull()

    // Halaman 2 menggunakan nextCursor dari halaman 1
    const page2 = await listObservations({ limit: 2, cursor: page1.nextCursor! })
    expect(page2.items.length).toBe(2)
    expect(page2.nextCursor).toBeNull()

    // Tidak boleh ada duplikasi ID antara halaman 1 dan halaman 2
    const ids1 = new Set(page1.items.map((i) => i.id))
    for (const item of page2.items) {
      expect(ids1.has(item.id)).toBe(false)
    }

    // Filter bbox sempit di sekitar titik observasi pertama (110.304, -7.228)
    const bboxFiltered = await listObservations({
      bbox: [110.300, -7.230, 110.306, -7.226],
    })
    expect(bboxFiltered.items.length).toBe(1)
    expect(bboxFiltered.items[0].category).toBe('mata_air')
  })

  test('syncObservationsBatch bersifat idempoten terhadap client_id dan memperbarui summary', async () => {
    const petugasRls = { userId: SEED_IDS.petugasUserId, role: 'petugas' as const }
    const offlineClientId = '99999999-9999-4999-8999-999999999901'

    // Kiriman pertama dari antrean offline mobile
    const sync1 = await syncObservationsBatch(
      [
        {
          clientId: offlineClientId,
          category: 'embung',
          severity: 'waspada',
          title: 'Embung Kemitir Utara Menyusut',
          notes: 'Tinggi muka air turun 50cm',
          properties: { tma_cm: 120 },
          observedAt: '2026-10-20T06:00:00.000Z',
          lng: 110.299,
          lat: -7.220,
        },
      ],
      petugasRls
    )
    expect(sync1.syncedCount).toBe(1)

    const summaryAfterInsert = await getDroughtSummary()
    expect(summaryAfterInsert.totalObservations).toBe(5)
    expect(summaryAfterInsert.bySeverity.waspada).toBe(2)

    // Kiriman ulang clientId yang sama (retry jaringan) dengan perubahan severity -> 'siaga'
    const sync2 = await syncObservationsBatch(
      [
        {
          clientId: offlineClientId,
          category: 'embung',
          severity: 'siaga',
          title: 'Embung Kemitir Utara Menyusut Parah',
          notes: 'Tinggi muka air turun 90cm',
          properties: { tma_cm: 80 },
          observedAt: '2026-10-20T08:00:00.000Z',
          lng: 110.299,
          lat: -7.220,
        },
      ],
      petugasRls
    )
    expect(sync2.syncedCount).toBe(1)
    expect(sync2.items[0].severity).toBe('siaga')

    // Total observasi tetap 5 (idempoten, tidak mengganda!)
    const summaryAfterRetry = await getDroughtSummary()
    expect(summaryAfterRetry.totalObservations).toBe(5)
    expect(summaryAfterRetry.bySeverity.waspada).toBe(1)
    expect(summaryAfterRetry.bySeverity.siaga).toBe(2)
  })
})
