import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  createImportJob,
  getImportJobById,
  listImportJobs,
  updateImportJobStatus,
} from '../db/queries/imports'
import {
  createImportUploadTarget,
  readObjectHeaderAndTail,
  saveLocalUploadObject,
} from '../lib/r2'
import { fail, ok } from '../lib/response'
import {
  inspectMagicBytes,
  validateShapefileZipTail,
} from '../lib/zip-guard'
import { getRlsFromContext, requireRole } from '../middleware/auth'
import { zodErrorHook } from '../middleware/error'
import { rateLimit } from '../middleware/rate-limit'

export const importsRouter = new Hono()

export const RESERVED_LAYER_SLUGS = new Set([
  'observations',
  'health',
  'auth',
  'layers',
  'tiles',
  'imports',
  'summaries',
  'storage',
  'docs',
  'openapi',
  'admin',
  'system',
])

const presignSchema = z.object({
  layerName: z.string().min(2).max(120),
  layerSlug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'layerSlug hanya boleh huruf kecil, angka, dan tanda hubung (-)')
    .refine(
      (slug) => !RESERVED_LAYER_SLUGS.has(slug),
      'layerSlug ini dicadangkan oleh sistem dan tidak boleh digunakan.'
    ),
  fileType: z.enum(['shapefile_zip', 'geotiff']),
  fileSizeBytes: z
    .number()
    .int()
    .min(64)
    .max(200 * 1024 * 1024), // Maksimal 200 MB file terkompresi
})

const importsRateLimiter = rateLimit({
  keyPrefix: 'imports',
  windowMs: 60_000,
  maxRequests: 15,
})

importsRouter.post(
  '/presign',
  requireRole('admin'),
  importsRateLimiter,
  zValidator('json', presignSchema, zodErrorHook),
  async (c) => {
    const body = c.req.valid('json')
    const rls = getRlsFromContext(c)
    const jobId = crypto.randomUUID()

    const uploadTarget = await createImportUploadTarget({
      jobId,
      fileType: body.fileType,
    })

    const job = await createImportJob(
      {
        id: jobId,
        layerName: body.layerName,
        layerSlug: body.layerSlug,
        fileType: body.fileType,
        sourceR2Key: uploadTarget.r2Key,
        fileSizeBytes: body.fileSizeBytes,
      },
      rls
    )

    return ok(
      c,
      {
        job,
        uploadUrl: uploadTarget.uploadUrl,
        expiresInSeconds: uploadTarget.expiresInSeconds,
      },
      undefined,
      201
    )
  }
)

/**
 * Endpoint upload lokal khusus saat uji coba lokal (ketika Cloudflare R2 tidak dikonfigurasi).
 */
importsRouter.put('/:id/local-upload', requireRole('admin'), async (c) => {
  const id = c.req.param('id')
  const rls = getRlsFromContext(c)
  const job = await getImportJobById(id, rls)
  if (!job) {
    return fail(c, 'JOB_NOT_FOUND', 'Import job tidak ditemukan.', 404)
  }
  if (job.status !== 'pending_upload') {
    return fail(c, 'INVALID_JOB_STATE', `Job sudah berstatus "${job.status}".`, 409)
  }

  const rawBuf = new Uint8Array(await c.req.arrayBuffer())
  if (rawBuf.byteLength === 0 || rawBuf.byteLength > 200 * 1024 * 1024) {
    return fail(c, 'INVALID_UPLOAD_SIZE', 'Ukuran file unggahan tidak valid.', 400)
  }

  await saveLocalUploadObject(job.sourceR2Key, rawBuf)
  return ok(c, { uploadedBytes: rawBuf.byteLength })
})

/**
 * Memvalidasi magic bytes O(1) dan struktur EOCD ZIP O(E) (anti Zip-Bomb & Zip-Slip)
 * sebelum memasukkan job ke antrean worker ('pending').
 */
importsRouter.post(
  '/:id/enqueue',
  requireRole('admin'),
  importsRateLimiter,
  async (c) => {
    const id = c.req.param('id')
    const rls = getRlsFromContext(c)
    const job = await getImportJobById(id, rls)
    if (!job) {
      return fail(c, 'JOB_NOT_FOUND', 'Import job tidak ditemukan.', 404)
    }

    if (job.status !== 'pending_upload') {
      return fail(c, 'INVALID_JOB_STATE', `Job sudah berstatus "${job.status}".`, 409)
    }

    const slices = await readObjectHeaderAndTail(job.sourceR2Key)
    if (!slices) {
      return fail(
        c,
        'SOURCE_FILE_MISSING',
        'File sumber belum terunggah ke storage.',
        400
      )
    }

    if (job.fileType === 'shapefile_zip') {
      const check = validateShapefileZipTail(
        slices.headerBytes,
        slices.tailBytes,
        slices.totalSize
      )
      if (!check.valid) {
        await updateImportJobStatus(
          job.id,
          'failed',
          { errorMessage: `[${check.code}] ${check.message}` },
          rls
        )
        return fail(c, check.code ?? 'INVALID_ZIP', check.message ?? 'ZIP tidak valid.', 400)
      }
    } else {
      const isTiff = inspectMagicBytes(slices.headerBytes, 'geotiff')
      if (!isTiff) {
        await updateImportJobStatus(
          job.id,
          'failed',
          { errorMessage: '[INVALID_MAGIC_BYTES] File bukan GeoTIFF yang valid.' },
          rls
        )
        return fail(
          c,
          'INVALID_MAGIC_BYTES',
          'File yang diunggah bukan GeoTIFF (.tif) yang valid.',
          400
        )
      }
    }

    const updated = await updateImportJobStatus(job.id, 'pending', { errorMessage: null }, rls)
    return ok(c, { job: updated })
  }
)

importsRouter.get('/', requireRole('admin'), async (c) => {
  const rls = getRlsFromContext(c)
  const items = await listImportJobs(rls, 25)
  return ok(c, { items })
})

importsRouter.get('/:id', requireRole('admin'), async (c) => {
  const id = c.req.param('id')
  const rls = getRlsFromContext(c)
  const job = await getImportJobById(id, rls)
  if (!job) {
    return fail(c, 'JOB_NOT_FOUND', 'Import job tidak ditemukan.', 404)
  }
  return ok(c, { job })
})
