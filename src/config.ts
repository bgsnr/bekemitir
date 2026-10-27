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
  REFRESH_GRACE_WINDOW_SECONDS: z.coerce.number().int().min(0).max(60).default(15),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:8081'),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().default('kemitir-gis'),
  R2_PUBLIC_URL: z.string().default('http://localhost:3000/api/v1/storage'),
  LOCAL_UPLOAD_DIR: z.string().default('./uploads'),
})

export function parseConfig(envInput: Record<string, string | undefined> = Bun.env) {
  const parsed = envSchema.safeParse(envInput)
  if (!parsed.success) {
    console.error('[CONFIG ERROR] Variabel environment tidak valid:', parsed.error.issues)
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

  // O(C) satu kali saat startup -> lookup per-request menjadi O(1) via ReadonlySet
  const originsSet: ReadonlySet<string> = new Set(
    raw.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0 && o !== '*')
  )

  return Object.freeze({
    ...raw,
    trustProxy: raw.TRUST_PROXY === 'true',
    corsOriginsSet: originsSet,
    isR2Configured: Boolean(
      raw.R2_ACCOUNT_ID && raw.R2_ACCESS_KEY_ID && raw.R2_SECRET_ACCESS_KEY
    ),
  })
}

export const config = parseConfig(Bun.env)
export type AppConfig = ReturnType<typeof parseConfig>
