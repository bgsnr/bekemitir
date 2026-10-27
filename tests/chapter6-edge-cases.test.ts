import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSqliteStmt, resetSqliteForTests } from '../src/db/client'
import { claimNextPendingImportJob, createImportJob } from '../src/db/queries/imports'
import { clearAllTileCache } from '../src/db/queries/tiles'
import { seedDatabase } from '../src/db/seed'
import { app } from '../src/index'
import { extractVerifiedZipToDir } from '../src/lib/gdal'
import { validateShapefileZipTail } from '../src/lib/zip-guard'
import { clearRateLimitBucketsForTests } from '../src/middleware/rate-limit'

function buildTestZipBuffer(
  entries: ReadonlyArray<{ name: string; data: Uint8Array }>
): Uint8Array {
  const encoder = new TextEncoder()
  const localParts: Uint8Array[] = []
  const cdParts: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const size = entry.data.byteLength

    const localHeader = new Uint8Array(30 + nameBytes.byteLength)
    const lv = new DataView(localHeader.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, 0, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, nameBytes.byteLength, true)
    localHeader.set(nameBytes, 30)

    const cdHeader = new Uint8Array(46 + nameBytes.byteLength)
    const cv = new DataView(cdHeader.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, 0, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, nameBytes.byteLength, true)
    cv.setUint32(42, offset, true)
    cdHeader.set(nameBytes, 46)

    localParts.push(localHeader, entry.data)
    cdParts.push(cdHeader)
    offset += localHeader.byteLength + entry.data.byteLength
  }

  const cdStartOffset = offset
  let cdTotalBytes = 0
  for (const p of cdParts) cdTotalBytes += p.byteLength

  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdTotalBytes, true)
  ev.setUint32(16, cdStartOffset, true)
  ev.setUint16(20, 0, true)

  const out = new Uint8Array(cdStartOffset + cdTotalBytes + 22)
  let pos = 0
  for (const p of localParts) {
    out.set(p, pos)
    pos += p.byteLength
  }
  for (const p of cdParts) {
    out.set(p, pos)
    pos += p.byteLength
  }
  out.set(eocd, pos)
  return out
}

describe('Chapter 6 — Edge-Case Hardening & Resilience Verification', () => {
  beforeEach(async () => {
    resetSqliteForTests(':memory:')
    clearAllTileCache()
    clearRateLimitBucketsForTests()
    await seedDatabase()
  })

  test('1. Poison Pill Isolation, Duplicate clientId, Out-of-Order Guard, Clock Clamping, Null Island (0,0), & photoR2Key Ownership', async () => {
    const loginRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'petugas@kemitir.id',
        password: 'PetugasKemitir2026!',
        clientType: 'mobile',
      }),
    })
    const {
      accessToken,
      user: { id: petugasId },
    } = ((await loginRes.json()) as {
      data: { accessToken: string; user: { id: string } }
    }).data

    const dupClientId = '88888888-8888-4888-8888-888888888801'
    const futureClientId = '88888888-8888-4888-8888-888888888802'
    const futureDateIso = new Date(Date.now() + 24 * 3600 * 1000).toISOString() // +24 jam (jam HP ngaco)

    // Kirim 1 batch berisi:
    // [0] Item valid (versi awal dupClientId, observedAt 10:00)
    // [1] Item valid dengan clientId SAMA di satu batch (versi baru dupClientId, observedAt 11:00)
    // [2] Item dengan jam HP masa depan (+24 jam) -> harus di-clamp ke waktu server
    // [3] Poison pill: koordinat Null Island (0, 0) -> harus masuk rejected[]
    // [4] Poison pill: photoR2Key milik user lain -> harus masuk rejected[]
    // [5] Poison pill: severity tidak valid -> harus masuk rejected[]
    const syncRes = await app.request('/api/v1/observations/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        items: [
          {
            clientId: dupClientId,
            category: 'sumur_warga',
            severity: 'waspada',
            title: 'Versi Lama 10:00',
            observedAt: '2026-10-19T10:00:00.000Z',
            lng: 110.295,
            lat: -7.225,
          },
          {
            clientId: dupClientId,
            category: 'sumur_warga',
            severity: 'siaga',
            title: 'Versi Baru 11:00 (Deduplikasi Batch)',
            photoR2Key: `photos/${petugasId}/77777777-7777-4777-8777-777777777777.jpg`,
            observedAt: '2026-10-19T11:00:00.000Z',
            lng: 110.295,
            lat: -7.225,
          },
          {
            clientId: futureClientId,
            category: 'mata_air',
            severity: 'awas',
            title: 'Observasi Jam HP Maju 24 Jam',
            observedAt: futureDateIso,
            lng: 110.301,
            lat: -7.221,
          },
          {
            clientId: '88888888-8888-4888-8888-888888888803',
            category: 'embung',
            severity: 'normal',
            title: 'GPS Belum Lock (0,0)',
            observedAt: '2026-10-19T10:00:00.000Z',
            lng: 0,
            lat: 0,
          },
          {
            clientId: '88888888-8888-4888-8888-888888888804',
            category: 'sumur_warga',
            severity: 'awas',
            title: 'Coba Pakai Foto User Lain',
            photoR2Key: 'photos/99999999-9999-4999-8999-999999999999/2026-10-19/curian.jpg',
            observedAt: '2026-10-19T10:00:00.000Z',
            lng: 110.296,
            lat: -7.226,
          },
          {
            clientId: '88888888-8888-4888-8888-888888888805',
            category: 'sumur_warga',
            severity: 'bencana_super_ekstrem',
            title: 'Severity Rusak',
            observedAt: '2026-10-19T10:00:00.000Z',
            lng: 110.296,
            lat: -7.226,
          },
        ],
      }),
    })

    expect(syncRes.status).toBe(200)
    const syncBody = (await syncRes.json()) as {
      data: {
        syncedCount: number
        items: Array<{ clientId: string; title: string; severity: string; observedAt: string }>
        rejected: Array<{ index: number; clientId: string | null; reason: string }>
      }
    }

    // 2 clientId unik berhasil disimpan, 3 poison pill ditolak secara terisolasi!
    expect(syncBody.data.syncedCount).toBe(2)
    expect(syncBody.data.rejected.length).toBe(3)

    const deduplicated = syncBody.data.items.find((i) => i.clientId === dupClientId)!
    expect(deduplicated.title).toBe('Versi Baru 11:00 (Deduplikasi Batch)')
    expect(deduplicated.severity).toBe('siaga')

    const clamped = syncBody.data.items.find((i) => i.clientId === futureClientId)!
    expect(Date.parse(clamped.observedAt)).toBeLessThanOrEqual(Date.now() + 5_000)

    // Out-of-order guard: kirim ulang paket terlambat dengan observedAt lebih tua (09:00 < 11:00)
    const staleSyncRes = await app.request('/api/v1/observations/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        items: [
          {
            clientId: dupClientId,
            category: 'sumur_warga',
            severity: 'normal',
            title: 'Paket Terlambat 09:00 (Jangan Menimpa!)',
            observedAt: '2026-10-19T09:00:00.000Z',
            lng: 110.295,
            lat: -7.225,
          },
        ],
      }),
    })
    expect(staleSyncRes.status).toBe(200)
    const staleBody = (await staleSyncRes.json()) as {
      data: { items: Array<{ clientId: string; title: string; severity: string }> }
    }
    // Data di database tidak boleh tertimpa oleh paket yang lebih tua!
    expect(staleBody.data.items[0].title).toBe('Versi Baru 11:00 (Deduplikasi Batch)')
    expect(staleBody.data.items[0].severity).toBe('siaga')
  })

  test('2. Privasi Anonim (Masking userId) & Delta Sync updatedSince pada GET /api/v1/observations', async () => {
    // 1. Pemanggil anonim: userId harus di-mask menjadi null
    const anonRes = await app.request('/api/v1/observations?limit=5')
    expect(anonRes.status).toBe(200)
    const anonBody = (await anonRes.json()) as {
      data: { items: Array<{ userId: string | null }> }
    }
    expect(anonBody.data.items.length).toBeGreaterThan(0)
    for (const item of anonBody.data.items) {
      expect(item.userId).toBeNull()
    }

    // 2. Pemanggil terautentikasi (petugas): userId asli dikembalikan
    const loginRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'petugas@kemitir.id',
        password: 'PetugasKemitir2026!',
        clientType: 'mobile',
      }),
    })
    const { accessToken } = ((await loginRes.json()) as { data: { accessToken: string } }).data

    const authObsRes = await app.request('/api/v1/observations?limit=5', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const authObsBody = (await authObsRes.json()) as {
      data: { items: Array<{ userId: string | null }> }
    }
    expect(authObsBody.data.items[0].userId).not.toBeNull()

    // 3. Delta sync updatedSince di masa depan -> 0 item
    const futureSince = new Date(Date.now() + 3600_000).toISOString()
    const deltaEmptyRes = await app.request(
      `/api/v1/observations?updatedSince=${encodeURIComponent(futureSince)}`
    )
    expect(deltaEmptyRes.status).toBe(200)
    const deltaEmptyBody = (await deltaEmptyRes.json()) as {
      data: { items: unknown[] }
    }
    expect(deltaEmptyBody.data.items.length).toBe(0)
  })

  test('3. Reserved layerSlug ("observations") ditolak 400 & validasi UUID pada PATCH/DELETE /api/v1/layers/:id', async () => {
    const loginRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@kemitir.id',
        password: 'AdminKemitir2026!',
        clientType: 'mobile',
      }),
    })
    const { accessToken } = ((await loginRes.json()) as { data: { accessToken: string } }).data

    // Coba membuat import job dengan slug tercadang "observations" -> harus ditolak 400!
    const reservedRes = await app.request('/api/v1/imports/presign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        layerName: 'Layer Tabrakan Observations',
        layerSlug: 'observations',
        fileType: 'shapefile_zip',
        fileSizeBytes: 4096,
      }),
    })
    expect(reservedRes.status).toBe(400)

    // Coba PATCH /api/v1/layers/bukan-uuid -> harus ditolak 400 VALIDATION_ERROR (bukan 404/500)
    const badUuidRes = await app.request('/api/v1/layers/bukan-uuid-valid', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ name: 'Nama Baru' }),
    })
    expect(badUuidRes.status).toBe(400)
  })

  test('4. macOS __MACOSX/._* dan .DS_Store di dalam ZIP Shapefile diabaikan dengan aman oleh Zip-Guard & Extractor', async () => {
    const geojsonFeatureCollection = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { dusun: 'Kemitir Lor' },
          geometry: { type: 'Point', coordinates: [110.295, -7.225] },
        },
      ],
    })

    const macZipBuf = buildTestZipBuffer([
      { name: '__MACOSX/._dusun.shp', data: new Uint8Array([0, 5, 22, 7]) },
      { name: '.DS_Store', data: new Uint8Array([0, 0, 0, 1]) },
      { name: 'subfolder/._dusun.dbf', data: new Uint8Array([0, 5, 22, 7]) },
      { name: 'subfolder/dusun.shp', data: new TextEncoder().encode(geojsonFeatureCollection) },
      { name: 'subfolder/dusun.shx', data: new Uint8Array([1, 2, 3, 4]) },
      { name: 'subfolder/dusun.dbf', data: new Uint8Array([5, 6, 7, 8]) },
      { name: 'subfolder/dusun.prj', data: new TextEncoder().encode('GEOGCS["GCS_WGS_1984"]') },
    ])

    const check = validateShapefileZipTail(
      macZipBuf.subarray(0, 16),
      macZipBuf,
      macZipBuf.byteLength
    )
    expect(check.valid).toBe(true)
    expect(check.shapefileBaseName).toBe('dusun')

    const tempDir = mkdtempSync(join(tmpdir(), 'kemitir-maczip-'))
    try {
      const zipPath = join(tempDir, 'mac.zip')
      const outDir = join(tempDir, 'out')
      await Bun.write(zipPath, macZipBuf)
      const extractedFiles = await extractVerifiedZipToDir(zipPath, outDir)
      // Hanya 4 file komponen shapefile asli yang diekstrak, file __MACOSX & .DS_Store diabaikan
      expect(extractedFiles.length).toBe(4)
      expect(extractedFiles.some((f) => f.includes('__MACOSX') || f.includes('.DS_Store'))).toBe(
        false
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('5. Worker Stale Job Recovery: mengklaim ulang job "processing" yang macet melewati batas waktu', async () => {
    const adminRls = {
      userId: '11111111-1111-4111-8111-111111111111',
      role: 'admin' as const,
    }
    const jobId = crypto.randomUUID()
    await createImportJob(
      {
        id: jobId,
        layerName: 'Layer Macet',
        layerSlug: 'layer-macet',
        fileType: 'shapefile_zip',
        sourceR2Key: `imports/${jobId}/source.zip`,
        fileSizeBytes: 1024,
      },
      adminRls
    )

    // Simulasikan worker crash 15 menit lalu saat status masih 'processing'
    const fifteenMinutesAgoIso = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    getSqliteStmt<unknown, [string, string]>(
      `UPDATE import_jobs SET status = 'processing', updated_at = ? WHERE id = ?`
    ).run(fifteenMinutesAgoIso, jobId)

    // Dengan staleThresholdMs = 10 menit, job yang macet 15 menit harus otomatis diklaim ulang!
    const recovered = await claimNextPendingImportJob(10 * 60 * 1000)
    expect(recovered).not.toBeNull()
    expect(recovered!.id).toBe(jobId)
    expect(recovered!.status).toBe('processing')
  })

  test('6. Per-Email Brute Force Protection (lintas IP berbeda) & X-Forwarded-For Spoofing Resistance', async () => {
    // Kirim 10 percobaan login gagal ke akun yang sama dengan X-Forwarded-For palsu yang selalu berganti
    for (let i = 0; i < 10; i++) {
      const res = await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `198.51.100.${i + 1}`,
        },
        body: JSON.stringify({
          email: 'admin@kemitir.id',
          password: 'salah', // Password pendek (< 8 karakter) tetap harus mendapat 401, bukan 400!
        }),
      })
      expect(res.status).toBe(401)
    }

    // Percobaan ke-11 pada akun email tersebut harus ditolak 429 meskipun memakai IP baru
    const lockedRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.250',
      },
      body: JSON.stringify({
        email: 'admin@kemitir.id',
        password: 'AdminKemitir2026!',
      }),
    })
    expect(lockedRes.status).toBe(429)
  })
})
