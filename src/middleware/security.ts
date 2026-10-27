import type { MiddlewareHandler } from 'hono'
import { config } from '../config'
import { fail } from '../lib/response'

/**
 * Middleware Security Headers & CORS Allowlist dalam waktu O(1).
 * Menggunakan ReadonlySet<string> (config.corsOriginsSet) sehingga tidak pernah melakukan
 * iterasi array O(N) atau menggabungkan wildcard '*' dengan credentials.
 */
export function securityAndCorsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    // 1. Pasang HTTP Security Headers standar
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Frame-Options', 'DENY')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Permitted-Cross-Domain-Policies', 'none')

    // 2. Cek Origin terhadap ReadonlySet O(1)
    const origin = c.req.header('Origin')
    if (origin && config.corsOriginsSet.has(origin)) {
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Access-Control-Allow-Credentials', 'true')
      c.header('Vary', 'Origin')
    }

    if (c.req.method === 'OPTIONS') {
      if (origin && config.corsOriginsSet.has(origin)) {
        c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        c.header(
          'Access-Control-Allow-Headers',
          'Content-Type, Authorization, X-Client-Type, If-None-Match'
        )
        c.header('Access-Control-Max-Age', '86400')
      }
      return c.body(null, 204)
    }

    await next()
  }
}

/**
 * Membatasi ukuran payload body dalam O(1) untuk mencegah serangan Memory Exhaustion
 * sebelum JSON.parse dijalankan.
 */
export function bodySizeLimit(maxBytes = 1_048_576): MiddlewareHandler {
  return async (c, next) => {
    const contentLengthHeader = c.req.header('Content-Length')
    if (contentLengthHeader) {
      const length = Number(contentLengthHeader)
      if (!Number.isNaN(length) && length > maxBytes) {
        return fail(
          c,
          'PAYLOAD_TOO_LARGE',
          `Ukuran request melebihi batas maksimum (${Math.round(maxBytes / 1024)} KB).`,
          413
        )
      }
    }
    await next()
  }
}
