import { Hono } from 'hono'
import { getLayerTileMvt } from '../db/queries/tiles'
import { isValidTileCoord } from '../lib/mvt-lite'
import { fail } from '../lib/response'
import { getRlsFromContext } from '../middleware/auth'

export const tilesRouter = new Hono()

const SLUG_REGEX = /^[a-z0-9-_]{2,64}$/i

/**
 * Endpoint Vector Tiles MVT: GET /api/v1/tiles/:layerSlug/:z/:x/:y.mvt
 * Mendukung ETag / If-None-Match (304 Not Modified dalam O(1)) dan Cache-Control.
 */
tilesRouter.get('/:layerSlug/:z/:x/:yFile', async (c) => {
  const layerSlug = c.req.param('layerSlug')
  const zRaw = c.req.param('z')
  const xRaw = c.req.param('x')
  const yFile = c.req.param('yFile')

  if (!SLUG_REGEX.test(layerSlug)) {
    return fail(c, 'INVALID_LAYER_SLUG', 'Format slug layer tidak valid.', 400)
  }

  if (!yFile.endsWith('.mvt')) {
    return fail(c, 'INVALID_TILE_FORMAT', 'Format tile wajib berakhiran .mvt', 400)
  }

  const z = Number(zRaw)
  const x = Number(xRaw)
  const y = Number(yFile.slice(0, -4))

  if (!isValidTileCoord(z, x, y)) {
    return fail(
      c,
      'INVALID_TILE_COORD',
      'Koordinat tile z/x/y berada di luar rentang Web Mercator yang valid.',
      400
    )
  }

  const rls = getRlsFromContext(c)
  const tileResult = await getLayerTileMvt(layerSlug, z, x, y, rls)
  if (!tileResult) {
    return fail(c, 'LAYER_NOT_FOUND', `Layer vektor "${layerSlug}" tidak ditemukan.`, 404)
  }

  const ifNoneMatch = c.req.header('If-None-Match')
  if (ifNoneMatch && ifNoneMatch === tileResult.etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: tileResult.etag,
        'Cache-Control': 'public, max-age=3600',
        'X-Tile-Cache': tileResult.cacheHit ? 'HIT' : 'MISS',
      },
    })
  }

  const outBuf = new Uint8Array(tileResult.buffer.byteLength)
  outBuf.set(tileResult.buffer)

  return new Response(outBuf, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.mapbox-vector-tile',
      'Cache-Control': 'public, max-age=3600',
      ETag: tileResult.etag,
      'X-Tile-Cache': tileResult.cacheHit ? 'HIT' : 'MISS',
    },
  })
})
