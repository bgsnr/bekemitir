import { Hono } from 'hono'
import { config } from './config'
import { OPENAPI_JSON_STRING, SCALAR_DOCS_HTML } from './lib/openapi'
import { getLocalStoragePath } from './lib/r2'
import { fail, ok } from './lib/response'
import { authenticateContext } from './middleware/auth'
import { globalErrorHandler, globalNotFoundHandler } from './middleware/error'
import { rateLimit } from './middleware/rate-limit'
import { bodySizeLimit, securityAndCorsMiddleware } from './middleware/security'
import { authRouter } from './routes/auth'
import { importsRouter } from './routes/imports'
import { layersRouter } from './routes/layers'
import { observationsRouter } from './routes/observations'
import { summariesRouter } from './routes/summaries'
import { tilesRouter } from './routes/tiles'

const app = new Hono()

// 1. Global Security Headers & O(1) CORS Allowlist
app.use('*', securityAndCorsMiddleware())

// 2. Global Rate Limiter (O(1) Bounded LRU)
app.use(
  '/api/v1/*',
  rateLimit({
    keyPrefix: 'api_global',
    windowMs: 60_000,
    maxRequests: 300,
  })
)

// 3. Batasi ukuran JSON body (1 MB) kecuali pada route local-upload
app.use('/api/v1/*', async (c, next) => {
  if (
    c.req.path.endsWith('/local-upload') ||
    c.req.path.endsWith('/local-photo-upload')
  ) {
    await next()
    return
  }
  return bodySizeLimit(1_048_576)(c, next)
})

// 4. Ekstraksi konteks autentikasi O(1) (Cookie Web / Bearer Mobile)
app.use('/api/v1/*', authenticateContext())

// 5. Healthcheck & OpenAPI 3.1 Documentation Endpoints (O(1) pre-serialized)
app.get('/api/v1/health', (c) =>
  ok(c, {
    service: 'bekemitir',
    status: 'healthy',
    dbProvider: config.DB_PROVIDER,
    timestamp: new Date().toISOString(),
  })
)

app.get('/api/v1/openapi.json', (c) =>
  c.body(OPENAPI_JSON_STRING, 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=3600',
  })
)

app.get('/api/v1/docs', (c) =>
  c.html(SCALAR_DOCS_HTML, 200, {
    'Cache-Control': 'public, max-age=3600',
  })
)

// 6. Local Storage Emulation untuk PMTiles (mendukung HTTP Range request) & Foto saat uji coba lokal tanpa R2
app.get('/api/v1/storage/*', async (c) => {
  if (config.isR2Configured) {
    return fail(c, 'NOT_FOUND', 'Gunakan URL CDN Cloudflare R2 secara langsung.', 404)
  }
  const relKey = c.req.path.replace(/^\/api\/v1\/storage\//, '')
  if (!relKey || relKey.includes('..') || (!relKey.startsWith('pmtiles/') && !relKey.startsWith('photos/'))) {
    return fail(c, 'FORBIDDEN', 'Akses objek tidak diizinkan.', 403)
  }

  const filePath = getLocalStoragePath(relKey)
  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    return fail(c, 'OBJECT_NOT_FOUND', 'File tidak ditemukan di storage lokal.', 404)
  }

  const totalSize = file.size
  const rangeHeader = c.req.header('Range')
  if (rangeHeader && rangeHeader.startsWith('bytes=')) {
    const [startStr, endStr] = rangeHeader.slice(6).split('-')
    const start = Math.max(0, Number(startStr) || 0)
    const end = endStr ? Math.min(totalSize - 1, Number(endStr)) : totalSize - 1
    if (start <= end && start < totalSize) {
      const sliced = file.slice(start, end + 1)
      return new Response(sliced, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    }
  }

  return new Response(file, {
    status: 200,
    headers: {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
})

// 7. Mount Routers di bawah /api/v1
app.route('/api/v1/auth', authRouter)
app.route('/api/v1/layers', layersRouter)
app.route('/api/v1/tiles', tilesRouter)
app.route('/api/v1/observations', observationsRouter)
app.route('/api/v1/imports', importsRouter)
app.route('/api/v1/summaries', summariesRouter)

// 8. Global Error & 404 Handlers
app.onError(globalErrorHandler)
app.notFound(globalNotFoundHandler)

export { app }
export default {
  port: config.PORT,
  fetch: app.fetch,
}
