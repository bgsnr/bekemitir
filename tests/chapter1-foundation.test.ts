import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { parseConfig } from '../src/config'
import { BoundedLruCache } from '../src/lib/lru-cache'
import {
  generateRefreshTokenPair,
  hashPassword,
  hashTokenSha256,
  signAccessToken,
  verifyAccessToken,
  verifyPasswordTimingSafe,
} from '../src/lib/crypto'
import { fail, ok } from '../src/lib/response'

describe('Chapter 1 — Config & O(1) CORS Set', () => {
  test('mengompilasi CORS_ORIGINS menjadi ReadonlySet<string> untuk lookup O(1) dan membuang wildcard', () => {
    const cfg = parseConfig({
      NODE_ENV: 'development',
      PORT: '3000',
      DB_PROVIDER: 'sqlite',
      JWT_SECRET: 'a_very_secure_secret_with_at_least_32_characters',
      CORS_ORIGINS: ' https://web.kemitir.id , http://localhost:5173 , * ',
    })

    expect(cfg.corsOriginsSet.has('https://web.kemitir.id')).toBe(true)
    expect(cfg.corsOriginsSet.has('http://localhost:5173')).toBe(true)
    expect(cfg.corsOriginsSet.has('*')).toBe(false)
    expect(cfg.isR2Configured).toBe(false)
  })

  test('menolak startup production jika memakai default JWT_SECRET', () => {
    expect(() =>
      parseConfig({
        NODE_ENV: 'production',
        DB_PROVIDER: 'sqlite',
      })
    ).toThrow()
  })
})

describe('Chapter 1 — BoundedLruCache O(1)', () => {
  test('mengeviski item paling lama (LRU) saat melampaui maxEntries', () => {
    const cache = new BoundedLruCache<string>({ maxEntries: 3 })

    cache.set('a', 'Alpha', 5)
    cache.set('b', 'Bravo', 5)
    cache.set('c', 'Charlie', 5)

    // Akses 'a' agar menjadi Most Recently Used; 'b' menjadi yang paling lama
    expect(cache.get('a')).toBe('Alpha')

    // Tambah 'd' -> 'b' harus ter-eviksi dalam O(1)
    cache.set('d', 'Delta', 5)

    expect(cache.size).toBe(3)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe('Alpha')
    expect(cache.get('c')).toBe('Charlie')
    expect(cache.get('d')).toBe('Delta')
  })

  test('menjaga batas memori maxBytes secara ketat', () => {
    const cache = new BoundedLruCache<Uint8Array>({ maxEntries: 100, maxBytes: 100 })

    cache.set('tile1', new Uint8Array(40), 40)
    cache.set('tile2', new Uint8Array(40), 40)
    expect(cache.totalBytes).toBe(80)

    // Menambah 40 byte lagi melampaui 100 byte -> tile1 harus dieviksi otomatis
    cache.set('tile3', new Uint8Array(40), 40)
    expect(cache.totalBytes).toBe(80)
    expect(cache.get('tile1')).toBeUndefined()
    expect(cache.get('tile2')).toBeDefined()
    expect(cache.get('tile3')).toBeDefined()

    // Objek tunggal > maxBytes harus ditolak tanpa merusak isi cache
    expect(cache.set('huge', new Uint8Array(200), 200)).toBe(false)
    expect(cache.totalBytes).toBe(80)
  })

  test('menghormati TTL kedaluwarsa dan deleteByPrefix', () => {
    const cache = new BoundedLruCache<number>({ maxEntries: 10, ttlMs: 1000 })
    cache.set('layerA:1', 100, 4, undefined, 1000)
    cache.set('layerA:2', 200, 4, undefined, 1000)
    cache.set('layerB:1', 300, 4, undefined, 1000)

    expect(cache.get('layerA:1', 1500)).toBe(100)
    expect(cache.get('layerA:1', 2001)).toBeUndefined() // Sudah lewat TTL

    const deleted = cache.deleteByPrefix('layerA:')
    expect(deleted).toBe(1) // layerA:2 terhapus
    expect(cache.get('layerB:1', 1500)).toBe(300)
  })
})

describe('Chapter 1 — WebCrypto JWT Singleton & Argon2id Security', () => {
  test('menandatangani dan memverifikasi JWT HS256 secara akurat', async () => {
    const token = await signAccessToken({
      userId: '11111111-2222-3333-4444-555555555555',
      role: 'admin',
      client: 'web',
    })

    const payload = await verifyAccessToken(token)
    expect(payload).not.toBeNull()
    expect(payload?.sub).toBe('11111111-2222-3333-4444-555555555555')
    expect(payload?.role).toBe('admin')
    expect(payload?.client).toBe('web')
  })

  test('menolak token yang dimodifikasi payload-nya, alg:none, atau sudah kedaluwarsa', async () => {
    const validToken = await signAccessToken({
      userId: 'user-1',
      role: 'petugas',
      client: 'mobile',
    })

    const parts = validToken.split('.')
    // Ubah payload menjadi admin tanpa kunci rahasia
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'user-1', role: 'admin', client: 'mobile', iat: 100, exp: 9999999999 })
    ).toString('base64url')
    const tamperedToken = `${parts[0]}.${forgedPayload}.${parts[2]}`
    expect(await verifyAccessToken(tamperedToken)).toBeNull()

    // Coba serangan alg:none
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const algNoneToken = `${noneHeader}.${forgedPayload}.${parts[2]}`
    expect(await verifyAccessToken(algNoneToken)).toBeNull()

    // Token kedaluwarsa
    const expiredToken = await signAccessToken({
      userId: 'user-1',
      role: 'petugas',
      client: 'mobile',
      ttlSeconds: -10,
    })
    expect(await verifyAccessToken(expiredToken)).toBeNull()
  })

  test('generateRefreshTokenPair & verifyPasswordTimingSafe berfungsi dengan benar', async () => {
    const pair = generateRefreshTokenPair()
    expect(pair.rawToken.length).toBeGreaterThanOrEqual(40)
    expect(pair.tokenHash).toBe(hashTokenSha256(pair.rawToken))
    expect(pair.tokenHash).not.toBe(pair.rawToken)

    const hash = await hashPassword('RahasiaKemitir2026!')
    expect(await verifyPasswordTimingSafe('RahasiaKemitir2026!', hash)).toBe(true)
    expect(await verifyPasswordTimingSafe('PasswordSalah123!', hash)).toBe(false)
    // Saat user tidak ada (hash = null), tetap harus return false tanpa throw
    expect(await verifyPasswordTimingSafe('RahasiaKemitir2026!', null)).toBe(false)
  })
})

describe('Chapter 1 — Standard JSON Envelope Response', () => {
  test('ok() dan fail() menghasilkan kontrak JSON yang konsisten', async () => {
    const app = new Hono()
    app.get('/ok', (c) => ok(c, { status: 'ready' }, { limit: 25, nextCursor: null }))
    app.get('/fail', (c) => fail(c, 'INVALID_INPUT', 'Koordinat di luar jangkauan', 422))

    const resOk = await app.request('/ok')
    expect(resOk.status).toBe(200)
    expect(await resOk.json()).toEqual({
      success: true,
      data: { status: 'ready' },
      meta: { limit: 25, nextCursor: null },
    })

    const resFail = await app.request('/fail')
    expect(resFail.status).toBe(422)
    expect(await resFail.json()).toEqual({
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Koordinat di luar jangkauan',
      },
    })
  })
})
