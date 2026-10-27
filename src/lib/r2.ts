import { AwsClient } from 'aws4fetch'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { config } from '../config'
import type { ImportFileType } from './zip-guard'

let r2ClientSingleton: AwsClient | null = null

function getR2Client(): AwsClient {
  if (r2ClientSingleton) return r2ClientSingleton
  if (!config.isR2Configured) {
    throw new Error('Kredensial Cloudflare R2 belum dikonfigurasi.')
  }
  r2ClientSingleton = new AwsClient({
    accessKeyId: config.R2_ACCESS_KEY_ID!,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY!,
    service: 's3',
    region: 'auto',
  })
  return r2ClientSingleton
}

function getR2EndpointUrl(objectKey: string): string {
  const cleanKey = objectKey.replace(/^\/+/, '')
  return `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${config.R2_BUCKET_NAME}/${cleanKey}`
}

export function getLocalStoragePath(objectKey: string): string {
  // Sanitasi agar objectKey tidak pernah keluar dari LOCAL_UPLOAD_DIR
  const safeKey = objectKey.replace(/\.\./g, '').replace(/^[/\\]+/, '')
  return resolve(config.LOCAL_UPLOAD_DIR, safeKey)
}

/**
 * Membuat Presigned PUT URL untuk upload file import (.zip Shapefile atau .tif GeoTIFF).
 * Jika R2 belum dikonfigurasi (mode uji coba lokal), mengembalikan endpoint upload lokal.
 */
export async function createImportUploadTarget(params: {
  jobId: string
  fileType: ImportFileType
}): Promise<{ r2Key: string; uploadUrl: string; expiresInSeconds: number }> {
  const ext = params.fileType === 'shapefile_zip' ? 'zip' : 'tif'
  const r2Key = `imports/${params.jobId}/source.${ext}`
  const expiresInSeconds = 900

  if (!config.isR2Configured) {
    return {
      r2Key,
      uploadUrl: `/api/v1/imports/${params.jobId}/local-upload`,
      expiresInSeconds,
    }
  }

  const client = getR2Client()
  const url = new URL(getR2EndpointUrl(r2Key))
  url.searchParams.set('X-Amz-Expires', String(expiresInSeconds))

  const signedReq = await client.sign(
    new Request(url.toString(), {
      method: 'PUT',
    }),
    { aws: { signQuery: true } }
  )

  return {
    r2Key,
    uploadUrl: signedReq.url,
    expiresInSeconds,
  }
}

/**
 * Membuat Presigned PUT URL untuk foto observasi lapangan dari mobile app.
 */
export async function createPhotoUploadTarget(params: {
  userId: string
  contentType: 'image/jpeg' | 'image/png' | 'image/webp'
}): Promise<{ r2Key: string; uploadUrl: string; expiresInSeconds: number }> {
  const ext =
    params.contentType === 'image/png'
      ? 'png'
      : params.contentType === 'image/webp'
        ? 'webp'
        : 'jpg'
  const photoId = crypto.randomUUID()
  const r2Key = `photos/${params.userId}/${photoId}.${ext}`
  const expiresInSeconds = 900

  if (!config.isR2Configured) {
    return {
      r2Key,
      uploadUrl: `/api/v1/observations/local-photo-upload?key=${encodeURIComponent(r2Key)}`,
      expiresInSeconds,
    }
  }

  const client = getR2Client()
  const url = new URL(getR2EndpointUrl(r2Key))
  url.searchParams.set('X-Amz-Expires', String(expiresInSeconds))

  const signedReq = await client.sign(
    new Request(url.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': params.contentType },
    }),
    { aws: { signQuery: true } }
  )

  return {
    r2Key,
    uploadUrl: signedReq.url,
    expiresInSeconds,
  }
}

/**
 * Membaca hanya 16 byte pertama (magic bytes) dan 64 KB terakhir (EOCD ZIP)
 * dalam memori O(1) tanpa mengunduh seluruh file ke RAM server API.
 */
export async function readObjectHeaderAndTail(
  r2Key: string,
  maxTailBytes = 65536
): Promise<{ headerBytes: Uint8Array; tailBytes: Uint8Array; totalSize: number } | null> {
  if (!config.isR2Configured) {
    const filePath = getLocalStoragePath(r2Key)
    const file = Bun.file(filePath)
    if (!(await file.exists())) return null

    const totalSize = file.size
    if (totalSize < 4) return null

    const headerEnd = Math.min(16, totalSize)
    const tailStart = Math.max(0, totalSize - maxTailBytes)

    const [headerBuf, tailBuf] = await Promise.all([
      file.slice(0, headerEnd).arrayBuffer(),
      file.slice(tailStart, totalSize).arrayBuffer(),
    ])

    return {
      headerBytes: new Uint8Array(headerBuf),
      tailBytes: new Uint8Array(tailBuf),
      totalSize,
    }
  }

  const client = getR2Client()
  const endpointUrl = getR2EndpointUrl(r2Key)

  const headRes = await client.fetch(endpointUrl, { method: 'HEAD' })
  if (!headRes.ok) return null
  const totalSize = Number(headRes.headers.get('content-length') ?? 0)
  if (totalSize < 4) return null

  const headerEnd = Math.min(15, totalSize - 1)
  const tailStart = Math.max(0, totalSize - maxTailBytes)

  const [headerRes, tailRes] = await Promise.all([
    client.fetch(endpointUrl, {
      method: 'GET',
      headers: { Range: `bytes=0-${headerEnd}` },
    }),
    client.fetch(endpointUrl, {
      method: 'GET',
      headers: { Range: `bytes=${tailStart}-${totalSize - 1}` },
    }),
  ])

  if (!headerRes.ok || !tailRes.ok) return null

  const [headerBuf, tailBuf] = await Promise.all([
    headerRes.arrayBuffer(),
    tailRes.arrayBuffer(),
  ])

  return {
    headerBytes: new Uint8Array(headerBuf),
    tailBytes: new Uint8Array(tailBuf),
    totalSize,
  }
}

/**
 * Menyimpan buffer ke penyimpanan lokal (digunakan pada mode uji coba lokal).
 */
export async function saveLocalUploadObject(r2Key: string, data: Uint8Array): Promise<void> {
  const destPath = getLocalStoragePath(r2Key)
  mkdirSync(dirname(destPath), { recursive: true })
  await Bun.write(destPath, data)
}

/**
 * Mengunduh objek dari R2 (atau menyalin dari lokal) ke file kerja worker.
 */
export async function downloadObjectToFile(r2Key: string, destPath: string): Promise<void> {
  mkdirSync(dirname(destPath), { recursive: true })

  if (!config.isR2Configured) {
    const srcPath = getLocalStoragePath(r2Key)
    const srcFile = Bun.file(srcPath)
    if (!(await srcFile.exists())) {
      throw new Error(`File sumber lokal tidak ditemukan: ${r2Key}`)
    }
    await Bun.write(destPath, srcFile)
    return
  }

  const client = getR2Client()
  const res = await client.fetch(getR2EndpointUrl(r2Key), { method: 'GET' })
  if (!res.ok) {
    throw new Error(`Gagal mengunduh objek R2 (${res.status}): ${r2Key}`)
  }
  await Bun.write(destPath, res)
}

/**
 * Mengunggah file hasil konversi (mis. .pmtiles) ke R2 dengan header Cache-Control immutable.
 */
export async function uploadFileToR2(
  localPath: string,
  r2Key: string,
  contentType = 'application/vnd.pmtiles',
  cacheControl = 'public, max-age=31536000, immutable'
): Promise<void> {
  const file = Bun.file(localPath)
  if (!(await file.exists())) {
    throw new Error(`File lokal untuk diunggah tidak ditemukan: ${localPath}`)
  }

  if (!config.isR2Configured) {
    const destPath = getLocalStoragePath(r2Key)
    mkdirSync(dirname(destPath), { recursive: true })
    await Bun.write(destPath, file)
    return
  }

  const client = getR2Client()
  const res = await client.fetch(getR2EndpointUrl(r2Key), {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
    },
    body: await file.arrayBuffer(),
  })

  if (!res.ok) {
    throw new Error(`Gagal mengunggah objek ke R2 (${res.status}): ${r2Key}`)
  }
}
