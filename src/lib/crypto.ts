import { config } from '../config'

export type UserRole = 'anon' | 'petugas' | 'admin'
export type ClientType = 'web' | 'mobile'

export interface AccessTokenPayload {
  sub: string
  role: UserRole
  client: ClientType
  iat: number
  exp: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

let cachedHmacKey: CryptoKey | null = null
let cachedSecretUsed: string | null = null

/**
 * Mengambil singleton CryptoKey HMAC-SHA256 dalam O(1) setelah inisialisasi pertama.
 */
async function getHmacKey(secret = config.JWT_SECRET): Promise<CryptoKey> {
  if (cachedHmacKey && cachedSecretUsed === secret) {
    return cachedHmacKey
  }
  cachedHmacKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
  cachedSecretUsed = secret
  return cachedHmacKey
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function fromBase64Url(str: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(str, 'base64url')
  const out = new Uint8Array(buf.byteLength)
  out.set(buf)
  return out
}

const JWT_HEADER_B64 = toBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))

/**
 * Membuat JWT Access Token dalam O(1).
 */
export async function signAccessToken(params: {
  userId: string
  role: UserRole
  client: ClientType
  ttlSeconds?: number
}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  const ttl = params.ttlSeconds ?? config.ACCESS_TOKEN_TTL_SECONDS
  const payload: AccessTokenPayload = {
    sub: params.userId,
    role: params.role,
    client: params.client,
    iat: nowSec,
    exp: nowSec + ttl,
  }
  const payloadB64 = toBase64Url(encoder.encode(JSON.stringify(payload)))
  const signingInput = `${JWT_HEADER_B64}.${payloadB64}`

  const key = await getHmacKey()
  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput))
  return `${signingInput}.${toBase64Url(new Uint8Array(sigBuffer))}`
}

/**
 * Memverifikasi JWT Access Token secara constant-time O(1) menggunakan WebCrypto.
 * Menolak token berukuran > 1024 byte, algoritma selain HS256 (alg:none attack),
 * tanda tangan tidak cocok, atau token yang sudah kedaluwarsa.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
  if (!token || token.length > 1024) return null

  const firstDot = token.indexOf('.')
  if (firstDot <= 0) return null
  const secondDot = token.indexOf('.', firstDot + 1)
  if (secondDot <= firstDot + 1 || token.indexOf('.', secondDot + 1) !== -1) return null

  const headerB64 = token.slice(0, firstDot)
  if (headerB64 !== JWT_HEADER_B64) return null

  const signingInput = token.slice(0, secondDot)
  const signatureB64 = token.slice(secondDot + 1)
  if (!signatureB64) return null

  try {
    const key = await getHmacKey()
    const sigBytes = fromBase64Url(signatureB64)
    if (sigBytes.byteLength !== 32) return null

    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      encoder.encode(signingInput)
    )
    if (!isValid) return null

    const payloadJson = decoder.decode(fromBase64Url(token.slice(firstDot + 1, secondDot)))
    const payload = JSON.parse(payloadJson) as Partial<AccessTokenPayload>
    const nowSec = Math.floor(Date.now() / 1000)

    if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') return null
    if (nowSec >= payload.exp) return null
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null
    if (payload.role !== 'anon' && payload.role !== 'petugas' && payload.role !== 'admin') {
      return null
    }
    if (payload.client !== 'web' && payload.client !== 'mobile') {
      return null
    }

    return payload as AccessTokenPayload
  } catch {
    return null
  }
}

/**
 * Menghasilkan refresh token acak (256-bit entropy) dan SHA-256 hash-nya dalam O(1).
 * Raw token dikirim ke klien; hanya tokenHash yang disimpan di database.
 */
export function generateRefreshTokenPair(): { rawToken: string; tokenHash: string } {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const rawToken = toBase64Url(bytes)
  return { rawToken, tokenHash: hashTokenSha256(rawToken) }
}

export function hashTokenSha256(rawToken: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(rawToken)
  return hasher.digest('hex')
}

export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, {
    algorithm: 'argon2id',
    memoryCost: 19456,
    timeCost: 2,
  })
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return Bun.password.verify(plain, hash)
}

let dummyArgon2HashPromise: Promise<string> | null = null

/**
 * Memverifikasi password dengan perlindungan terhadap User Enumeration Timing Attack.
 * Jika user tidak ditemukan di DB (passwordHash === null), fungsi tetap menjalankan
 * Argon2id verify terhadap dummy hash dengan parameter identik sehingga waktu respons konstan.
 */
export async function verifyPasswordTimingSafe(
  plain: string,
  passwordHash: string | null | undefined
): Promise<boolean> {
  if (!dummyArgon2HashPromise) {
    dummyArgon2HashPromise = hashPassword('dummy_constant_time_fallback_password_kemitir')
  }
  const targetHash = passwordHash ?? (await dummyArgon2HashPromise)
  const matched = await Bun.password.verify(plain, targetHash)
  return Boolean(passwordHash) && matched
}
