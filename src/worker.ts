import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claimNextPendingImportJob,
  ingestConvertedVectorLayer,
  registerRasterPmTilesLayer,
  updateImportJobStatus,
  type ImportJobRecord,
} from './db/queries/imports'
import { convertGeoTiffToPmTiles, convertShapefileZipToGeoJson } from './lib/gdal'
import { downloadObjectToFile, uploadFileToR2 } from './lib/r2'
import { inspectMagicBytes, validateShapefileZipTail } from './lib/zip-guard'

/**
 * Memproses tepat 1 import job berstatus 'pending' dari antrean.
 * Mengembalikan job yang telah diproses (completed / failed), atau null jika antrean kosong.
 */
export async function processNextImportJobOnce(): Promise<ImportJobRecord | null> {
  const job = await claimNextPendingImportJob()
  if (!job) return null

  const workDir = join(tmpdir(), `bekemitir-job-${job.id}`)
  mkdirSync(workDir, { recursive: true })

  try {
    const ext = job.fileType === 'shapefile_zip' ? 'zip' : 'tif'
    const localSourcePath = join(workDir, `source.${ext}`)
    await downloadObjectToFile(job.sourceR2Key, localSourcePath)

    const sourceFile = Bun.file(localSourcePath)
    const totalSize = sourceFile.size

    if (job.fileType === 'shapefile_zip') {
      const headerBuf = new Uint8Array(await sourceFile.slice(0, Math.min(16, totalSize)).arrayBuffer())
      const tailStart = Math.max(0, totalSize - 65536)
      const tailBuf = new Uint8Array(await sourceFile.slice(tailStart, totalSize).arrayBuffer())

      const zipCheck = validateShapefileZipTail(headerBuf, tailBuf, totalSize)
      if (!zipCheck.valid) {
        throw new Error(`[${zipCheck.code}] ${zipCheck.message}`)
      }

      const dataset = await convertShapefileZipToGeoJson(localSourcePath, workDir)
      const outputLayerId = await ingestConvertedVectorLayer(job, dataset)

      return await updateImportJobStatus(job.id, 'completed', {
        outputLayerId,
        errorMessage: null,
      })
    }

    // GeoTIFF (.tif) -> PMTiles di R2
    const headerBuf = new Uint8Array(await sourceFile.slice(0, Math.min(16, totalSize)).arrayBuffer())
    if (!inspectMagicBytes(headerBuf, 'geotiff')) {
      throw new Error('[INVALID_MAGIC_BYTES] File bukan GeoTIFF yang valid.')
    }

    const { outputFilePath } = await convertGeoTiffToPmTiles(localSourcePath, workDir)
    const pmtilesR2Key = `pmtiles/${job.layerSlug}-${job.id.slice(0, 8)}.pmtiles`
    await uploadFileToR2(outputFilePath, pmtilesR2Key)

    const outputLayerId = await registerRasterPmTilesLayer(job, pmtilesR2Key)
    return await updateImportJobStatus(job.id, 'completed', {
      outputLayerId,
      errorMessage: null,
    })
  } catch (err) {
    const safeMsg = err instanceof Error ? err.message.slice(0, 500) : 'Gagal memproses file import.'
    return await updateImportJobStatus(job.id, 'failed', {
      errorMessage: safeMsg,
    })
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      // Abaikan kegagalan pembersihan direktori sementara
    }
  }
}

/**
 * Menjalankan loop background worker dengan backoff ringan saat antrean kosong.
 */
export async function startImportWorkerLoop(signal?: AbortSignal): Promise<void> {
  console.log('[WORKER] Memulai async import worker (Shapefile & GeoTIFF)...')
  while (!signal?.aborted) {
    try {
      const processed = await processNextImportJobOnce()
      if (processed) {
        console.log(`[WORKER] Job ${processed.id} (${processed.layerSlug}) -> ${processed.status}`)
        continue // Segera cek job berikutnya tanpa delay jika baru saja ada job
      }
    } catch (err) {
      console.error('[WORKER LOOP ERROR]', err)
    }
    await Bun.sleep(2000)
  }
}

if (import.meta.main) {
  startImportWorkerLoop()
}
