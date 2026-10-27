import type { GeoJsonGeometry } from '../db/client'

export type BoundingBox = [number, number, number, number] // [minLng, minLat, maxLng, maxLat]

export interface MvtInputFeature {
  id: number
  properties: Record<string, unknown>
  geometry: GeoJsonGeometry
}

/**
 * Memvalidasi koordinat tile z/x/y dalam O(1).
 */
export function isValidTileCoord(z: number, x: number, y: number): boolean {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
    return false
  }
  if (z < 0 || z > 22) return false
  const maxCoord = 1 << z
  return x >= 0 && x < maxCoord && y >= 0 && y < maxCoord
}

/**
 * Menghitung bounding box WGS84 [minLng, minLat, maxLng, maxLat] dari tile (z, x, y) dalam O(1).
 */
export function tileToBBox(z: number, x: number, y: number): BoundingBox {
  const n = Math.pow(2, z)
  const minLng = (x / n) * 360 - 180
  const maxLng = ((x + 1) / n) * 360 - 180

  const latRadMax = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)))
  const latRadMin = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)))

  const minLat = (latRadMin * 180) / Math.PI
  const maxLat = (latRadMax * 180) / Math.PI

  return [minLng, minLat, maxLng, maxLat]
}

/**
 * Mengonversi koordinat (lng, lat) ke indeks tile (x, y) pada zoom z dalam O(1).
 */
export function lngLatToTileXY(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = Math.pow(2, z)
  const x = Math.floor(((lng + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  )
  const maxIdx = n - 1
  return {
    x: Math.max(0, Math.min(maxIdx, x)),
    y: Math.max(0, Math.min(maxIdx, y)),
  }
}

function writeVarint(out: number[], value: number): void {
  let v = value >>> 0
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
}

function writeSignedVarint64(out: number[], value: number): void {
  if (value >= 0) {
    writeVarint(out, value)
    return
  }
  // Untuk bilangan negatif kecil pada int64 protobuf
  let v = BigInt(value) & 0xffffffffffffffffn
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  out.push(Number(v))
}

function zigZag(n: number): number {
  return ((n << 1) ^ (n >> 31)) >>> 0
}

function cmdInteger(id: number, count: number): number {
  return ((id & 0x7) | (count << 3)) >>> 0
}

function writeBytesField(out: number[], fieldNumber: number, payload: number[] | Uint8Array): void {
  const tag = (fieldNumber << 3) | 2
  writeVarint(out, tag)
  writeVarint(out, payload.length)
  for (let i = 0; i < payload.length; i++) {
    out.push(payload[i])
  }
}

function writeStringField(out: number[], fieldNumber: number, str: string): void {
  const encoded = new TextEncoder().encode(str)
  writeBytesField(out, fieldNumber, encoded)
}

function projectToTileExtent(
  lng: number,
  lat: number,
  bbox: BoundingBox,
  extent: number
): [number, number] {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const lngSpan = maxLng - minLng || 1e-9
  const latSpan = maxLat - minLat || 1e-9

  const x = Math.round(((lng - minLng) / lngSpan) * extent)
  const y = Math.round(((maxLat - lat) / latSpan) * extent)
  return [x, y]
}

function encodeGeometryCommands(
  geom: GeoJsonGeometry,
  bbox: BoundingBox,
  extent: number
): { geomType: 1 | 2 | 3; commands: number[] } | null {
  const commands: number[] = []
  let curX = 0
  let curY = 0

  if (geom.type === 'Point') {
    const coords = geom.coordinates as [number, number]
    if (!Array.isArray(coords) || coords.length < 2) return null
    const [tx, ty] = projectToTileExtent(coords[0], coords[1], bbox, extent)
    writeVarint(commands, cmdInteger(1, 1)) // MoveTo(1)
    writeVarint(commands, zigZag(tx - curX))
    writeVarint(commands, zigZag(ty - curY))
    return { geomType: 1, commands }
  }

  if (geom.type === 'MultiPoint') {
    const pts = geom.coordinates as [number, number][]
    if (!Array.isArray(pts) || pts.length === 0) return null
    writeVarint(commands, cmdInteger(1, pts.length))
    for (let i = 0; i < pts.length; i++) {
      const [tx, ty] = projectToTileExtent(pts[i][0], pts[i][1], bbox, extent)
      writeVarint(commands, zigZag(tx - curX))
      writeVarint(commands, zigZag(ty - curY))
      curX = tx
      curY = ty
    }
    return { geomType: 1, commands }
  }

  if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
    const lines =
      geom.type === 'LineString'
        ? [geom.coordinates as [number, number][]]
        : (geom.coordinates as [number, number][][])

    let validLines = 0
    for (const line of lines) {
      if (!Array.isArray(line) || line.length < 2) continue
      const [startX, startY] = projectToTileExtent(line[0][0], line[0][1], bbox, extent)
      writeVarint(commands, cmdInteger(1, 1)) // MoveTo(1)
      writeVarint(commands, zigZag(startX - curX))
      writeVarint(commands, zigZag(startY - curY))
      curX = startX
      curY = startY

      writeVarint(commands, cmdInteger(2, line.length - 1)) // LineTo(N-1)
      for (let i = 1; i < line.length; i++) {
        const [px, py] = projectToTileExtent(line[i][0], line[i][1], bbox, extent)
        writeVarint(commands, zigZag(px - curX))
        writeVarint(commands, zigZag(py - curY))
        curX = px
        curY = py
      }
      validLines++
    }
    return validLines > 0 ? { geomType: 2, commands } : null
  }

  if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
    const polygons =
      geom.type === 'Polygon'
        ? [geom.coordinates as [number, number][][]]
        : (geom.coordinates as [number, number][][][])

    let validRings = 0
    for (const poly of polygons) {
      if (!Array.isArray(poly)) continue
      for (const ring of poly) {
        if (!Array.isArray(ring) || ring.length < 3) continue
        // Jika titik terakhir sama dengan titik pertama, kurangi 1 karena ClosePath(7) menutup ring
        const first = ring[0]
        const last = ring[ring.length - 1]
        const effectiveLen =
          ring.length > 3 && first[0] === last[0] && first[1] === last[1]
            ? ring.length - 1
            : ring.length

        if (effectiveLen < 3) continue

        const [startX, startY] = projectToTileExtent(first[0], first[1], bbox, extent)
        writeVarint(commands, cmdInteger(1, 1)) // MoveTo(1)
        writeVarint(commands, zigZag(startX - curX))
        writeVarint(commands, zigZag(startY - curY))
        curX = startX
        curY = startY

        writeVarint(commands, cmdInteger(2, effectiveLen - 1)) // LineTo(effectiveLen - 1)
        for (let i = 1; i < effectiveLen; i++) {
          const [px, py] = projectToTileExtent(ring[i][0], ring[i][1], bbox, extent)
          writeVarint(commands, zigZag(px - curX))
          writeVarint(commands, zigZag(py - curY))
          curX = px
          curY = py
        }

        writeVarint(commands, cmdInteger(7, 1)) // ClosePath(1)
        validRings++
      }
    }
    return validRings > 0 ? { geomType: 3, commands } : null
  }

  return null
}

function encodeMvtValue(val: unknown): number[] {
  const out: number[] = []
  if (typeof val === 'string') {
    writeStringField(out, 1, val) // string_value = 1
  } else if (typeof val === 'boolean') {
    writeVarint(out, (7 << 3) | 0) // bool_value = 7
    writeVarint(out, val ? 1 : 0)
  } else if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      if (val >= 0) {
        writeVarint(out, (5 << 3) | 0) // uint_value = 5
        writeVarint(out, val)
      } else {
        writeVarint(out, (4 << 3) | 0) // int_value = 4
        writeSignedVarint64(out, val)
      }
    } else {
      // double_value = 3 (wire type 1 = 64-bit)
      writeVarint(out, (3 << 3) | 1)
      const buf = new ArrayBuffer(8)
      new DataView(buf).setFloat64(0, val, true)
      const bytes = new Uint8Array(buf)
      for (let i = 0; i < 8; i++) out.push(bytes[i])
    }
  } else {
    writeStringField(out, 1, JSON.stringify(val))
  }
  return out
}

/**
 * Mengodekan daftar fitur ke format biner Protobuf Mapbox Vector Tile (MVT v2.1)
 * dalam satu lintasan O(V + P) menggunakan Map dictionary O(1).
 */
export function encodeMvtTile(
  layerName: string,
  features: readonly MvtInputFeature[],
  tileBBox: BoundingBox,
  extent = 4096
): Uint8Array {
  if (features.length === 0) {
    return new Uint8Array(0)
  }

  const keyIndexMap = new Map<string, number>()
  const keysList: string[] = []

  const valIndexMap = new Map<string, number>()
  const encodedValuesList: number[][] = []

  const encodedFeatures: number[][] = []

  for (let i = 0; i < features.length; i++) {
    const feat = features[i]
    const geomResult = encodeGeometryCommands(feat.geometry, tileBBox, extent)
    if (!geomResult) continue

    const tags: number[] = []
    const props = feat.properties
    for (const k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue
      const v = props[k]
      if (v === null || v === undefined) continue

      let keyIdx = keyIndexMap.get(k)
      if (keyIdx === undefined) {
        keyIdx = keysList.length
        keyIndexMap.set(k, keyIdx)
        keysList.push(k)
      }

      const valTypeKey = `${typeof v}:${String(v)}`
      let valIdx = valIndexMap.get(valTypeKey)
      if (valIdx === undefined) {
        valIdx = encodedValuesList.length
        valIndexMap.set(valTypeKey, valIdx)
        encodedValuesList.push(encodeMvtValue(v))
      }

      writeVarint(tags, keyIdx)
      writeVarint(tags, valIdx)
    }

    const featBytes: number[] = []
    // id = 1 (uint64)
    if (feat.id > 0) {
      writeVarint(featBytes, (1 << 3) | 0)
      writeVarint(featBytes, feat.id)
    }
    // tags = 2 (packed uint32)
    if (tags.length > 0) {
      writeBytesField(featBytes, 2, tags)
    }
    // type = 3 (GeomType enum)
    writeVarint(featBytes, (3 << 3) | 0)
    writeVarint(featBytes, geomResult.geomType)
    // geometry = 4 (packed uint32)
    writeBytesField(featBytes, 4, geomResult.commands)

    encodedFeatures.push(featBytes)
  }

  if (encodedFeatures.length === 0) {
    return new Uint8Array(0)
  }

  const layerBytes: number[] = []
  // version = 15 (uint32 = 2 untuk MVT v2.1)
  writeVarint(layerBytes, (15 << 3) | 0)
  writeVarint(layerBytes, 2)
  // name = 1 (string)
  writeStringField(layerBytes, 1, layerName)
  // features = 2 (repeated Feature)
  for (let i = 0; i < encodedFeatures.length; i++) {
    writeBytesField(layerBytes, 2, encodedFeatures[i])
  }
  // keys = 3 (repeated string)
  for (let i = 0; i < keysList.length; i++) {
    writeStringField(layerBytes, 3, keysList[i])
  }
  // values = 4 (repeated Value)
  for (let i = 0; i < encodedValuesList.length; i++) {
    writeBytesField(layerBytes, 4, encodedValuesList[i])
  }
  // extent = 5 (uint32)
  writeVarint(layerBytes, (5 << 3) | 0)
  writeVarint(layerBytes, extent)

  // Tile message: layers = 3 (repeated Layer)
  const tileBytes: number[] = []
  writeBytesField(tileBytes, 3, layerBytes)

  return new Uint8Array(tileBytes)
}
