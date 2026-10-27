import { resolve } from 'node:path'
import { config } from '../config'
import { getPgPool, getSqliteDb } from './client'

/**
 * Menjalankan skema migrasi sesuai DB_PROVIDER (sqlite | postgres).
 */
export async function runMigrations(): Promise<void> {
  if (config.DB_PROVIDER === 'sqlite') {
    const sqlPath = resolve(import.meta.dir, '../../migrations/sqlite_init.sql')
    const sqlContent = await Bun.file(sqlPath).text()
    const db = getSqliteDb()
    db.exec(sqlContent)
    return
  }

  const sqlPath = resolve(import.meta.dir, '../../migrations/0001_init.sql')
  const sqlContent = await Bun.file(sqlPath).text()
  const pool = getPgPool()
  await pool.unsafe(sqlContent)
}

if (import.meta.main) {
  runMigrations()
    .then(() => {
      console.log(`[MIGRATE] Berhasil menjalankan migrasi (${config.DB_PROVIDER}).`)
    })
    .catch((err) => {
      console.error('[MIGRATE ERROR]', err)
      process.exit(1)
    })
}
