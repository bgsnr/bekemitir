export type ImportFileType = 'shapefile_zip' | 'geotiff'

export type ZipValidationErrorCode =
  | 'INVALID_MAGIC_BYTES'
  | 'CORRUPT_ZIP_EOCD'
  | 'TOO_MANY_FILES'
  | 'ZIP_SLIP_DETECTED'
  | 'ZIP_BOMB_DETECTED'
  | 'UNCOMPRESSED_LIMIT_EXCEEDED'
  | 'MISSING_SHAPEFILE_COMPONENTS'

export interface ZipValidationResult {
  valid: boolean
  code?: ZipValidationErrorCode
  message?: string
  entriesCount?: number
  totalUncompressedBytes?: number
  shapefileBaseName?: string
}

export const ZIP_SECURITY_LIMITS = Object.freeze({
  maxEntries: 30,
  maxUncompressedBytes: 250 * 1024 * 1024, // 250 MB
  maxCompressionRatio: 100,
  requiredShapefileExtensions: ['.shp', '.shx', '.dbf', '.prj'] as const,
})

const decoder = new TextDecoder('utf-8', { fatal: false })

/**
 * Memeriksa 4 byte pertama (magic bytes) dalam waktu O(1).
 * - ZIP: 50 4B 03 04 (PK\x03\x04)
 * - GeoTIFF: 49 49 2A 00 (II*\0), 4D 4D 00 2A (MM\0*), atau BigTIFF (2B)
 */
export function inspectMagicBytes(
  headerBytes: Uint8Array,
  expectedType: ImportFileType
): boolean {
  if (headerBytes.byteLength < 4) return false
  const b0 = headerBytes[0]
  const b1 = headerBytes[1]
  const b2 = headerBytes[2]
  const b3 = headerBytes[3]

  if (expectedType === 'shapefile_zip') {
    return b0 === 0x50 && b1 === 0x4b && b2 === 0x03 && b3 === 0x04
  }

  // GeoTIFF (Little-Endian II*\0 / II+\0 atau Big-Endian MM\0* / MM\0+)
  const isLittleEndianTiff =
    b0 === 0x49 && b1 === 0x49 && (b2 === 0x2a || b2 === 0x2b) && b3 === 0x00
  const isBigEndianTiff =
    b0 === 0x4d && b1 === 0x4d && b2 === 0x00 && (b3 === 0x2a || b3 === 0x2b)

  return isLittleEndianTiff || isBigEndianTiff
}

/**
 * Memeriksa apakah path di dalam arsip ZIP aman dari serangan Zip-Slip dalam O(L) (L = panjang nama file).
 */
export function isSafeZipEntryPath(entryPath: string): boolean {
  if (!entryPath || entryPath.length > 512) return false
  if (entryPath.includes('\0')) return false
  if (entryPath.startsWith('/') || entryPath.startsWith('\\')) return false
  if (entryPath.includes(':')) return false // Cegah drive letter Windows (mis. C:\...)

  const segments = entryPath.split(/[\\/]/)
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === '..') {
      return false
    }
  }
  return true
}

/**
 * Mengidentifikasi file sampah metadata OS (seperti __MACOSX/, ._* AppleDouble, .DS_Store, Thumbs.db)
 * dalam waktu O(1) agar tidak merusak deteksi komponen Shapefile.
 */
export function isIgnoredZipMetadataEntry(entryPath: string): boolean {
  const normalized = entryPath.replace(/\\/g, '/')
  if (normalized.startsWith('__MACOSX/') || normalized.includes('/__MACOSX/')) {
    return true
  }
  const lastSlash = normalized.lastIndexOf('/')
  const baseFile = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized
  if (!baseFile) return true
  if (baseFile.startsWith('._')) return true
  const lower = baseFile.toLowerCase()
  return lower === '.ds_store' || lower === 'thumbs.db' || lower === 'desktop.ini'
}

/**
 * Memvalidasi struktur Central Directory ZIP dalam waktu O(E) (E <= 30 file entry)
 * dan memori O(1) (hanya membaca buffer tail <= 64 KB) TANPA mengekstrak isi file.
 * Menangkal Zip-Bomb, Zip-Slip, dan memastikan keberadaan .shp, .shx, .dbf, dan .prj.
 */
export function validateShapefileZipTail(
  headerBytes: Uint8Array,
  tailBytes: Uint8Array,
  totalFileSize: number
): ZipValidationResult {
  if (!inspectMagicBytes(headerBytes, 'shapefile_zip')) {
    return {
      valid: false,
      code: 'INVALID_MAGIC_BYTES',
      message: 'File bukan arsip ZIP yang valid (magic bytes tidak cocok).',
    }
  }

  if (tailBytes.byteLength < 22) {
    return {
      valid: false,
      code: 'CORRUPT_ZIP_EOCD',
      message: 'Arsip ZIP rusak atau terlalu pendek (EOCD tidak ditemukan).',
    }
  }

  const view = new DataView(tailBytes.buffer, tailBytes.byteOffset, tailBytes.byteLength)

  // Cari signature End of Central Directory (0x06054b50) dari belakang
  let eocdOffset = -1
  const minSearchOffset = Math.max(0, tailBytes.byteLength - 65557)
  for (let pos = tailBytes.byteLength - 22; pos >= minSearchOffset; pos--) {
    if (view.getUint32(pos, true) === 0x06054b50) {
      const commentLen = view.getUint16(pos + 20, true)
      if (pos + 22 + commentLen === tailBytes.byteLength) {
        eocdOffset = pos
        break
      }
    }
  }

  if (eocdOffset === -1) {
    return {
      valid: false,
      code: 'CORRUPT_ZIP_EOCD',
      message: 'Signature End of Central Directory (EOCD) ZIP tidak ditemukan.',
    }
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true)
  const cdSizeBytes = view.getUint32(eocdOffset + 12, true)
  const cdAbsOffset = view.getUint32(eocdOffset + 16, true)

  if (totalEntries === 0) {
    return {
      valid: false,
      code: 'MISSING_SHAPEFILE_COMPONENTS',
      message: 'Arsip ZIP kosong.',
    }
  }

  if (totalEntries > ZIP_SECURITY_LIMITS.maxEntries) {
    return {
      valid: false,
      code: 'TOO_MANY_FILES',
      message: `Jumlah file di dalam ZIP (${totalEntries}) melebihi batas keamanan (${ZIP_SECURITY_LIMITS.maxEntries}).`,
    }
  }

  // Hitung posisi awal Central Directory di dalam tailBytes
  const tailStartAbsOffset = totalFileSize - tailBytes.byteLength
  const cdOffsetInTail = cdAbsOffset - tailStartAbsOffset

  if (cdOffsetInTail < 0 || cdOffsetInTail + cdSizeBytes > eocdOffset) {
    return {
      valid: false,
      code: 'CORRUPT_ZIP_EOCD',
      message: 'Offset Central Directory ZIP berada di luar jangkauan yang valid.',
    }
  }

  let cursor = cdOffsetInTail
  let totalUncompressedBytes = 0
  const extByBaseName = new Map<string, Set<string>>()

  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > eocdOffset) {
      return {
        valid: false,
        code: 'CORRUPT_ZIP_EOCD',
        message: 'Header Central Directory ZIP terpotong.',
      }
    }

    const sig = view.getUint32(cursor, true)
    if (sig !== 0x02014b50) {
      return {
        valid: false,
        code: 'CORRUPT_ZIP_EOCD',
        message: 'Signature Central Directory File Header tidak valid.',
      }
    }

    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const fileNameLen = view.getUint16(cursor + 28, true)
    const extraLen = view.getUint16(cursor + 30, true)
    const commentLen = view.getUint16(cursor + 32, true)

    const headerEnd = cursor + 46 + fileNameLen + extraLen + commentLen
    if (headerEnd > eocdOffset) {
      return {
        valid: false,
        code: 'CORRUPT_ZIP_EOCD',
        message: 'Field nama file pada Central Directory melampaui batas buffer.',
      }
    }

    const nameBytes = tailBytes.subarray(cursor + 46, cursor + 46 + fileNameLen)
    const entryName = decoder.decode(nameBytes)

    if (!isSafeZipEntryPath(entryName)) {
      return {
        valid: false,
        code: 'ZIP_SLIP_DETECTED',
        message: `Terdeteksi path berbahaya (Zip-Slip) di dalam arsip: "${entryName}".`,
      }
    }

    // Deteksi Zip-Bomb per entry
    if (uncompressedSize > 0) {
      if (compressedSize === 0) {
        return {
          valid: false,
          code: 'ZIP_BOMB_DETECTED',
          message: 'Terdeteksi anomali kompresi 0-byte (indikasi Zip-Bomb).',
        }
      }
      const ratio = uncompressedSize / compressedSize
      if (ratio > ZIP_SECURITY_LIMITS.maxCompressionRatio) {
        return {
          valid: false,
          code: 'ZIP_BOMB_DETECTED',
          message: `Rasio kompresi (${Math.round(ratio)}:1) melampaui ambang batas keamanan Zip-Bomb (${ZIP_SECURITY_LIMITS.maxCompressionRatio}:1).`,
        }
      }
    }

    totalUncompressedBytes += uncompressedSize
    if (totalUncompressedBytes > ZIP_SECURITY_LIMITS.maxUncompressedBytes) {
      return {
        valid: false,
        code: 'UNCOMPRESSED_LIMIT_EXCEEDED',
        message: `Total ukuran dekompresi melebihi batas maksimum ${ZIP_SECURITY_LIMITS.maxUncompressedBytes / (1024 * 1024)} MB.`,
      }
    }

    // Catat ekstensi file untuk memeriksa kelengkapan komponen Shapefile (.shp, .shx, .dbf, .prj)
    if (
      !entryName.endsWith('/') &&
      !entryName.endsWith('\\') &&
      !isIgnoredZipMetadataEntry(entryName)
    ) {
      const normalized = entryName.replace(/\\/g, '/')
      const lastSlash = normalized.lastIndexOf('/')
      const fileOnly = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized
      const dotIdx = fileOnly.lastIndexOf('.')
      if (dotIdx > 0) {
        const base = fileOnly.slice(0, dotIdx).toLowerCase()
        const ext = fileOnly.slice(dotIdx).toLowerCase()
        let set = extByBaseName.get(base)
        if (!set) {
          set = new Set<string>()
          extByBaseName.set(base, set)
        }
        set.add(ext)
      }
    }

    cursor = headerEnd
  }

  let matchedBaseName: string | undefined
  for (const [base, extSet] of extByBaseName.entries()) {
    const hasAll = ZIP_SECURITY_LIMITS.requiredShapefileExtensions.every((reqExt) =>
      extSet.has(reqExt)
    )
    if (hasAll) {
      matchedBaseName = base
      break
    }
  }

  if (!matchedBaseName) {
    return {
      valid: false,
      code: 'MISSING_SHAPEFILE_COMPONENTS',
      message:
        'Bundel ZIP Shapefile wajib memiliki keempat file dengan nama dasar yang sama: .shp, .shx, .dbf, dan .prj.',
    }
  }

  return {
    valid: true,
    entriesCount: totalEntries,
    totalUncompressedBytes,
    shapefileBaseName: matchedBaseName,
  }
}
