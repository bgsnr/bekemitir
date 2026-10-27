import { beforeEach, describe, expect, test } from 'bun:test'
import { getSqliteStmt, resetSqliteForTests } from '../src/db/client'
import { clearAllTileCache } from '../src/db/queries/tiles'
import { seedDatabase } from '../src/db/seed'
import { app } from '../src/index'
import { hashTokenSha256 } from '../src/lib/crypto'
import { lngLatToTileXY } from '../src/lib/mvt-lite'
import { clearRateLimitBucketsForTests } from '../src/middleware/rate-limit'

describe('Chapter 5 — Security Headers, O(1) CORS Allowlist & Rate Limiter', () => {
  beforeEach(async () => {
    resetSqliteForTests(':memory:')
    clearAllTileCache()
    clearRateLimitBucketsForTests()
    await seedDatabase()
  })

  test('memasang security headers dan menghormati CORS allowlist O(1)', async () => {
    // Origin yang diizinkan di default config: http://localhost:5173
    const allowedRes = await app.request('/api/v1/health', {
      headers: { Origin: 'http://localhost:5173' },
    })
    expect(allowedRes.status).toBe(200)
    expect(allowedRes.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    expect(allowedRes.headers.get('Access-Control-Allow-Credentials')).toBe('true')
    expect(allowedRes.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(allowedRes.headers.get('X-Frame-Options')).toBe('DENY')

    // Origin asing harus ditolak dari header Access-Control-Allow-Origin
    const evilRes = await app.request('/api/v1/health', {
      headers: { Origin: 'https://evil-attacker.com' },
    })
    expect(evilRes.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  test('menolak payload JSON > 1 MB dengan 413 PAYLOAD_TOO_LARGE dalam O(1)', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(2 * 1024 * 1024),
      },
      body: JSON.stringify({ email: 'a@b.c', password: '12345678' }),
    })
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  test('rate limiter membatasi brute-force login > 10 request / menit dengan 429 + Retry-After', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.77',
        },
        body: JSON.stringify({ email: 'admin@kemitir.id', password: 'WrongPassword123!' }),
      })
      expect(r.status).toBe(401)
    }

    // Request ke-11 dari IP yang sama harus langsung ditolak 429 dalam O(1)
    const blocked = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.77',
      },
      body: JSON.stringify({ email: 'admin@kemitir.id', password: 'WrongPassword123!' }),
    })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('Retry-After')).not.toBeNull()
  })
})

describe('Chapter 5 — Dual-Client Auth (Web Cookie vs Mobile Token) & Token Reuse Detection', () => {
  beforeEach(async () => {
    resetSqliteForTests(':memory:')
    clearAllTileCache()
    clearRateLimitBucketsForTests()
    await seedDatabase()
  })

  test('Web login menyetel httpOnly Cookie, sedangkan Mobile login mengembalikan pasangan token di JSON', async () => {
    // 1. Login Web
    const webRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@kemitir.id',
        password: 'AdminKemitir2026!',
        clientType: 'web',
      }),
    })
    expect(webRes.status).toBe(200)
    const setCookieHeader = webRes.headers.get('set-cookie') ?? ''
    expect(setCookieHeader).toContain('kemitir_at=')
    expect(setCookieHeader).toContain('kemitir_rt=')
    expect(setCookieHeader).toContain('HttpOnly')

    // 2. Login Mobile
    const mobileRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'petugas@kemitir.id',
        password: 'PetugasKemitir2026!',
        clientType: 'mobile',
      }),
    })
    expect(mobileRes.status).toBe(200)
    const mobileBody = (await mobileRes.json()) as {
      success: boolean
      data: { accessToken: string; refreshToken: string; user: { role: string } }
    }
    expect(mobileBody.success).toBe(true)
    expect(mobileBody.data.accessToken).toBeDefined()
    expect(mobileBody.data.refreshToken).toBeDefined()
    expect(mobileBody.data.user.role).toBe('petugas')

    // Akses /api/v1/auth/me dengan Bearer token mobile
    const meRes = await app.request('/api/v1/auth/me', {
      headers: { Authorization: `Bearer ${mobileBody.data.accessToken}` },
    })
    expect(meRes.status).toBe(200)
  })

  test('Refresh Token mendukung Grace Window (< 15s) untuk sinyal lemah dan mencabut seluruh keluarga sesi jika dipakai ulang di luar Grace Window', async () => {
    const loginRes = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'petugas@kemitir.id',
        password: 'PetugasKemitir2026!',
        clientType: 'mobile',
      }),
    })
    const { refreshToken: rt1 } = ((await loginRes.json()) as { data: { refreshToken: string } }).data

    // Rotasi pertama (valid) -> menghasilkan rt2
    const rot1Res = await app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt1 }),
    })
    expect(rot1Res.status).toBe(200)
    const { refreshToken: rt2 } = ((await rot1Res.json()) as { data: { refreshToken: string } }).data
    expect(rt2).not.toBe(rt1)

    // 1. Di dalam Grace Window (mis. paket HTTP hilang di sinyal lemah lalu klien retry < 15 detik):
    // Harus sukses (200 OK) dengan graceRetry: true dan tidak memutus sesi!
    const graceRes = await app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt1 }),
    })
    expect(graceRes.status).toBe(200)
    const graceBody = (await graceRes.json()) as {
      data: { refreshToken: string; graceRetry: boolean }
    }
    expect(graceBody.data.graceRetry).toBe(true)

    // 2. Simulasikan waktu telah lewat 30 detik (melewati Grace Window 15 detik):
    const rt1Hash = hashTokenSha256(rt1)
    const pastIso = new Date(Date.now() - 30_000).toISOString()
    getSqliteStmt<unknown, [string, string]>(
      `UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?`
    ).run(pastIso, rt1Hash)

    // Penyerang mencoba memakai ulang rt1 di luar Grace Window -> Reuse Detection aktif!
    const replayRes = await app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt1 }),
    })
    expect(replayRes.status).toBe(401)
    const replayBody = (await replayRes.json()) as { error: { code: string } }
    expect(replayBody.error.code).toBe('TOKEN_REUSE_DETECTED')

    // Pastikan rt2 juga otomatis ikut tercabut karena satu family_id dengan rt1!
    const afterCompromiseRes = await app.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt2 }),
    })
    expect(afterCompromiseRes.status).toBe(401)
  })
})

describe('Chapter 5 — Spatial Routes, ETag 304 Not Modified, RBAC, & Offline Sync', () => {
  beforeEach(async () => {
    resetSqliteForTests(':memory:')
    clearAllTileCache()
    clearRateLimitBucketsForTests()
    await seedDatabase()
  })

  test('GET /api/v1/tiles/:layer/:z/:x/:y.mvt mendukung ETag dan mengembalikan 304 Not Modified dalam O(1)', async () => {
    const { x, y } = lngLatToTileXY(110.295, -7.228, 14)
    const tileUrl = `/api/v1/tiles/batas-dusun-kemitir/14/${x}/${y}.mvt`

    const res1 = await app.request(tileUrl)
    expect(res1.status).toBe(200)
    expect(res1.headers.get('Content-Type')).toBe('application/vnd.mapbox-vector-tile')
    const etag = res1.headers.get('ETag')
    expect(etag).not.toBeNull()
    const bytes = new Uint8Array(await res1.arrayBuffer())
    expect(bytes.byteLength).toBeGreaterThan(20)

    // Kirim request kedua dengan header If-None-Match -> harus 304 Not Modified (0 byte)
    const res304 = await app.request(tileUrl, {
      headers: { 'If-None-Match': etag! },
    })
    expect(res304.status).toBe(304)
    expect(res304.headers.get('X-Tile-Cache')).toBe('HIT')
  })

  test('RBAC & Offline Sync: petugas bisa sync observasi tapi ditolak di endpoint admin /imports', async () => {
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

    // 1. Petugas melakukan sync observasi lapangan -> 200 OK
    const syncRes = await app.request('/api/v1/observations/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        items: [
          {
            clientId: '88888888-8888-4888-8888-888888888801',
            category: 'sumur_bor',
            severity: 'siaga',
            title: 'Sumur Bor Dusun Tegalsari Debit Menurun',
            notes: 'Perlu pengaturan jadwal pompa',
            observedAt: '2026-10-20T12:00:00.000Z',
            lng: 110.302,
            lat: -7.227,
          },
        ],
      }),
    })
    expect(syncRes.status).toBe(200)

    // 2. Petugas mencoba mengakses endpoint khusus Admin (/api/v1/imports/presign) -> 403 FORBIDDEN
    const forbiddenRes = await app.request('/api/v1/imports/presign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        layerName: 'Irigasi',
        layerSlug: 'irigasi-kemitir',
        fileType: 'shapefile_zip',
        fileSizeBytes: 2048,
      }),
    })
    expect(forbiddenRes.status).toBe(403)

    // 3. Cek endpoint publik /api/v1/summaries/drought dan /api/v1/observations
    const summaryRes = await app.request('/api/v1/summaries/drought')
    expect(summaryRes.status).toBe(200)
    const summaryBody = (await summaryRes.json()) as {
      data: { totalObservations: number; bySeverity: { siaga: number } }
    }
    expect(summaryBody.data.totalObservations).toBe(5)
    expect(summaryBody.data.bySeverity.siaga).toBe(2)

    const obsListRes = await app.request(
      '/api/v1/observations?limit=2&bbox=110.28,-7.24,110.32,-7.20'
    )
    expect(obsListRes.status).toBe(200)
    const obsListBody = (await obsListRes.json()) as {
      data: { items: unknown[] }
      meta: { limit: number; nextCursor: string }
    }
    expect(obsListBody.data.items.length).toBe(2)
    expect(obsListBody.meta.nextCursor).not.toBeNull()
  })

  test('GET /api/v1/openapi.json dan GET /api/v1/docs menyajikan dokumentasi OpenAPI 3.1.0 dalam O(1)', async () => {
    const specRes = await app.request('/api/v1/openapi.json')
    expect(specRes.status).toBe(200)
    const spec = (await specRes.json()) as {
      openapi: string
      paths: Record<string, unknown>
    }
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.paths['/api/v1/auth/login']).toBeDefined()
    expect(spec.paths['/api/v1/tiles/{layerSlug}/{z}/{x}/{y}.mvt']).toBeDefined()
    expect(spec.paths['/api/v1/observations/sync']).toBeDefined()
    expect(spec.paths['/api/v1/imports/presign']).toBeDefined()

    const docsRes = await app.request('/api/v1/docs')
    expect(docsRes.status).toBe(200)
    expect(await docsRes.text()).toContain('/api/v1/openapi.json')
  })
})
