import { config } from '../../config'
import {
  generateRefreshTokenPair,
  hashTokenSha256,
  signAccessToken,
  type ClientType,
  type UserRole,
} from '../../lib/crypto'
import { getPgPool, getSqliteDb, getSqliteStmt } from '../client'

export interface UserRecord {
  id: string
  email: string
  passwordHash: string
  name: string
  role: UserRole
  createdAt: string
}

export interface PublicUserProfile {
  id: string
  email: string
  name: string
  role: UserRole
}

interface SqliteUserRow {
  id: string
  email: string
  password_hash: string
  name: string
  role: UserRole
  created_at: string | Date
}

interface SqliteRefreshTokenRow {
  id: string
  user_id: string
  family_id: string
  token_hash: string
  client_type: ClientType
  expires_at: string | Date
  revoked_at: string | Date | null
}

function mapUserRow(row: SqliteUserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    name: row.name,
    role: row.role,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }
}

export function toPublicUser(user: UserRecord): PublicUserProfile {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  }
}

/**
 * Mencari user berdasarkan email dalam O(log N) melalui indeks UNIQUE(email).
 */
export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const normalized = email.trim().toLowerCase()

  if (config.DB_PROVIDER === 'sqlite') {
    const row = getSqliteStmt<SqliteUserRow, [string]>(
      `SELECT * FROM users WHERE email = ? LIMIT 1`
    ).get(normalized)
    return row ? mapUserRow(row) : null
  }

  const pool = getPgPool()
  const rows = await pool.unsafe(`SELECT * FROM users WHERE email = $1 LIMIT 1`, [normalized])
  return rows && rows.length > 0 ? mapUserRow(rows[0] as SqliteUserRow) : null
}

/**
 * Mencari user berdasarkan ID dalam O(log N) melalui PRIMARY KEY.
 */
export async function findUserById(id: string): Promise<UserRecord | null> {
  if (config.DB_PROVIDER === 'sqlite') {
    const row = getSqliteStmt<SqliteUserRow, [string]>(
      `SELECT * FROM users WHERE id = ? LIMIT 1`
    ).get(id)
    return row ? mapUserRow(row) : null
  }

  const pool = getPgPool()
  const rows = await pool.unsafe(`SELECT * FROM users WHERE id = $1::uuid LIMIT 1`, [id])
  return rows && rows.length > 0 ? mapUserRow(rows[0] as SqliteUserRow) : null
}

/**
 * Mengambil daftar pengguna (khusus Admin) dengan batas LIMIT.
 */
export async function listUsers(limit = 50): Promise<PublicUserProfile[]> {
  const safeLimit = Math.max(1, Math.min(100, limit))
  if (config.DB_PROVIDER === 'sqlite') {
    const rows = getSqliteStmt<SqliteUserRow, [number]>(
      `SELECT * FROM users ORDER BY created_at DESC LIMIT ?`
    ).all(safeLimit)
    return rows.map((r) => toPublicUser(mapUserRow(r)))
  }

  const pool = getPgPool()
  const rows = await pool.unsafe(`SELECT * FROM users ORDER BY created_at DESC LIMIT $1`, [
    safeLimit,
  ])
  return (rows as SqliteUserRow[]).map((r) => toPublicUser(mapUserRow(r)))
}

/**
 * Membuat pengguna baru (mis. akun petugas lapangan KKN) oleh Admin.
 */
export async function createUserAccount(params: {
  email: string
  passwordHash: string
  name: string
  role: 'petugas' | 'admin'
}): Promise<PublicUserProfile> {
  const id = crypto.randomUUID()
  const normalizedEmail = params.email.trim().toLowerCase()
  const nowIso = new Date().toISOString()

  if (config.DB_PROVIDER === 'sqlite') {
    getSqliteStmt<unknown, [string, string, string, string, string, string]>(
      `INSERT INTO users (id, email, password_hash, name, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, normalizedEmail, params.passwordHash, params.name.trim(), params.role, nowIso)
    return {
      id,
      email: normalizedEmail,
      name: params.name.trim(),
      role: params.role,
    }
  }

  const pool = getPgPool()
  const rows = await pool.unsafe(
    `INSERT INTO users (id, email, password_hash, name, role)
     VALUES ($1::uuid, $2, $3, $4, $5)
     RETURNING *`,
    [id, normalizedEmail, params.passwordHash, params.name.trim(), params.role]
  )
  return toPublicUser(mapUserRow((rows as SqliteUserRow[])[0]))
}

/**
 * Menerbitkan pasangan Access Token + Refresh Token baru untuk sesi login.
 * Hanya SHA-256 hash dari refresh token yang disimpan di database.
 */
export async function createSessionTokens(
  user: UserRecord,
  clientType: ClientType
): Promise<{
  accessToken: string
  refreshToken: string
  expiresIn: number
}> {
  const accessToken = await signAccessToken({
    userId: user.id,
    role: user.role,
    client: clientType,
  })

  const { rawToken, tokenHash } = generateRefreshTokenPair()
  const tokenId = crypto.randomUUID()
  const familyId = crypto.randomUUID()
  const now = new Date()
  const expiresAt = new Date(
    now.getTime() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
  )

  if (config.DB_PROVIDER === 'sqlite') {
    getSqliteStmt<unknown, [string, string, string, string, string, string, string]>(
      `INSERT INTO refresh_tokens (
         id, user_id, family_id, token_hash, client_type, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tokenId,
      user.id,
      familyId,
      tokenHash,
      clientType,
      expiresAt.toISOString(),
      now.toISOString()
    )
  } else {
    const pool = getPgPool()
    await pool.unsafe(
      `INSERT INTO refresh_tokens (
         id, user_id, family_id, token_hash, client_type, expires_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz)`,
      [tokenId, user.id, familyId, tokenHash, clientType, expiresAt.toISOString()]
    )
  }

  return {
    accessToken,
    refreshToken: rawToken,
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
  }
}

export type RotateRefreshResult =
  | {
      status: 'ok'
      accessToken: string
      refreshToken: string
      expiresIn: number
      user: PublicUserProfile
      clientType: ClientType
      graceRetry: boolean
    }
  | { status: 'invalid' | 'expired' | 'reuse_detected' }

/**
 * Merotasi Refresh Token dalam O(log N) dengan fitur Refresh Token Reuse Detection
 * yang dilengkapi Grace Window (default 15 detik) untuk toleransi sinyal lemah / request paralel.
 * - Jika token sudah revoked <= graceWindowSeconds yang lalu: terbitkan token baru tanpa memutus sesi.
 * - Jika token sudah revoked > graceWindowSeconds yang lalu: cabut seluruh family_id (indikasi pencurian token!).
 */
export async function rotateRefreshToken(
  rawRefreshToken: string,
  options?: { now?: Date; graceWindowSeconds?: number }
): Promise<RotateRefreshResult> {
  if (!rawRefreshToken || rawRefreshToken.length > 256) {
    return { status: 'invalid' }
  }

  const incomingHash = hashTokenSha256(rawRefreshToken)
  const now = options?.now ?? new Date()
  const nowIso = now.toISOString()
  const graceWindowSec = options?.graceWindowSeconds ?? config.REFRESH_GRACE_WINDOW_SECONDS

  if (config.DB_PROVIDER === 'sqlite') {
    const db = getSqliteDb()
    const existing = getSqliteStmt<SqliteRefreshTokenRow, [string]>(
      `SELECT * FROM refresh_tokens WHERE token_hash = ? LIMIT 1`
    ).get(incomingHash)

    if (!existing) {
      return { status: 'invalid' }
    }

    let isGraceRetry = false

    // DETEKSI PENGGUNAAN ULANG TOKEN CURIAN DENGAN GRACE WINDOW
    if (existing.revoked_at !== null) {
      const revokedAtMs = new Date(String(existing.revoked_at)).getTime()
      const elapsedSec = (now.getTime() - revokedAtMs) / 1000

      if (elapsedSec > graceWindowSec) {
        getSqliteStmt<unknown, [string, string]>(
          `UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`
        ).run(nowIso, existing.family_id)
        return { status: 'reuse_detected' }
      }

      // Pastikan keluarga sesi ini belum dicabut seluruhnya oleh reuse_detected sebelumnya
      const activeInFamily = getSqliteStmt<{ cnt: number }, [string]>(
        `SELECT COUNT(*) AS cnt FROM refresh_tokens WHERE family_id = ? AND revoked_at IS NULL`
      ).get(existing.family_id)
      if (!activeInFamily || activeInFamily.cnt === 0) {
        return { status: 'reuse_detected' }
      }

      isGraceRetry = true
    }

    const expTime = new Date(String(existing.expires_at)).getTime()
    if (now.getTime() >= expTime) {
      if (!isGraceRetry) {
        getSqliteStmt<unknown, [string, string]>(
          `UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?`
        ).run(nowIso, existing.id)
      }
      return { status: 'expired' }
    }

    const user = await findUserById(existing.user_id)
    if (!user) {
      return { status: 'invalid' }
    }

    const { rawToken: nextRawToken, tokenHash: nextHash } = generateRefreshTokenPair()
    const nextTokenId = crypto.randomUUID()
    const nextExpiresAt = new Date(
      now.getTime() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
    ).toISOString()

    const tx = db.transaction(() => {
      if (!isGraceRetry) {
        getSqliteStmt<unknown, [string, string]>(
          `UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?`
        ).run(nowIso, existing.id)
      }

      getSqliteStmt<unknown, [string, string, string, string, string, string, string]>(
        `INSERT INTO refresh_tokens (
           id, user_id, family_id, token_hash, client_type, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        nextTokenId,
        user.id,
        existing.family_id,
        nextHash,
        existing.client_type,
        nextExpiresAt,
        nowIso
      )
    })
    tx()

    const accessToken = await signAccessToken({
      userId: user.id,
      role: user.role,
      client: existing.client_type,
    })

    return {
      status: 'ok',
      accessToken,
      refreshToken: nextRawToken,
      expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
      user: toPublicUser(user),
      clientType: existing.client_type,
      graceRetry: isGraceRetry,
    }
  }

  // Mode PostgreSQL
  const pool = getPgPool()
  const rows = await pool.unsafe(
    `SELECT * FROM refresh_tokens WHERE token_hash = $1 LIMIT 1`,
    [incomingHash]
  )
  if (!rows || rows.length === 0) {
    return { status: 'invalid' }
  }

  const existing = rows[0] as SqliteRefreshTokenRow
  let isGraceRetry = false

  if (existing.revoked_at !== null) {
    const revokedAtMs = new Date(existing.revoked_at).getTime()
    const elapsedSec = (now.getTime() - revokedAtMs) / 1000

    if (elapsedSec > graceWindowSec) {
      await pool.unsafe(
        `UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $1::uuid AND revoked_at IS NULL`,
        [existing.family_id]
      )
      return { status: 'reuse_detected' }
    }

    const activeRows = await pool.unsafe(
      `SELECT COUNT(*)::int AS cnt FROM refresh_tokens WHERE family_id = $1::uuid AND revoked_at IS NULL`,
      [existing.family_id]
    )
    if (!activeRows || Number(activeRows[0]?.cnt ?? 0) === 0) {
      return { status: 'reuse_detected' }
    }

    isGraceRetry = true
  }

  const expTime = new Date(existing.expires_at).getTime()
  if (now.getTime() >= expTime) {
    if (!isGraceRetry) {
      await pool.unsafe(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1::uuid`, [
        existing.id,
      ])
    }
    return { status: 'expired' }
  }

  const user = await findUserById(existing.user_id)
  if (!user) {
    return { status: 'invalid' }
  }

  const { rawToken: nextRawToken, tokenHash: nextHash } = generateRefreshTokenPair()
  const nextTokenId = crypto.randomUUID()
  const nextExpiresAt = new Date(
    now.getTime() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()

  await pool.begin(async (tx) => {
    if (!isGraceRetry) {
      await tx.unsafe(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1::uuid`, [
        existing.id,
      ])
    }
    await tx.unsafe(
      `INSERT INTO refresh_tokens (
         id, user_id, family_id, token_hash, client_type, expires_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz)`,
      [
        nextTokenId,
        user.id,
        existing.family_id,
        nextHash,
        existing.client_type,
        nextExpiresAt,
      ]
    )
  })

  const accessToken = await signAccessToken({
    userId: user.id,
    role: user.role,
    client: existing.client_type,
  })

  return {
    status: 'ok',
    accessToken,
    refreshToken: nextRawToken,
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    user: toPublicUser(user),
    clientType: existing.client_type,
    graceRetry: isGraceRetry,
  }
}

/**
 * Mencabut seluruh refresh token dalam satu keluarga sesi saat user logout.
 */
export async function revokeRefreshTokenFamily(rawRefreshToken: string): Promise<void> {
  if (!rawRefreshToken || rawRefreshToken.length > 256) return
  const tokenHash = hashTokenSha256(rawRefreshToken)
  const nowIso = new Date().toISOString()

  if (config.DB_PROVIDER === 'sqlite') {
    const existing = getSqliteStmt<{ family_id: string }, [string]>(
      `SELECT family_id FROM refresh_tokens WHERE token_hash = ? LIMIT 1`
    ).get(tokenHash)
    if (!existing) return
    getSqliteStmt<unknown, [string, string]>(
      `UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL`
    ).run(nowIso, existing.family_id)
    return
  }

  const pool = getPgPool()
  await pool.unsafe(
    `UPDATE refresh_tokens
     SET revoked_at = NOW()
     WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1 LIMIT 1)
       AND revoked_at IS NULL`,
    [tokenHash]
  )
}
