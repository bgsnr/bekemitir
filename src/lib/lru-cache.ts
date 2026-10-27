export interface LruCacheOptions {
  maxEntries: number
  maxBytes?: number
  ttlMs?: number
}

interface CacheEntry<V> {
  value: V
  bytes: number
  expiresAt: number
}

/**
 * Bounded LRU Cache dengan kompleksitas waktu O(1) untuk get, set, dan delete.
 * Memanfaatkan Map bawaan JavaScript (doubly-linked hash table di JSC/Bun)
 * yang menjaga urutan insersi, serta membatasi jumlah entri dan total byte RAM.
 */
export class BoundedLruCache<V> {
  private readonly map = new Map<string, CacheEntry<V>>()
  private readonly maxEntries: number
  private readonly maxBytes: number
  private readonly ttlMs: number
  private currentBytes = 0

  constructor(options: LruCacheOptions) {
    this.maxEntries = Math.max(1, options.maxEntries)
    this.maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER
    this.ttlMs = options.ttlMs ?? 0
  }

  public get size(): number {
    return this.map.size
  }

  public get totalBytes(): number {
    return this.currentBytes
  }

  /**
   * Mengambil nilai dalam O(1) dan memperbarui posisi menjadi Most Recently Used.
   */
  public get(key: string, now = Date.now()): V | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined

    if (entry.expiresAt > 0 && now >= entry.expiresAt) {
      this.delete(key)
      return undefined
    }

    // Promosikan ke posisi paling baru dalam O(1)
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  /**
   * Menyimpan nilai dalam O(1) amortized dan mengeviski entri tertua jika melampaui batas.
   */
  public set(
    key: string,
    value: V,
    byteLength = 1,
    customTtlMs?: number,
    now = Date.now()
  ): boolean {
    const safeBytes = Math.max(0, byteLength)
    if (safeBytes > this.maxBytes) {
      return false // Tolak objek tunggal yang melebihi kapasitas total cache
    }

    const existing = this.map.get(key)
    if (existing) {
      this.currentBytes -= existing.bytes
      this.map.delete(key)
    }

    const effectiveTtl = customTtlMs ?? this.ttlMs
    const expiresAt = effectiveTtl > 0 ? now + effectiveTtl : 0

    while (
      (this.map.size >= this.maxEntries || this.currentBytes + safeBytes > this.maxBytes) &&
      this.map.size > 0
    ) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey === undefined) break
      this.delete(oldestKey)
    }

    this.map.set(key, { value, bytes: safeBytes, expiresAt })
    this.currentBytes += safeBytes
    return true
  }

  /**
   * Menghapus satu key dalam O(1).
   */
  public delete(key: string): boolean {
    const existing = this.map.get(key)
    if (!existing) return false
    this.currentBytes -= existing.bytes
    return this.map.delete(key)
  }

  /**
   * Menghapus semua key yang diawali prefix tertentu (mis. saat invalidasi cache layer).
   * Kompleksitas O(K) terhadap jumlah item aktif di cache.
   */
  public deleteByPrefix(prefix: string): number {
    let removed = 0
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) {
        this.delete(key)
        removed++
      }
    }
    return removed
  }

  public clear(): void {
    this.map.clear()
    this.currentBytes = 0
  }
}
