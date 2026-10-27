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

export function ok<T>(
  c: Context,
  data: T,
  meta?: PaginationMeta,
  status: ContentfulStatusCode = 200
) {
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
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  }
  return c.json(body, status)
}
