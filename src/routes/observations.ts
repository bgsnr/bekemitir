import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  listObservations,
  syncObservationsBatch,
  type SyncObservationInput,
} from '../db/queries/observations'
import type { BoundingBox } from '../lib/mvt-lite'
import { createPhotoUploadTarget, saveLocalUploadObject } from '../lib/r2'
import { fail, ok } from '../lib/response'
import { getRlsFromContext, requireRole } from '../middleware/auth'
import { zodErrorHook } from '../middleware/error'

export const observationsRouter = new Hono()

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(256).optional(),
  severity: z.enum(['normal', 'waspada', 'siaga', 'awas']).optional(),
  bbox: z.string().max(120).optional(),
  updatedSince: z.string().datetime().optional(),
})

const observationItemSchema = z.object({
  clientId: z.string().uuid(),
  category: z.string().min(2).max(64),
  severity: z.enum(['normal', 'waspada', 'siaga', 'awas']),
  title: z.string().min(2).max(160),
  notes: z.string().max(2000).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  photoR2Key: z.string().max(255).nullable().optional(),
  observedAt: z.string().datetime(),
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
})

/**
 * Skema amplop luar hanya memastikan items adalah array 1..100,
 * sedangkan validasi masing-masing item dilakukan secara terisolasi agar 1 item rusak
 * ("poison pill") tidak memblokir 99 item lain di antrean offline.
 */
const syncEnvelopeSchema = z.object({
  items: z.array(z.unknown()).min(1).max(100),
})

const photoPresignSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  sizeBytes: z.number().int().min(100).max(10 * 1024 * 1024), // Maksimal 10 MB per foto
})

export interface RejectedSyncItem {
  index: number
  clientId: string | null
  code: string
  message: string
}

function isValidPhotoKeyForUser(photoR2Key: string, userId: string, isAdmin: boolean): boolean {
  if (photoR2Key.includes('..') || photoR2Key.includes('\\')) return false
  const pattern = isAdmin
    ? /^photos\/[a-f0-9-]+\/[a-f0-9-]+\.(jpg|png|webp)$/i
    : new RegExp(`^photos/${userId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[a-f0-9-]+\\.(jpg|png|webp)$`, 'i')
  return pattern.test(photoR2Key)
}

function isValidImageMagicBytes(buf: Uint8Array): boolean {
  if (buf.byteLength < 12) return false
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return true
  }
  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return true
  }
  return false
}

function parseBBoxParam(bboxStr: string): BoundingBox | null {
  const parts = bboxStr.split(',').map((s) => Number(s.trim()))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null
  const [minLng, minLat, maxLng, maxLat] = parts
  if (minLng < -180 || maxLng > 180 || minLng > maxLng) return null
  if (minLat < -90 || maxLat > 90 || minLat > maxLat) return null
  return [minLng, minLat, maxLng, maxLat]
}

observationsRouter.get(
  '/',
  zValidator('query', listQuerySchema, zodErrorHook),
  async (c) => {
    const query = c.req.valid('query')
    let bbox: BoundingBox | undefined
    if (query.bbox) {
      const parsed = parseBBoxParam(query.bbox)
      if (!parsed) {
        return fail(
          c,
          'INVALID_BBOX',
          'Format bbox harus "minLng,minLat,maxLng,maxLat" dalam rentang koordinat WGS84.',
          400
        )
      }
      bbox = parsed
    }

    const rls = getRlsFromContext(c)
    const limit = query.limit ?? 25
    const result = await listObservations(
      {
        limit,
        cursor: query.cursor,
        severity: query.severity,
        bbox,
        updatedSince: query.updatedSince,
      },
      rls
    )

    return ok(c, { items: result.items }, { limit, nextCursor: result.nextCursor })
  }
)

observationsRouter.post(
  '/sync',
  requireRole('petugas', 'admin'),
  zValidator('json', syncEnvelopeSchema, zodErrorHook),
  async (c) => {
    const body = c.req.valid('json')
    const rls = getRlsFromContext(c)
    const isAdmin = rls.role === 'admin'

    const validItems: SyncObservationInput[] = []
    const rejected: RejectedSyncItem[] = []

    for (let i = 0; i < body.items.length; i++) {
      const rawItem = body.items[i]
      const rawClientId =
        typeof rawItem === 'object' &&
        rawItem !== null &&
        'clientId' in rawItem &&
        typeof (rawItem as { clientId?: unknown }).clientId === 'string'
          ? ((rawItem as { clientId: string }).clientId)
          : null

      const parsed = observationItemSchema.safeParse(rawItem)
      if (!parsed.success) {
        rejected.push({
          index: i,
          clientId: rawClientId,
          code: 'INVALID_OBSERVATION_ITEM',
          message: parsed.error.issues.map((iss) => iss.message).join('; '),
        })
        continue
      }

      const item = parsed.data

      // Tolak koordinat (0, 0) Null Island akibat kegagalan lock GPS
      if (Math.abs(item.lng) < 1e-5 && Math.abs(item.lat) < 1e-5) {
        rejected.push({
          index: i,
          clientId: item.clientId,
          code: 'INVALID_GPS_NULL_ISLAND',
          message: 'Koordinat (0, 0) ditolak karena indikasi kegagalan sensor GPS.',
        })
        continue
      }

      // Validasi kepemilikan photoR2Key
      if (item.photoR2Key) {
        if (!isValidPhotoKeyForUser(item.photoR2Key, rls.userId, isAdmin)) {
          rejected.push({
            index: i,
            clientId: item.clientId,
            code: 'INVALID_PHOTO_KEY',
            message: 'photoR2Key tidak valid atau bukan milik akun Anda.',
          })
          continue
        }
      }

      // Batasi ukuran JSON properties per item (maks 16 KB)
      if (item.properties && JSON.stringify(item.properties).length > 16_384) {
        rejected.push({
          index: i,
          clientId: item.clientId,
          code: 'PROPERTIES_TOO_LARGE',
          message: 'Ukuran atribut tambahan (properties) melebihi batas 16 KB.',
        })
        continue
      }

      validItems.push(item)
    }

    if (validItems.length === 0) {
      return fail(
        c,
        'ALL_SYNC_ITEMS_INVALID',
        'Seluruh item di dalam batch tidak valid.',
        400,
        rejected
      )
    }

    const synced = await syncObservationsBatch(validItems, rls)
    return ok(c, {
      syncedCount: synced.syncedCount,
      items: synced.items,
      rejected,
    })
  }
)

observationsRouter.post(
  '/photo-presign',
  requireRole('petugas', 'admin'),
  zValidator('json', photoPresignSchema, zodErrorHook),
  async (c) => {
    const body = c.req.valid('json')
    const auth = c.get('auth')
    const target = await createPhotoUploadTarget({
      userId: auth.userId,
      contentType: body.contentType,
    })
    return ok(c, target)
  }
)

observationsRouter.put(
  '/local-photo-upload',
  requireRole('petugas', 'admin'),
  async (c) => {
    const key = c.req.query('key')
    const auth = c.get('auth')
    if (
      !key ||
      !isValidPhotoKeyForUser(key, auth.userId, auth.role === 'admin')
    ) {
      return fail(c, 'INVALID_STORAGE_KEY', 'Storage key foto tidak valid atau bukan milik Anda.', 400)
    }

    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength < 12 || bytes.byteLength > 10 * 1024 * 1024) {
      return fail(c, 'INVALID_IMAGE_SIZE', 'Ukuran foto melebihi batas 10 MB.', 400)
    }
    if (!isValidImageMagicBytes(bytes)) {
      return fail(
        c,
        'INVALID_IMAGE_MAGIC_BYTES',
        'File foto wajib berformat JPEG, PNG, atau WebP asli.',
        400
      )
    }

    await saveLocalUploadObject(key, bytes)
    return ok(c, { uploadedBytes: bytes.byteLength, key })
  }
)
