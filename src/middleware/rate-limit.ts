import type { Context, MiddlewareHandler } from 'hono'
import { config } from '../config'
import { BoundedLruCache } from '../lib/lru-cache'
import { fail } from '../lib/response'

export interface RateLimitOptions {
  keyPrefix: string
  windowMs: number
  maxRequests: number
}

interface RateBucket {
  count: number
  resetAt: number
}

const rateBuckets = new BoundedLruCache<RateBucket>({
  maxEntries: 10_000, // Maksimal 10.000 IP/bucket aktif di memori -> kebal DoS IP flooding
})

const emailLoginFailureBuckets = new BoundedLruCache<RateBucket>({
  maxEntries: 5_000, // Melindungi dari distributed brute-force per akun email dalam O(1)
})

export function clearRateLimitBucketsForTests(): void {
  rateBuckets.clear()
  emailLoginFailureBuckets.clear()
}

/**
 * Mengekstrak IP klien dalam O(1).
 * Hanya mempercayai header proxy (CF-Connecting-IP / X-Forwarded-For) jika trustProxy = true,
 * sehingga mencegah bypass rate-limit melalui spoofing header X-Forwarded-For.
 */
export function extractClientIp(c: Context, trustProxy = config.trustProxy): string {
  if (trustProxy) {
    const cfIp = c.req.header('CF-Connecting-IP')
    if (cfIp) return cfIp.trim()
    const xff = c.req.header('X-Forwarded-For')
    if (xff) {
      const firstComma = xff.indexOf(',')
      return (firstComma >= 0 ? xff.slice(0, firstComma) : xff).trim()
    }
  }
  return '127.0.0.1'
}

/**
 * Mengecek apakah akun email sedang terkunci sementara akibat terlalu banyak gagal login (O(1)).
 */
export function isEmailLoginRateLimited(
  email: string,
  maxFailures = 10,
  now = Date.now()
): { limited: boolean; retryAfterSec: number } {
  const key = email.trim().toLowerCase()
  const bucket = emailLoginFailureBuckets.get(key, now)
  if (!bucket || now >= bucket.resetAt) {
    return { limited: false, retryAfterSec: 0 }
  }
  if (bucket.count >= maxFailures) {
    return {
      limited: true,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    }
  }
  return { limited: false, retryAfterSec: 0 }
}

/**
 * Mencatat kegagalan login untuk akun email tertentu dalam O(1).
 */
export function recordEmailLoginFailure(
  email: string,
  windowMs = 5 * 60_000,
  now = Date.now()
): void {
  const key = email.trim().toLowerCase()
  const bucket = emailLoginFailureBuckets.get(key, now)
  if (!bucket || now >= bucket.resetAt) {
    emailLoginFailureBuckets.set(key, { count: 1, resetAt: now + windowMs }, 32, windowMs, now)
  } else {
    bucket.count += 1
  }
}

export function clearEmailLoginFailures(email: string): void {
  emailLoginFailureBuckets.delete(email.trim().toLowerCase())
}

/**
 * Rate Limiter Fixed-Window di atas BoundedLruCache dengan kompleksitas waktu O(1)
 * dan kompleksitas ruang terbatas O(K) (K <= 10.000).
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const { keyPrefix, windowMs, maxRequests } = options

  return async (c, next) => {
    const ip = extractClientIp(c)
    const key = `${keyPrefix}:${ip}`
    const now = Date.now()

    let bucket = rateBuckets.get(key, now)
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 1, resetAt: now + windowMs }
      rateBuckets.set(key, bucket, 32, windowMs, now)
    } else {
      bucket.count += 1
    }

    const remaining = Math.max(0, maxRequests - bucket.count)
    c.header('X-RateLimit-Limit', String(maxRequests))
    c.header('X-RateLimit-Remaining', String(remaining))

    if (bucket.count > maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      c.header('Retry-After', String(retryAfterSec))
      return fail(
        c,
        'RATE_LIMIT_EXCEEDED',
        `Terlalu banyak permintaan. Silakan coba lagi dalam ${retryAfterSec} detik.`,
        429
      )
    }

    await next()
  }
}
