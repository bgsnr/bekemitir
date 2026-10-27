# Chapter 1: Fondasi, Konfigurasi, Struktur Data $O(1)$, & Keamanan Kriptografi

Dokumen ini merupakan bagian **1 dari 5** dari spesifikasi teknis implementasi backend `bekemitir`. Fokus Chapter 1 adalah membangun fondasi konfigurasi yang tervalidasi saat startup, struktur data memori terbatas (*bounded memory*) berkecepatan $O(1)$, primitif kriptografi *constant-time*, standar respons JSON, serta kontainerisasi Docker untuk VPS.

---

## 1. Invarian Big-O & Keamanan pada Chapter 1

| Modul | Operasi | Time Complexity | Space Complexity | Jaminan Keamanan & Anti-Halusinasi |
| :--- | :--- | :--- | :--- | :--- |
| `src/config.ts` | Validasi env & lookup origin CORS | Startup: $O(C)$<br>Per-request: **$O(1)$** | $O(C)$ ($C$ = jumlah origin) | Hanya membaca `Bun.env` di satu tempat. `CORS_ORIGINS` disimpan sebagai `ReadonlySet<string>` sehingga pengecekan origin di middleware berjalan $O(1)$. Menolak startup jika `JWT_SECRET < 32` karakter di mode production. |
| `src/lib/lru-cache.ts` | `get(key)`, `set(key, val)`, `delete(key)` | **$O(1)$** | **$O(K)$** bounded ($K \le \text{maxEntries}$, bytes $\le \text{maxBytes}$) | Memanfaatkan sifat `Map` di JavaScript (ES2015+) yang menjaga urutan insersi dalam *doubly-linked hash table* native C++/Zig di JSC/Bun. Eviksi elemen paling lama (`this.map.keys().next().value`) murni **$O(1)$** tanpa iterasi array. |
| `src/lib/crypto.ts` | `signAccessToken`, `verifyAccessToken`, `hashToken` | **$O(1)$** | **$O(1)$** | Kunci HMAC-SHA256 (`CryptoKey`) di-import **satu kali** (singleton lazy-init) menggunakan WebCrypto (`crypto.subtle.importKey`), bukan di-import ulang di setiap request. Verifikasi memakai `crypto.subtle.verify` yang bersifat *constant-time* (kebal *timing side-channel*). |
| `src/lib/response.ts` | Serialisasi JSON envelope | $O(S)$ ($S$ = ukuran payload) | $O(S)$ | Struktur seragam `{ success, data, error, meta }`. Tidak pernah membocorkan objek `Error` mentah atau *stack trace* internal. |

---

## 2. Spesifikasi File & Kode

### 2.1. `package.json`
Menggunakan runtime **Bun** murni dengan dependency eksternal seminimal mungkin (`hono`, `zod`, `@hono/zod-validator`, `aws4fetch`).

```json
{
  "name": "bekemitir",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "bun run --hot src/index.ts",
    "start": "bun run src/index.ts",
    "worker": "bun run src/worker.ts",
    "migrate": "bun run src/db/migrate.ts",
    "seed": "bun run src/db/seed.ts",
    "typecheck": "bunx tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "@hono/zod-validator": "^0.4.3",
    "aws4fetch": "^1.0.20",
    "hono": "^4.13.13",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

---

### 2.2. `.env.example` & `src/config.ts`

#### `.env.example`
```dotenv
# Environment: development | test | production
NODE_ENV=development
PORT=3000

# Database Provider: sqlite (lokal/uji coba) | postgres (produksi VPS)
DB_PROVIDER=sqlite
SQLITE_PATH=./data/dev.sqlite
DATABASE_URL=postgres://kemitir:secretpassword@localhost:5432/bekemitir

# Security & Auth (Minimal 32 karakter acak)
JWT_SECRET=ganti_dengan_minimal_32_karakter_acak_kriptografis_aman
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_DAYS=30

# CORS Allowlist (dipisahkan koma, tanpa wildcard '*' jika pakai credentials)
CORS_ORIGINS=http://localhost:5173,http://localhost:8081

# Cloudflare R2 Storage (Opsional saat dev lokal; wajib di produksi)
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=kemitir-gis
R2_PUBLIC_URL=https://tiles.kemitir.example.com
LOCAL_UPLOAD_DIR=./uploads
```

#### `src/config.ts`
- Membaca `Bun.env` satu kali saat modul di-load.
- Mengonversi daftar `CORS_ORIGINS` menjadi `ReadonlySet<string>` agar pengecekan origin di setiap request HTTP memiliki kompleksitas waktu **$O(1)$**.
- Menyediakan helper `isR2Configured` agar sistem otomatis beralih ke R2 di VPS atau ke direktori lokal `./uploads` saat uji coba offline di laptop.

```typescript
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DB_PROVIDER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  SQLITE_PATH: z.string().min(1).default('./data/dev.sqlite'),
  DATABASE_URL: z.string().optional(),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET wajib minimal 32 karakter untuk keamanan HMAC-SHA256')
    .default('dev_only_secret_key_minimum_32_chars_long_kemitir'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:8081'),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().default('kemitir-gis'),
  R2_PUBLIC_URL: z.string().default('http://localhost:3000/api/v1/storage'),
  LOCAL_UPLOAD_DIR: z.string().default('./uploads'),
})

const parsed = envSchema.safeParse(Bun.env)
if (!parsed.success) {
  console.error('[CONFIG ERROR] Variabel environment tidak valid:', parsed.error.flatten().fieldErrors)
  throw new Error('Konfigurasi environment gagal divalidasi.')
}

const raw = parsed.data

if (raw.NODE_ENV === 'production') {
  if (raw.JWT_SECRET.startsWith('dev_only_')) {
    throw new Error('Dilarang menggunakan default JWT_SECRET pada mode production!')
  }
  if (raw.DB_PROVIDER === 'postgres' && !raw.DATABASE_URL) {
    throw new Error('DATABASE_URL wajib diisi saat DB_PROVIDER=postgres!')
  }
}

const originsSet: ReadonlySet<string> = new Set(
  raw.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0 && o !== '*')
)

export const config = Object.freeze({
  ...raw,
  corsOriginsSet: originsSet,
  isR2Configured: Boolean(
    raw.R2_ACCOUNT_ID && raw.R2_ACCESS_KEY_ID && raw.R2_SECRET_ACCESS_KEY
  ),
})
```

---

### 2.3. `src/lib/lru-cache.ts` — Bounded LRU Cache $O(1)$
Digunakan di dua tempat kritis:
1. **Rate Limiter (`src/middleware/rate-limit.ts`)**: Mencegah serangan *memory exhaustion* jika penyerang melakukan *flooding* dari puluhan ribu IP berbeda.
2. **Vector Tile Cache (`src/db/queries/tiles.ts`)**: Menyimpan binary `.mvt` yang sering diakses di RAM dengan batas memori maksimum (misal 32 MB) dan TTL.

#### Kompleksitas:
- `get(key)`: **$O(1)$** (`Map.get` + `Map.delete` + `Map.set` untuk memindahkan ke posisi terbaru).
- `set(key, value, byteLength)`: **$O(1)$** amortized (eviksi head dari `this.map.keys().next()` berjalan dalam waktu konstan per elemen yang dieviksi).
- `clear()` / `invalidatePrefix()`: $O(K)$ terhadap entri di dalam cache.

```typescript
export interface LruCacheOptions {
  maxEntries: number
  maxBytes?: number
  ttlMs?: number
}

interface CacheEntry<V> {
  value: V
  bytes: number
  expiresAt: number
}

export class BoundedLruCache<V> {
  private readonly map = new Map<string, CacheEntry<V>>()
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly ttlMs: number
  private currentBytes = 0

  constructor(options: LruCacheOptions) {
    this.maxEntries = Math.max(1, options.maxEntries)
    this.maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER
    this.ttlMs = options.ttlMs ?? 0
  }

  public get size(): number {
    return this.map.size
  }

  public get totalBytes(): number {
    return this.currentBytes
  }

  /**
   * Mengambil nilai dalam O(1) dan memperbarui posisi menjadi Most Recently Used.
   */
  public get(key: string, now = Date.now()): V | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined

    if (entry.expiresAt > 0 && now >= entry.expiresAt) {
      this.delete(key)
      return undefined
    }

    // Promosikan ke posisi paling baru dalam O(1)
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  /**
   * Menyimpan nilai dalam O(1) amortized dan mengeviski entri tertua jika melampaui batas.
   */
  public set(key: string, value: V, byteLength = 1, customTtlMs?: number, now = Date.now()): void {
    if (byteLength > this.maxBytes) {
      return // Tolak objek tunggal yang melebihi kapasitas total cache
    }

    const existing = this.map.get(key)
    if (existing) {
      this.currentBytes -= existing.bytes
      this.map.delete(key)
    }

    const effectiveTtl = customTtlMs ?? this.ttlMs
    const expiresAt = effectiveTtl > 0 ? now + effectiveTtl : 0

    while (
      (this.map.size >= this.maxEntries || this.currentBytes + byteLength > this.maxBytes) &&
      this.map.size > 0
    ) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey === undefined) break
      this.delete(oldestKey)
    }

    this.map.set(key, { value, bytes: byteLength, expiresAt })
    this.currentBytes += byteLength
  }

  public delete(key: string): boolean {
    const existing = this.map.get(key)
    if (!existing) return false
    this.currentBytes -= existing.bytes
    return this.map.delete(key)
  }

  public clear(): void {
    this.map.clear()
    this.currentBytes = 0
  }
}
```

---

### 2.4. `src/lib/crypto.ts` — WebCrypto JWT Singleton & Hashing
- **Singleton `CryptoKey`**: Meng-import kunci rahasia satu kali ke dalam engine C++/BoringSSL milik Bun (`crypto.subtle.importKey`), sehingga operasi `signAccessToken` dan `verifyAccessToken` tidak mengulang alokasi kunci dan berjalan dalam **$O(1)$**.
- **Refresh Token**: Dibuat dari 32 byte CSPRNG (`crypto.getRandomValues`), dikodekan sebagai `base64url`, dan di-hash dengan **SHA-256** (`Bun.CryptoHasher`) sebelum disimpan ke database. Database **tidak pernah** menyimpan refresh token dalam bentuk plaintext.
- **Password Hashing**: Menggunakan `Bun.password.hash(plain, { algorithm: 'argon2id' })`.

```typescript
import { config } from '../config'

export type UserRole = 'anon' | 'petugas' | 'admin'

export interface AccessTokenPayload {
  sub: string
  role: UserRole
  client: 'web' | 'mobile'
  iat: number
  exp: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

let cachedHmacKey: CryptoKey | null = null

async function getHmacKey(): Promise<CryptoKey> {
  if (cachedHmacKey) return cachedHmacKey
  cachedHmacKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(config.JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
  return cachedHmacKey
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function fromBase64Url(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, 'base64url'))
}

const JWT_HEADER_B64 = toBase64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))

/**
 * Membuat JWT Access Token dalam O(1).
 */
export async function signAccessToken(params: {
  userId: string
  role: UserRole
  client: 'web' | 'mobile'
}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  const payload: AccessTokenPayload = {
    sub: params.userId,
    role: params.role,
    client: params.client,
    iat: nowSec,
    exp: nowSec + config.ACCESS_TOKEN_TTL_SECONDS,
  }
  const payloadB64 = toBase64Url(encoder.encode(JSON.stringify(payload)))
  const signingInput = `${JWT_HEADER_B64}.${payloadB64}`

  const key = await getHmacKey()
  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput))
  return `${signingInput}.${toBase64Url(new Uint8Array(sigBuffer))}`
}

/**
 * Memverifikasi JWT Access Token secara constant-time O(1).
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
  if (token.length > 1024) return null // Batasi ukuran token untuk mencegah DoS parsing
  const firstDot = token.indexOf('.')
  if (firstDot === -1) return null
  const secondDot = token.indexOf('.', firstDot + 1)
  if (secondDot === -1 || token.indexOf('.', secondDot + 1) !== -1) return null

  const headerB64 = token.slice(0, firstDot)
  if (headerB64 !== JWT_HEADER_B64) return null // Tolak algoritma selain HS256 (mencegah alg:none attack)

  const signingInput = token.slice(0, secondDot)
  const signatureB64 = token.slice(secondDot + 1)

  try {
    const key = await getHmacKey()
    const sigBytes = fromBase64Url(signatureB64)
    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      encoder.encode(signingInput)
    )
    if (!isValid) return null

    const payloadJson = decoder.decode(fromBase64Url(token.slice(firstDot + 1, secondDot)))
    const payload = JSON.parse(payloadJson) as AccessTokenPayload
    const nowSec = Math.floor(Date.now() / 1000)
    if (typeof payload.exp !== 'number' || nowSec >= payload.exp) return null
    if (typeof payload.sub !== 'string' || !payload.role) return null
    return payload
  } catch {
    return null
  }
}

/**
 * Menghasilkan refresh token acak (256-bit entropy) dan SHA-256 hash-nya dalam O(1).
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
  return Bun.password.hash(plain, { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 })
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return Bun.password.verify(plain, hash)
}
```

---

### 2.5. `src/lib/response.ts` — Kontrak JSON Envelope
Semua endpoint `/api/v1` wajib mengembalikan format envelope yang konsisten untuk memudahkan konsumsi di `webgiskemitir` dan `appgiskemitir`.

```typescript
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export interface PaginationMeta {
  limit: number
  nextCursor?: string | null
  total?: number
}

export interface ApiEnvelope<T> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
    details?: unknown
  }
  meta?: PaginationMeta
}

export function ok<T>(c: Context, data: T, meta?: PaginationMeta, status: ContentfulStatusCode = 200) {
  const body: ApiEnvelope<T> = { success: true, data }
  if (meta) body.meta = meta
  return c.json(body, status)
}

export function fail(
  c: Context,
  code: string,
  message: string,
  status: ContentfulStatusCode = 400,
  details?: unknown
) {
  const body: ApiEnvelope<never> = {
    success: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  }
  return c.json(body, status)
}
```

---

### 2.6. `Dockerfile` & `docker-compose.yml` untuk VPS Produksi

- Container berjalan sebagai user non-root (`USER bun`) untuk mengisolasi dampak jika terjadi kompromi proses.
- Menyertakan `gdal-bin` (`ogr2ogr`, `gdal_translate`) untuk container worker.
- PostgreSQL 16 + PostGIS 3.4 dikonfigurasi dengan batas `max_connections=100` sesuai aturan `AGENTS.md`.
