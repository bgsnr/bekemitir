import { beforeEach, describe, expect, test } from 'bun:test'
import { resetSqliteForTests } from '../src/db/client'
import {
  createImportJob,
  updateImportJobStatus,
} from '../src/db/queries/imports'
import { getLayerBySlug } from '../src/db/queries/layers'
import { clearAllTileCache, getLayerTileMvt } from '../src/db/queries/tiles'
import { SEED_IDS, seedDatabase } from '../src/db/seed'
import { lngLatToTileXY } from '../src/lib/mvt-lite'
import { saveLocalUploadObject } from '../src/lib/r2'
import {
  inspectMagicBytes,
  validateShapefileZipTail,
} from '../src/lib/zip-guard'
import { processNextImportJobOnce } from '../src/worker'

interface SyntheticZipEntry {
  name: string
  data: Uint8Array
  overrideCompressedSize?: number
  overrideUncompressedSize?: number
}

/**
 * Helper pembuat arsip ZIP biner (Store / Method 0) di memori untuk pengujian deterministik.
 */
function buildTestZipBuffer(entries: readonly SyntheticZipEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const localParts: Uint8Array[] = []
  const cdParts: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const compSize = entry.overrideCompressedSize ?? entry.data.byteLength
    const uncompSize = entry.overrideUncompressedSize ?? entry.data.byteLength

    // Local File Header (30 bytes + name)
    const localHeader = new Uint8Array(30 + nameBytes.byteLength)
    const lv = new DataView(localHeader.buffer)
    lv.setUint32(0, 0x04034b50, true) // PK\x03\x04
    lv.setUint16(4, 20, true)
    lv.setUint16(8, 0, true) // method 0 (store)
    lv.setUint32(18, compSize, true)
    lv.setUint32(22, uncompSize, true)
    lv.setUint16(26, nameBytes.byteLength, true)
    localHeader.set(nameBytes, 30)

    // Central Directory Header (46 bytes + name)
    const cdHeader = new Uint8Array(46 + nameBytes.byteLength)
    const cv = new DataView(cdHeader.buffer)
    cv.setUint32(0, 0x02014b50, true) // PK\x01\x02
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, 0, true) // method 0
    cv.setUint32(20, compSize, true)
    cv.setUint32(24, uncompSize, true)
    cv.setUint16(28, nameBytes.byteLength, true)
    cv.setUint32(42, offset, true) // local header offset
    cdHeader.set(nameBytes, 46)

    localParts.push(localHeader, entry.data)
    cdParts.push(cdHeader)
    offset += localHeader.byteLength + entry.data.byteLength
  }

  const cdStartOffset = offset
  let cdTotalBytes = 0
  for (const p of cdParts) cdTotalBytes += p.byteLength

  // End of Central Directory (22 bytes)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true) // PK\x05\x06
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdTotalBytes, true)
  ev.setUint32(16, cdStartOffset, true)
  ev.setUint16(20, 0, true)

  const totalLen = cdStartOffset + cdTotalBytes + 22
  const out = new Uint8Array(totalLen)
  let pos = 0
  for (const p of localParts) {
    out.set(p, pos)
    pos += p.byteLength
  }
  for (const p of cdParts) {
    out.set(p, pos)
    pos += p.byteLength
  }
  out.set(eocd, pos)
  return out
}

/**
 * Membangun biner ESRI Point Shapefile (.shp) + dBASE (.dbf) valid untuk 2 titik mata air Desa Kemitir.
 */
function buildSamplePointShapefileBundle(): Uint8Array {
  const points = [
    { lng: 110.292, lat: -7.226, kode: 'MA-01' },
    { lng: 110.305, lat: -7.231, kode: 'MA-02' },
  ]

  // 1. Buat .shp (100 byte header + 2 * (8 byte rec header + 20 byte Point content) = 156 bytes)
  const shp = new Uint8Array(100 + points.length * 28)
  const sv = new DataView(shp.buffer)
  sv.setInt32(0, 9994, false) // File code Big-Endian
  sv.setInt32(24, shp.byteLength / 2, false) // File length in 16-bit words Big-Endian
  sv.setInt32(28, 1000, true) // Version
  sv.setInt32(32, 1, true) // Shape Type = 1 (Point)
  sv.setFloat64(36, 110.292, true)
  sv.setFloat64(44, -7.231, true)
  sv.setFloat64(52, 110.305, true)
  sv.setFloat64(60, -7.226, true)

  let sOff = 100
  for (let i = 0; i < points.length; i++) {
    sv.setInt32(sOff, i + 1, false) // Record number Big-Endian
    sv.setInt32(sOff + 4, 10, false) // Content length = 10 words (20 bytes) Big-Endian
    sv.setInt32(sOff + 8, 1, true) // Shape Type = 1 (Point) Little-Endian
    sv.setFloat64(sOff + 12, points[i].lng, true)
    sv.setFloat64(sOff + 20, points[i].lat, true)
    sOff += 28
  }

  // 2. Buat .dbf dengan 1 kolom karakter 'KODE' (panjang 10 byte)
  const headerLen = 32 + 32 + 1 // 65 bytes
  const recordLen = 1 + 10 // 1 byte deletion flag + 10 byte field KODE
  const dbf = new Uint8Array(headerLen + points.length * recordLen)
  const dv = new DataView(dbf.buffer)
  dbf[0] = 0x03
  dv.setUint32(4, points.length, true)
  dv.setUint16(8, headerLen, true)
  dv.setUint16(10, recordLen, true)

  const enc = new TextEncoder()
  dbf.set(enc.encode('KODE'), 32)
  dbf[32 + 11] = 'C'.charCodeAt(0)
  dbf[32 + 16] = 10
  dbf[64] = 0x0d // Header terminator

  let dOff = headerLen
  for (const pt of points) {
    dbf[dOff] = 0x20 // Not deleted
    const padded = pt.kode.padEnd(10, ' ')
    dbf.set(enc.encode(padded), dOff + 1)
    dOff += recordLen
  }

  const dummyShx = new Uint8Array(100)
  const prjText = enc.encode('GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]')

  return buildTestZipBuffer([
    { name: 'mata_air_kemitir.shp', data: shp },
    { name: 'mata_air_kemitir.shx', data: dummyShx },
    { name: 'mata_air_kemitir.dbf', data: dbf },
    { name: 'mata_air_kemitir.prj', data: prjText },
  ])
}

describe('Chapter 4 — Magic Bytes O(1) & Anti Zip-Bomb / Zip-Slip O(E)', () => {
  test('inspectMagicBytes membedakan ZIP, GeoTIFF, dan file palsu dalam O(1)', () => {
    expect(inspectMagicBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'shapefile_zip')).toBe(true)
    expect(inspectMagicBytes(new Uint8Array([0x49, 0x49, 0x2a, 0x00]), 'geotiff')).toBe(true)
    expect(inspectMagicBytes(new Uint8Array([0x4d, 0x4d, 0x00, 0x2a]), 'geotiff')).toBe(true)
    expect(inspectMagicBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'shapefile_zip')).toBe(false)
    expect(inspectMagicBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'geotiff')).toBe(false)
  })

  test('menolak serangan Zip-Slip (path traversal ../) di dalam Central Directory ZIP', () => {
    const maliciousZip = buildTestZipBuffer([
      { name: '../../etc/cron.d/evil.shp', data: new Uint8Array(16) },
      { name: 'evil.shx', data: new Uint8Array(16) },
      { name: 'evil.dbf', data: new Uint8Array(16) },
      { name: 'evil.prj', data: new Uint8Array(16) },
    ])

    const res = validateShapefileZipTail(
      maliciousZip.subarray(0, 16),
      maliciousZip,
      maliciousZip.byteLength
    )
    expect(res.valid).toBe(false)
    expect(res.code).toBe('ZIP_SLIP_DETECTED')
  })

  test('menolak serangan Zip-Bomb (rasio kompresi > 100:1) tanpa mengekstrak file', () => {
    const bombZip = buildTestZipBuffer([
      {
        name: 'bomb.shp',
        data: new Uint8Array(32),
        overrideCompressedSize: 32,
        overrideUncompressedSize: 32 * 500, // Rasio 500:1 (> batas 100:1)
      },
      { name: 'bomb.shx', data: new Uint8Array(16) },
      { name: 'bomb.dbf', data: new Uint8Array(16) },
      { name: 'bomb.prj', data: new Uint8Array(16) },
    ])

    const res = validateShapefileZipTail(bombZip.subarray(0, 16), bombZip, bombZip.byteLength)
    expect(res.valid).toBe(false)
    expect(res.code).toBe('ZIP_BOMB_DETECTED')
  })

  test('menolak bundel ZIP yang tidak memiliki komponen lengkap (.shp, .shx, .dbf, .prj)', () => {
    const incompleteZip = buildTestZipBuffer([
      { name: 'peta.shp', data: new Uint8Array(32) },
      { name: 'peta.shx', data: new Uint8Array(32) },
      { name: 'peta.dbf', data: new Uint8Array(32) },
      // .prj sengaja dihilangkan
    ])

    const res = validateShapefileZipTail(
      incompleteZip.subarray(0, 16),
      incompleteZip,
      incompleteZip.byteLength
    )
    expect(res.valid).toBe(false)
    expect(res.code).toBe('MISSING_SHAPEFILE_COMPONENTS')
  })

  test('menerima bundel ZIP Shapefile valid yang memiliki .shp, .shx, .dbf, dan .prj', () => {
    const validZip = buildSamplePointShapefileBundle()
    const res = validateShapefileZipTail(validZip.subarray(0, 16), validZip, validZip.byteLength)

    expect(res.valid).toBe(true)
    expect(res.entriesCount).toBe(4)
    expect(res.shapefileBaseName).toBe('mata_air_kemitir')
  })
})

describe('Chapter 4 — Async Worker Execution (Shapefile -> Vector Layer -> MVT)', () => {
  beforeEach(async () => {
    resetSqliteForTests(':memory:')
    clearAllTileCache()
    await seedDatabase()
  })

  test('processNextImportJobOnce mengekstrak Shapefile, menyimpan atribut ke vector_features + R*Tree, dan langsung dapat disajikan sebagai MVT', async () => {
    const adminRls = { userId: SEED_IDS.adminUserId, role: 'admin' as const }
    const jobId = '77777777-7777-4777-8777-777777777701'
    const r2Key = `imports/${jobId}/source.zip`
    const zipBytes = buildSamplePointShapefileBundle()

    await saveLocalUploadObject(r2Key, zipBytes)

    await createImportJob(
      {
        id: jobId,
        layerName: 'Titik Mata Air Desa Kemitir',
        layerSlug: 'mata-air-kemitir',
        fileType: 'shapefile_zip',
        sourceR2Key: r2Key,
        fileSizeBytes: zipBytes.byteLength,
      },
      adminRls
    )

    await updateImportJobStatus(jobId, 'pending', {}, adminRls)

    const processed = await processNextImportJobOnce()
    expect(processed).not.toBeNull()
    expect(processed!.status).toBe('completed')
    expect(processed!.outputLayerId).not.toBeNull()

    const newLayer = await getLayerBySlug('mata-air-kemitir')
    expect(newLayer).not.toBeNull()
    expect(newLayer!.featureCount).toBe(2)
    expect(newLayer!.geometryType).toBe('Point')

    // Pastikan layer baru langsung bisa di-request sebagai Vector Tile (.mvt) lengkap dengan atribut DBF 'KODE'
    const { x, y } = lngLatToTileXY(110.292, -7.226, 14)
    const tile = await getLayerTileMvt('mata-air-kemitir', 14, x, y)
    expect(tile).not.toBeNull()
    expect(tile!.buffer.byteLength).toBeGreaterThan(15)

    const decodedText = new TextDecoder().decode(tile!.buffer)
    expect(decodedText).toContain('mata-air-kemitir')
    expect(decodedText).toContain('MA-01')
  })
})
