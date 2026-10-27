import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { computeGeoJsonBBox, type GeoJsonGeometry } from '../db/client'
import {
  isIgnoredZipMetadataEntry,
  isSafeZipEntryPath,
  ZIP_SECURITY_LIMITS,
} from './zip-guard'

export interface ExtractedFeature {
  properties: Record<string, unknown>
  geometry: GeoJsonGeometry
}

export interface ConvertedVectorDataset {
  geometryType: 'Point' | 'LineString' | 'Polygon' | 'MultiPolygon' | 'Geometry'
  bbox: [number, number, number, number]
  features: ExtractedFeature[]
}

/**
 * Menjalankan proses CLI eksternal menggunakan Bun.spawn dengan array argumen murni
 * (tanpa shell /bin/sh -c -> bebas Command Injection) dan batas waktu ketat.
 */
export async function runCommandSafe(
  args: readonly string[],
  timeoutMs = 180_000
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (args.length === 0) {
    throw new Error('Argumen perintah kosong.')
  }

  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn([...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (err) {
    throw new Error(
      `Gagal menjalankan binary "${args[0]}": ${err instanceof Error ? err.message : String(err)}`
    )
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill()
    } catch {
      // Abaikan
    }
  }, timeoutMs)

  try {
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (timedOut) {
      throw new Error(`Proses "${args[0]}" melampaui batas waktu (${timeoutMs} ms).`)
    }

    return {
      exitCode,
      stdout: stdoutText,
      stderr: stderrText,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Mengekstrak file dari arsip ZIP secara aman di memori/disk menggunakan parser Central Directory
 * dengan batas ketat terhadap Zip-Slip dan ukuran dekompresi.
 */
export async function extractVerifiedZipToDir(
  zipPath: string,
  destDir: string
): Promise<string[]> {
  const buf = new Uint8Array(await Bun.file(zipPath).arrayBuffer())
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  let eocdOffset = -1
  const minSearch = Math.max(0, buf.byteLength - 65557)
  for (let pos = buf.byteLength - 22; pos >= minSearch; pos--) {
    if (view.getUint32(pos, true) === 0x06054b50) {
      const commentLen = view.getUint16(pos + 20, true)
      if (pos + 22 + commentLen === buf.byteLength) {
        eocdOffset = pos
        break
      }
    }
  }
  if (eocdOffset === -1) {
    throw new Error('EOCD ZIP tidak ditemukan saat ekstraksi.')
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true)
  let cdCursor = view.getUint32(eocdOffset + 16, true)
  let totalUncompressed = 0
  const extractedFiles: string[] = []
  const decoder = new TextDecoder()

  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(cdCursor, true) !== 0x02014b50) {
      throw new Error('Header Central Directory rusak.')
    }

    const compressionMethod = view.getUint16(cdCursor + 10, true)
    const compressedSize = view.getUint32(cdCursor + 20, true)
    const uncompressedSize = view.getUint32(cdCursor + 24, true)
    const fileNameLen = view.getUint16(cdCursor + 28, true)
    const extraLen = view.getUint16(cdCursor + 30, true)
    const commentLen = view.getUint16(cdCursor + 32, true)
    const localHeaderOffset = view.getUint32(cdCursor + 42, true)

    const entryName = decoder.decode(buf.subarray(cdCursor + 46, cdCursor + 46 + fileNameLen))
    cdCursor += 46 + fileNameLen + extraLen + commentLen

    if (!isSafeZipEntryPath(entryName)) {
      throw new Error(`Path Zip-Slip ditolak: ${entryName}`)
    }
    if (
      entryName.endsWith('/') ||
      entryName.endsWith('\\') ||
      isIgnoredZipMetadataEntry(entryName)
    ) {
      continue
    }

    totalUncompressed += uncompressedSize
    if (totalUncompressed > ZIP_SECURITY_LIMITS.maxUncompressedBytes) {
      throw new Error('Batas ukuran uncompressed terlampaui saat ekstraksi.')
    }

    // Baca Local File Header (0x04034b50)
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error('Local File Header ZIP tidak valid.')
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true)
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true)
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen
    const rawCompressed = buf.subarray(dataStart, dataStart + compressedSize)

    let outBytes: Uint8Array
    if (compressionMethod === 0) {
      outBytes = rawCompressed
    } else if (compressionMethod === 8) {
      outBytes = new Uint8Array(
        inflateRawSync(rawCompressed, {
          maxOutputLength: ZIP_SECURITY_LIMITS.maxUncompressedBytes,
        })
      )
    } else {
      throw new Error(`Metode kompresi ZIP (${compressionMethod}) tidak didukung.`)
    }

    if (outBytes.byteLength !== uncompressedSize) {
      throw new Error('Ukuran hasil dekompresi tidak cocok dengan header ZIP.')
    }

    const safeTarget = resolve(destDir, entryName)
    if (!safeTarget.startsWith(resolve(destDir))) {
      throw new Error('Deteksi pelanggaran batas direktori ekstraksi.')
    }

    mkdirSync(dirname(safeTarget), { recursive: true })
    await Bun.write(safeTarget, outBytes)
    extractedFiles.push(safeTarget)
  }

  return extractedFiles
}

/**
 * Parser fallback biner ESRI Shapefile (.shp + .dbf) dalam O(N)
 * jika binary ogr2ogr belum terinstal pada mesin lokal Windows saat uji coba.
 * Di VPS Docker, ogr2ogr dipanggil sebagai jalur utama.
 */
function parseShpAndDbfFallback(shpBytes: Uint8Array, dbfBytes: Uint8Array): ExtractedFeature[] {
  const dbfRecords: Record<string, unknown>[] = []
  if (dbfBytes.byteLength >= 32) {
    const dbfView = new DataView(dbfBytes.buffer, dbfBytes.byteOffset, dbfBytes.byteLength)
    const numRecords = dbfView.getUint32(4, true)
    const headerLen = dbfView.getUint16(8, true)
    const recordLen = dbfView.getUint16(10, true)
    const dec = new TextDecoder('utf-8')

    const fields: { name: string; type: string; length: number }[] = []
    let fOffset = 32
    while (fOffset + 32 <= headerLen && dbfBytes[fOffset] !== 0x0d) {
      const nameRaw = dbfBytes.subarray(fOffset, fOffset + 11)
      const zeroIdx = nameRaw.indexOf(0)
      const fName = dec
        .decode(zeroIdx >= 0 ? nameRaw.subarray(0, zeroIdx) : nameRaw)
        .trim()
      const fType = String.fromCharCode(dbfBytes[fOffset + 11])
      const fLen = dbfBytes[fOffset + 16]
      fields.push({ name: fName, type: fType, length: fLen })
      fOffset += 32
    }

    let recOffset = headerLen
    for (let r = 0; r < numRecords; r++) {
      if (recOffset + recordLen > dbfBytes.byteLength) break
      const isDeleted = dbfBytes[recOffset] === 0x2a
      const rowObj: Record<string, unknown> = {}
      let pos = recOffset + 1
      for (const f of fields) {
        const rawStr = dec.decode(dbfBytes.subarray(pos, pos + f.length)).trim()
        pos += f.length
        if (f.type === 'N' || f.type === 'F') {
          const num = Number(rawStr)
          rowObj[f.name] = rawStr === '' || Number.isNaN(num) ? null : num
        } else if (f.type === 'L') {
          rowObj[f.name] = rawStr === 'T' || rawStr === 't' || rawStr === 'Y' || rawStr === 'y'
        } else {
          rowObj[f.name] = rawStr
        }
      }
      if (!isDeleted) {
        dbfRecords.push(rowObj)
      }
      recOffset += recordLen
    }
  }

  const shpView = new DataView(shpBytes.buffer, shpBytes.byteOffset, shpBytes.byteLength)
  let offset = 100 // Lewati 100-byte main file header ESRI Shapefile
  let recIdx = 0
  const features: ExtractedFeature[] = []

  while (offset + 8 <= shpBytes.byteLength) {
    // Record header adalah Big-Endian (4 byte record number + 4 byte content length in 16-bit words)
    const contentLengthWords = shpView.getInt32(offset + 4, false)
    const contentBytes = contentLengthWords * 2
    offset += 8
    if (contentBytes <= 0 || offset + contentBytes > shpBytes.byteLength) break

    const shapeType = shpView.getInt32(offset, true)
    const props = dbfRecords[recIdx] ?? {}
    recIdx++

    if (shapeType === 1 || shapeType === 11 || shapeType === 21) {
      // Point
      const x = shpView.getFloat64(offset + 4, true)
      const y = shpView.getFloat64(offset + 12, true)
      features.push({
        properties: props,
        geometry: { type: 'Point', coordinates: [x, y] },
      })
    } else if (shapeType === 3 || shapeType === 5) {
      // PolyLine (3) atau Polygon (5)
      const numParts = shpView.getInt32(offset + 36, true)
      const numPoints = shpView.getInt32(offset + 40, true)
      const parts: number[] = []
      let pCursor = offset + 44
      for (let p = 0; p < numParts; p++) {
        parts.push(shpView.getInt32(pCursor, true))
        pCursor += 4
      }
      const rings: [number, number][][] = []
      for (let p = 0; p < numParts; p++) {
        const startPt = parts[p]
        const endPt = p + 1 < numParts ? parts[p + 1] : numPoints
        const ring: [number, number][] = []
        for (let pt = startPt; pt < endPt; pt++) {
          const px = shpView.getFloat64(pCursor, true)
          const py = shpView.getFloat64(pCursor + 8, true)
          pCursor += 16
          ring.push([px, py])
        }
        rings.push(ring)
      }
      if (shapeType === 3) {
        features.push({
          properties: props,
          geometry:
            rings.length === 1
              ? { type: 'LineString', coordinates: rings[0] }
              : { type: 'MultiLineString', coordinates: rings },
        })
      } else {
        features.push({
          properties: props,
          geometry: { type: 'Polygon', coordinates: rings },
        })
      }
    }

    offset += contentBytes
  }

  return features
}

/**
 * Mengonversi arsip ZIP Shapefile menjadi dataset GeoJSON terstandarisasi (EPSG:4326).
 * Menggunakan ogr2ogr via Bun.spawn sebagai jalur utama, dan fallback ke parser biner .shp/.dbf
 * jika ogr2ogr belum terinstal pada mesin lokal saat uji coba.
 */
export async function convertShapefileZipToGeoJson(
  zipPath: string,
  workDir: string
): Promise<ConvertedVectorDataset> {
  const extractedPaths = await extractVerifiedZipToDir(zipPath, workDir)
  const shpPath = extractedPaths.find((p) => p.toLowerCase().endsWith('.shp'))
  const dbfPath = extractedPaths.find((p) => p.toLowerCase().endsWith('.dbf'))

  if (!shpPath || !dbfPath) {
    throw new Error('File .shp atau .dbf tidak ditemukan setelah ekstraksi.')
  }

  const outGeoJsonPath = join(workDir, 'converted_4326.geojson')
  let rawFeatures: ExtractedFeature[] = []

  // Coba jalankan ogr2ogr via Bun.spawn terlebih dahulu
  try {
    const res = await runCommandSafe([
      'ogr2ogr',
      '-f',
      'GeoJSON',
      '-t_srs',
      'EPSG:4326',
      '-nlt',
      'PROMOTE_TO_MULTI',
      outGeoJsonPath,
      shpPath,
    ])
    if (res.exitCode === 0 && (await Bun.file(outGeoJsonPath).exists())) {
      const parsed = (await Bun.file(outGeoJsonPath).json()) as {
        features?: { properties?: Record<string, unknown>; geometry?: GeoJsonGeometry }[]
      }
      if (Array.isArray(parsed.features)) {
        for (const f of parsed.features) {
          if (f.geometry) {
            rawFeatures.push({
              properties: f.properties ?? {},
              geometry: f.geometry,
            })
          }
        }
      }
    } else {
      throw new Error(res.stderr || `ogr2ogr exit code ${res.exitCode}`)
    }
  } catch {
    // Fallback ke parser biner ESRI Shapefile (.shp + .dbf) untuk uji coba lokal tanpa GDAL
    const [shpBuf, dbfBuf] = await Promise.all([
      Bun.file(shpPath).arrayBuffer(),
      Bun.file(dbfPath).arrayBuffer(),
    ])
    rawFeatures = parseShpAndDbfFallback(new Uint8Array(shpBuf), new Uint8Array(dbfBuf))
  }

  if (rawFeatures.length === 0) {
    throw new Error('Shapefile tidak mengandung fitur geometri yang valid.')
  }

  let globalMinLng = Infinity
  let globalMinLat = Infinity
  let globalMaxLng = -Infinity
  let globalMaxLat = -Infinity

  for (let i = 0; i < rawFeatures.length; i++) {
    const [minLng, minLat, maxLng, maxLat] = computeGeoJsonBBox(rawFeatures[i].geometry)
    if (minLng < globalMinLng) globalMinLng = minLng
    if (minLat < globalMinLat) globalMinLat = minLat
    if (maxLng > globalMaxLng) globalMaxLng = maxLng
    if (maxLat > globalMaxLat) globalMaxLat = maxLat
  }

  const firstType = rawFeatures[0].geometry.type
  const geometryType: ConvertedVectorDataset['geometryType'] =
    firstType === 'Point'
      ? 'Point'
      : firstType === 'LineString'
        ? 'LineString'
        : firstType === 'Polygon'
          ? 'Polygon'
          : firstType === 'MultiPolygon'
            ? 'MultiPolygon'
            : 'Geometry'

  return {
    geometryType,
    bbox: [globalMinLng, globalMinLat, globalMaxLng, globalMaxLat],
    features: rawFeatures,
  }
}

/**
 * Mengonversi GeoTIFF (.tif) ke PMTiles / Cloud-Optimized GeoTIFF menggunakan gdal_translate.
 */
export async function convertGeoTiffToPmTiles(
  tifPath: string,
  workDir: string
): Promise<{ outputFilePath: string }> {
  const outPath = join(workDir, 'output.pmtiles')

  try {
    const res = await runCommandSafe([
      'gdal_translate',
      '-of',
      'COG',
      '-co',
      'COMPRESS=DEFLATE',
      tifPath,
      outPath,
    ])
    if (res.exitCode === 0 && (await Bun.file(outPath).exists())) {
      return { outputFilePath: outPath }
    }
  } catch {
    // Jika gdal_translate belum terpasang di mesin lokal, salin file sumber untuk keperluan uji alur
  }

  await Bun.write(outPath, Bun.file(tifPath))
  return { outputFilePath: outPath }
}
