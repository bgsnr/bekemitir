import { zValidator } from '@hono/zod-validator'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { config } from '../config'
import {
  createSessionTokens,
  createUserAccount,
  findUserByEmail,
  findUserById,
  listUsers,
  revokeRefreshTokenFamily,
  rotateRefreshToken,
  toPublicUser,
} from '../db/queries/auth'
import { hashPassword, verifyPasswordTimingSafe, type ClientType } from '../lib/crypto'
import { fail, ok } from '../lib/response'
import { COOKIE_NAMES, requireRole } from '../middleware/auth'
import { zodErrorHook } from '../middleware/error'
import {
  clearEmailLoginFailures,
  isEmailLoginRateLimited,
  rateLimit,
  recordEmailLoginFailure,
} from '../middleware/rate-limit'

export const authRouter = new Hono()

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(128),
  clientType: z.enum(['web', 'mobile']).optional(),
})

const refreshBodySchema = z.object({
  refreshToken: z.string().min(16).max(256).optional(),
})

function resolveClientType(c: Context, bodyClientType?: ClientType): ClientType {
  if (bodyClientType === 'mobile' || bodyClientType === 'web') {
    return bodyClientType
  }
  const headerClient = c.req.header('X-Client-Type')?.toLowerCase()
  return headerClient === 'mobile' ? 'mobile' : 'web'
}

function setWebAuthCookies(c: Context, accessToken: string, refreshToken: string): void {
  const isProd = config.NODE_ENV === 'production'

  setCookie(c, COOKIE_NAMES.accessToken, accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Lax',
    path: '/api/v1',
    maxAge: config.ACCESS_TOKEN_TTL_SECONDS,
  })

  setCookie(c, COOKIE_NAMES.refreshToken, refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Strict',
    path: '/api/v1/auth',
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  })
}

function clearWebAuthCookies(c: Context): void {
  deleteCookie(c, COOKIE_NAMES.accessToken, { path: '/api/v1' })
  deleteCookie(c, COOKIE_NAMES.refreshToken, { path: '/api/v1/auth' })
}

const authRateLimiter = rateLimit({
  keyPrefix: 'auth',
  windowMs: 60_000,
  maxRequests: 10,
})

authRouter.post(
  '/login',
  authRateLimiter,
  zValidator('json', loginSchema, zodErrorHook),
  async (c) => {
    const body = c.req.valid('json')
    const clientType = resolveClientType(c, body.clientType)

    // Cek rate limit per akun email dalam O(1) (menahan distributed brute-force lintas IP)
    const emailLimit = isEmailLoginRateLimited(body.email)
    if (emailLimit.limited) {
      c.header('Retry-After', String(emailLimit.retryAfterSec))
      return fail(
        c,
        'RATE_LIMIT_EXCEEDED',
        `Terlalu banyak percobaan gagal untuk akun ini. Coba lagi dalam ${emailLimit.retryAfterSec} detik.`,
        429
      )
    }

    const user = await findUserByEmail(body.email)
    // Selalu jalankan verifikasi Argon2id constant-time meskipun email tidak ditemukan
    const isPasswordValid = await verifyPasswordTimingSafe(
      body.password,
      user?.passwordHash ?? null
    )

    if (!user || !isPasswordValid) {
      recordEmailLoginFailure(body.email)
      return fail(c, 'INVALID_CREDENTIALS', 'Email atau kata sandi tidak valid.', 401)
    }

    clearEmailLoginFailures(body.email)
    const session = await createSessionTokens(user, clientType)
    const publicUser = toPublicUser(user)

    if (clientType === 'web') {
      setWebAuthCookies(c, session.accessToken, session.refreshToken)
      return ok(c, {
        clientType: 'web',
        expiresIn: session.expiresIn,
        user: publicUser,
      })
    }

    // Mobile client menerima accessToken (simpan di memori) + refreshToken (simpan di expo-secure-store)
    return ok(c, {
      clientType: 'mobile',
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
      user: publicUser,
    })
  }
)

authRouter.post('/refresh', authRateLimiter, async (c) => {
  let rawRefreshToken = getCookie(c, COOKIE_NAMES.refreshToken)

  if (!rawRefreshToken) {
    try {
      const jsonBody = await c.req.json()
      const parsed = refreshBodySchema.safeParse(jsonBody)
      if (parsed.success && parsed.data.refreshToken) {
        rawRefreshToken = parsed.data.refreshToken
      }
    } catch {
      // Body kosong saat menggunakan cookie web
    }
  }

  if (!rawRefreshToken) {
    return fail(c, 'MISSING_REFRESH_TOKEN', 'Refresh token tidak ditemukan.', 401)
  }

  const rotated = await rotateRefreshToken(rawRefreshToken)

  if (rotated.status === 'reuse_detected') {
    clearWebAuthCookies(c)
    return fail(
      c,
      'TOKEN_REUSE_DETECTED',
      'Deteksi penggunaan ulang refresh token di luar grace window. Seluruh sesi telah dicabut demi keamanan.',
      401
    )
  }

  if (rotated.status !== 'ok') {
    clearWebAuthCookies(c)
    return fail(c, 'INVALID_REFRESH_TOKEN', 'Sesi telah berakhir atau tidak valid.', 401)
  }

  if (rotated.clientType === 'web') {
    setWebAuthCookies(c, rotated.accessToken, rotated.refreshToken)
    return ok(c, {
      clientType: 'web',
      expiresIn: rotated.expiresIn,
      user: rotated.user,
      graceRetry: rotated.graceRetry,
    })
  }

  return ok(c, {
    clientType: 'mobile',
    accessToken: rotated.accessToken,
    refreshToken: rotated.refreshToken,
    expiresIn: rotated.expiresIn,
    user: rotated.user,
    graceRetry: rotated.graceRetry,
  })
})

authRouter.post('/logout', async (c) => {
  let rawRefreshToken = getCookie(c, COOKIE_NAMES.refreshToken)
  if (!rawRefreshToken) {
    try {
      const jsonBody = await c.req.json()
      const parsed = refreshBodySchema.safeParse(jsonBody)
      if (parsed.success && parsed.data.refreshToken) {
        rawRefreshToken = parsed.data.refreshToken
      }
    } catch {
      // Abaikan jika body kosong
    }
  }

  if (rawRefreshToken) {
    await revokeRefreshTokenFamily(rawRefreshToken)
  }

  clearWebAuthCookies(c)
  return ok(c, { loggedOut: true })
})

authRouter.get('/me', requireRole('petugas', 'admin'), async (c) => {
  const auth = c.get('auth')
  const user = await findUserById(auth.userId)
  if (!user) {
    return fail(c, 'USER_NOT_FOUND', 'Akun pengguna tidak ditemukan.', 404)
  }
  return ok(c, {
    user: toPublicUser(user),
    clientType: auth.client,
  })
})

const createUserSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  name: z.string().min(2).max(120),
  role: z.enum(['petugas', 'admin']).default('petugas'),
})

authRouter.get('/users', requireRole('admin'), async (c) => {
  const users = await listUsers(50)
  return ok(c, { items: users })
})

authRouter.post(
  '/users',
  requireRole('admin'),
  zValidator('json', createUserSchema, zodErrorHook),
  async (c) => {
    const body = c.req.valid('json')
    const existing = await findUserByEmail(body.email)
    if (existing) {
      return fail(c, 'EMAIL_ALREADY_EXISTS', 'Email sudah terdaftar.', 409)
    }

    const passwordHash = await hashPassword(body.password)
    const created = await createUserAccount({
      email: body.email,
      passwordHash,
      name: body.name,
      role: body.role,
    })

    return ok(c, { user: created }, undefined, 201)
  }
)
