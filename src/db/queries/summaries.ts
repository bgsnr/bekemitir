import { config } from '../../config'
import {
  ANON_RLS_CONTEXT,
  getSqliteStmt,
  withPgRls,
  type RlsContext,
} from '../client'
import type { DroughtSeverity } from './observations'

export interface DroughtSummaryReport {
  totalObservations: number
  bySeverity: Record<DroughtSeverity, number>
  latestObservedAt: string | null
  totalPublicLayers: number
}

/**
 * Mengambil ringkasan statistik kekeringan secara instan O(R)
 * dari Materialized View (PostgreSQL) atau indeks severity (SQLite).
 */
export async function getDroughtSummary(
  rls: RlsContext = ANON_RLS_CONTEXT
): Promise<DroughtSummaryReport> {
  const bySeverity: Record<DroughtSeverity, number> = {
    normal: 0,
    waspada: 0,
    siaga: 0,
    awas: 0,
  }
  let totalObservations = 0
  let latestObservedAt: string | null = null

  if (config.DB_PROVIDER === 'sqlite') {
    const rows = getSqliteStmt<
      {
        severity: DroughtSeverity
        observation_count: number
        latest_observed_at: string | null
      },
      []
    >(
      `SELECT
         severity,
         COUNT(*) AS observation_count,
         MAX(observed_at) AS latest_observed_at
       FROM field_observations
       GROUP BY severity`
    ).all()

    for (const r of rows) {
      if (r.severity in bySeverity) {
        const cnt = Number(r.observation_count)
        bySeverity[r.severity] = cnt
        totalObservations += cnt
      }
      if (
        r.latest_observed_at &&
        (!latestObservedAt || r.latest_observed_at > latestObservedAt)
      ) {
        latestObservedAt = r.latest_observed_at
      }
    }

    const layerRow = getSqliteStmt<{ cnt: number }, []>(
      `SELECT COUNT(*) AS cnt FROM spatial_layers WHERE is_public = 1`
    ).get()

    return {
      totalObservations,
      bySeverity,
      latestObservedAt,
      totalPublicLayers: Number(layerRow?.cnt ?? 0),
    }
  }

  return withPgRls(rls, async (tx) => {
    const rows = await tx.unsafe(
      `SELECT severity, observation_count, latest_observed_at FROM mv_drought_summaries`
    )

    for (const r of rows as {
      severity: DroughtSeverity
      observation_count: number
      latest_observed_at: Date | string | null
    }[]) {
      if (r.severity in bySeverity) {
        const cnt = Number(r.observation_count)
        bySeverity[r.severity] = cnt
        totalObservations += cnt
      }
      const iso =
        r.latest_observed_at instanceof Date
          ? r.latest_observed_at.toISOString()
          : r.latest_observed_at
      if (iso && (!latestObservedAt || iso > latestObservedAt)) {
        latestObservedAt = iso
      }
    }

    const layerRows = await tx.unsafe(
      `SELECT COUNT(*)::int AS cnt FROM spatial_layers WHERE is_public = true`
    )

    return {
      totalObservations,
      bySeverity,
      latestObservedAt,
      totalPublicLayers: Number(layerRows?.[0]?.cnt ?? 0),
    }
  })
}
