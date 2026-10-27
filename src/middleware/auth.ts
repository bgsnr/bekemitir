import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { ANON_RLS_CONTEXT, type RlsContext } from '../db/client'
import {
  verifyAccessToken,
  type ClientType,
  type UserRole,
} from '../lib/crypto'
import { fail } from '../lib/response'

export const COOKIE_NAMES = Object.freeze({
  accessToken: 'kemitir_at',
  refreshToken: 'kemitir_rt',
})

export interface AuthContextState {
  userId: string
  role: UserRole
  client: ClientType
  isAuthenticated: boolean
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContextState
    rls: RlsContext
  }
}

const ANON_AUTH_STATE: AuthContextState = Object.freeze({
  userId: ANON_RLS_CONTEXT.userId,
  role: 'anon',
  client: 'web',
  isAuthenticated: false,
})

/**
 * Mengekstrak identitas user dalam waktu O(1) dari:
 * 1. Header Authorization: Bearer <token> (Mobile App appgiskemitir)
 * 2. Cookie httpOnly kemitir_at (Web Client webgiskemitir)
 */
export function authenticateContext(): MiddlewareHandler {
  return async (c, next) => {
    let rawToken: string | undefined

    const authHeader = c.req.header('Authorization')
    if (authHeader && authHeader.startsWith('Bearer ')) {
      rawToken = authHeader.slice(7).trim()
    } else {
      rawToken = getCookie(c, COOKIE_NAMES.accessToken)
    }

    if (!rawToken) {
      c.set('auth', ANON_AUTH_STATE)
      c.set('rls', ANON_RLS_CONTEXT)
      await next()
      return
    }

    const payload = await verifyAccessToken(rawToken)
    if (!payload) {
      c.set('auth', ANON_AUTH_STATE)
      c.set('rls', ANON_RLS_CONTEXT)
      await next()
      return
    }

    const authState: AuthContextState = {
      userId: payload.sub,
      role: payload.role,
      client: payload.client,
      isAuthenticated: payload.role !== 'anon',
    }

    c.set('auth', authState)
    c.set('rls', { userId: payload.sub, role: payload.role })
    await next()
  }
}

/**
 * Guard otorisasi berbasis Role (RBAC) dalam O(1).
 */
export function requireRole(...allowedRoles: readonly UserRole[]): MiddlewareHandler {
  const allowedSet = new Set<UserRole>(allowedRoles)

  return async (c, next) => {
    const auth = c.get('auth') ?? ANON_AUTH_STATE
    if (!auth.isAuthenticated || auth.role === 'anon') {
      return fail(c, 'UNAUTHORIZED', 'Autentikasi diperlukan untuk mengakses endpoint ini.', 401)
    }
    if (!allowedSet.has(auth.role)) {
      return fail(
        c,
        'FORBIDDEN',
        'Peran akun Anda tidak memiliki izin untuk melakukan operasi ini.',
        403
      )
    }
    await next()
  }
}

export function getRlsFromContext(c: Context): RlsContext {
  return c.get('rls') ?? ANON_RLS_CONTEXT
}
