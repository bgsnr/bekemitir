import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  deleteSpatialLayer,
  getLayerBySlug,
  listSpatialLayers,
  updateSpatialLayer,
} from '../db/queries/layers'
import { fail, ok } from '../lib/response'
import { getRlsFromContext, requireRole } from '../middleware/auth'
import { zodErrorHook } from '../middleware/error'

export const layersRouter = new Hono()

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const updateLayerSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    description: z.string().max(1000).optional(),
    styleConfig: z
      .record(z.string(), z.unknown())
      .refine(
        (val) => JSON.stringify(val).length <= 32_768,
        'Ukuran styleConfig maksimal 32 KB.'
      )
      .optional(),
    isPublic: z.boolean().optional(),
  })
  .strict()

layersRouter.get('/', async (c) => {
  const rls = getRlsFromContext(c)
  const items = await listSpatialLayers(rls)
  return ok(c, { items })
})

layersRouter.get('/:slug', async (c) => {
  const slug = c.req.param('slug')
  const rls = getRlsFromContext(c)
  const layer = await getLayerBySlug(slug, rls)
  if (!layer) {
    return fail(c, 'LAYER_NOT_FOUND', `Layer spasial "${slug}" tidak ditemukan.`, 404)
  }
  return ok(c, { layer })
})

layersRouter.patch(
  '/:id',
  requireRole('admin'),
  zValidator('json', updateLayerSchema, zodErrorHook),
  async (c) => {
    const id = c.req.param('id')
    if (!UUID_REGEX.test(id)) {
      return fail(c, 'VALIDATION_ERROR', 'Parameter id harus berformat UUID yang valid.', 400)
    }
    const patch = c.req.valid('json')
    const rls = getRlsFromContext(c)

    const updated = await updateSpatialLayer(id, patch, rls)
    if (!updated) {
      return fail(c, 'LAYER_NOT_FOUND', 'Layer spasial tidak ditemukan.', 404)
    }
    return ok(c, { layer: updated })
  }
)

layersRouter.delete('/:id', requireRole('admin'), async (c) => {
  const id = c.req.param('id')
  if (!UUID_REGEX.test(id)) {
    return fail(c, 'VALIDATION_ERROR', 'Parameter id harus berformat UUID yang valid.', 400)
  }
  const rls = getRlsFromContext(c)
  const deleted = await deleteSpatialLayer(id, rls)
  if (!deleted) {
    return fail(c, 'LAYER_NOT_FOUND', 'Layer spasial tidak ditemukan.', 404)
  }
  return ok(c, { deleted: true })
})
