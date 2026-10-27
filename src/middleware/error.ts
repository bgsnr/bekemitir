import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import { fail } from '../lib/response'

/**
 * Hook standar untuk @hono/zod-validator agar semua kegagalan validasi Zod di route boundary
 * menghasilkan JSON envelope yang konsisten dengan HTTP 400.
 */
export function zodErrorHook(
  result: {
    success: boolean
    error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }
  },
  c: Context
) {
  if (!result.success && result.error) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.map(String).join('.'),
      message: issue.message,
    }))
    return fail(
      c,
      'VALIDATION_ERROR',
      'Input permintaan tidak valid.',
      400,
      details
    )
  }
}

export const globalErrorHandler: ErrorHandler = (err, c) => {
  if (err.message === 'FORBIDDEN') {
    return fail(c, 'FORBIDDEN', 'Akses ditolak.', 403)
  }
  if (err.message === 'INVALID_TILE_COORD') {
    return fail(c, 'INVALID_TILE_COORD', 'Koordinat tile z/x/y berada di luar jangkauan.', 400)
  }

  console.error('[UNHANDLED ERROR]', err.message)
  return fail(
    c,
    'INTERNAL_SERVER_ERROR',
    'Terjadi kesalahan internal pada server.',
    500
  )
}

export const globalNotFoundHandler: NotFoundHandler = (c) => {
  return fail(
    c,
    'NOT_FOUND',
    `Endpoint ${c.req.method} ${c.req.path} tidak ditemukan.`,
    404
  )
}
