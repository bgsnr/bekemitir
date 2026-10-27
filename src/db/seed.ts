import { config } from '../config'
import { hashPassword } from '../lib/crypto'
import { computeGeoJsonBBox, getPgPool, getSqliteDb, type GeoJsonGeometry } from './client'
import { runMigrations } from './migrate'

export const SEED_IDS = Object.freeze({
  adminUserId: '11111111-1111-4111-8111-111111111111',
  petugasUserId: '22222222-2222-4222-8222-222222222222',
  dusunLayerId: '33333333-3333-4333-8333-333333333333',
})

interface SampleDusunFeature {
  properties: Record<string, unknown>
  geometry: GeoJsonGeometry
}

const SAMPLE_DUSUN_FEATURES: readonly SampleDusunFeature[] = [
  {
    properties: {
      kode_dusun: 'KMT-01',
      nama_dusun: 'Dusun Krajan Kemitir',
      status_kekeringan: 'siaga',
      jumlah_kk: 145,
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [110.285, -7.235],
          [110.298, -7.235],
          [110.298, -7.222],
          [110.285, -7.222],
          [110.285, -7.235],
        ],
      ],
    },
  },
  {
    properties: {
      kode_dusun: 'KMT-02',
      nama_dusun: 'Dusun Tegalsari Kemitir',
      status_kekeringan: 'awas',
      jumlah_kk: 118,
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [110.298, -7.235],
          [110.312, -7.235],
          [110.312, -7.222],
          [110.298, -7.222],
          [110.298, -7.235],
        ],
      ],
    },
  },
  {
    properties: {
      kode_dusun: 'KMT-03',
      nama_dusun: 'Dusun Lembah Kemitir',
      status_kekeringan: 'waspada',
      jumlah_kk: 96,
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [110.285, -7.222],
          [110.312, -7.222],
          [110.312, -7.208],
          [110.285, -7.208],
          [110.285, -7.222],
        ],
      ],
    },
  },
]

const SAMPLE_OBSERVATIONS = [
  {
    id: '44444444-4444-4444-8444-444444444401',
    clientId: '55555555-5555-4555-8555-555555555501',
    category: 'mata_air',
    severity: 'awas',
    title: 'Mata Air Sendang Atas Mengering',
    notes: 'Debit air turun drastis sejak awal musim kemarau.',
    properties: { debit_liter_per_detik: 0.1, kedalaman_m: 4.5 },
    observedAt: '2026-10-18T08:30:00.000Z',
    lng: 110.304,
    lat: -7.228,
  },
  {
    id: '44444444-4444-4444-8444-444444444402',
    clientId: '55555555-5555-4555-8555-555555555502',
    category: 'sumur_warga',
    severity: 'siaga',
    title: 'Sumur Gali RT 03 Kering',
    notes: 'Warga membutuhkan suplai tangki air bersih mingguan.',
    properties: { jumlah_kk_terdampak: 24 },
    observedAt: '2026-10-18T10:15:00.000Z',
    lng: 110.291,
    lat: -7.229,
  },
  {
    id: '44444444-4444-4444-8444-444444444403',
    clientId: '55555555-5555-4555-8555-555555555503',
    category: 'lahan_pertanian',
    severity: 'waspada',
    title: 'Irigasi Tersier Dusun Lembah Menyusut',
    notes: 'Kelembaban tanah mulai menurun namun masih ada cadangan embung.',
    properties: { luas_hektar: 3.2 },
    observedAt: '2026-10-19T07:00:00.000Z',
    lng: 110.296,
    lat: -7.214,
  },
  {
    id: '44444444-4444-4444-8444-444444444404',
    clientId: '55555555-5555-4555-8555-555555555504',
    category: 'tandon_air',
    severity: 'normal',
    title: 'Tandon Utama Balai Desa Berfungsi Baik',
    notes: 'Kapasitas terisi 85% dari distribusi pipa utama.',
    properties: { kapasitas_liter: 5000 },
    observedAt: '2026-10-19T09:45:00.000Z',
    lng: 110.289,
    lat: -7.225,
  },
] as const

/**
 * Mengisi database dengan data awal Desa Kemitir secara idempoten.
 * Dapat dipanggil berulang kali tanpa menduplikasi baris.
 */
export async function seedDatabase(): Promise<void> {
  await runMigrations()

  const nowIso = new Date().toISOString()
  const [adminHash, petugasHash] = await Promise.all([
    hashPassword('AdminKemitir2026!'),
    hashPassword('PetugasKemitir2026!'),
  ])

  if (config.DB_PROVIDER === 'sqlite') {
    const db = getSqliteDb()
    const tx = db.transaction(() => {
      db.query(
        `INSERT INTO users (id, email, password_hash, name, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, name = excluded.name, role = excluded.role`
      ).run(
        SEED_IDS.adminUserId,
        'admin@kemitir.id',
        adminHash,
        'Admin GIS Kemitir',
        'admin',
        nowIso
      )

      db.query(
        `INSERT INTO users (id, email, password_hash, name, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, name = excluded.name, role = excluded.role`
      ).run(
        SEED_IDS.petugasUserId,
        'petugas@kemitir.id',
        petugasHash,
        'Petugas Lapangan KKN',
        'petugas',
        nowIso
      )

      db.query(
        `INSERT INTO spatial_layers (
           id, slug, name, description, layer_type, geometry_type,
           min_zoom, max_zoom, bbox, style_config, is_public, feature_count, updated_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           name = excluded.name,
           feature_count = excluded.feature_count,
           updated_at = excluded.updated_at`
      ).run(
        SEED_IDS.dusunLayerId,
        'batas-dusun-kemitir',
        'Batas Administrasi & Kerawanan Dusun Kemitir',
        'Peta poligon batas dusun beserta indikator status kekeringan di Desa Kemitir.',
        'vector_mvt',
        'Polygon',
        0,
        18,
        JSON.stringify([110.285, -7.235, 110.312, -7.208]),
        JSON.stringify({
          fillColorProp: 'status_kekeringan',
          fillOpacity: 0.45,
          strokeColor: '#1e293b',
        }),
        1,
        SAMPLE_DUSUN_FEATURES.length,
        nowIso,
        nowIso
      )

      // Bersihkan fitur lama pada layer seed agar idempoten
      const existingFeatureIds = db
        .query<{ id: number }, [string]>(`SELECT id FROM vector_features WHERE layer_id = ?`)
        .all(SEED_IDS.dusunLayerId)

      const delRtreeFeat = db.query(`DELETE FROM vector_features_rtree WHERE id = ?`)
      for (const row of existingFeatureIds) {
        delRtreeFeat.run(row.id)
      }
      db.query(`DELETE FROM vector_features WHERE layer_id = ?`).run(SEED_IDS.dusunLayerId)

      const insFeat = db.query(
        `INSERT INTO vector_features (layer_id, properties, geojson, min_lng, min_lat, max_lng, max_lat)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      const insFeatRtree = db.query(
        `INSERT INTO vector_features_rtree (id, min_lng, max_lng, min_lat, max_lat)
         VALUES (?, ?, ?, ?, ?)`
      )

      for (const feat of SAMPLE_DUSUN_FEATURES) {
        const [minLng, minLat, maxLng, maxLat] = computeGeoJsonBBox(feat.geometry)
        const res = insFeat.run(
          SEED_IDS.dusunLayerId,
          JSON.stringify(feat.properties),
          JSON.stringify(feat.geometry),
          minLng,
          minLat,
          maxLng,
          maxLat
        )
        insFeatRtree.run(Number(res.lastInsertRowid), minLng, maxLng, minLat, maxLat)
      }

      const upsertObs = db.query<{ rowid_id: number }, [
        string, string, string, string, string, string, string, string, string, string, string, number, number
      ]>(
        `INSERT INTO field_observations (
           id, client_id, user_id, category, severity, title, notes, properties,
           observed_at, created_at, updated_at, lng, lat
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET
           severity = excluded.severity,
           title = excluded.title,
           notes = excluded.notes,
           properties = excluded.properties,
           updated_at = excluded.updated_at,
           lng = excluded.lng,
           lat = excluded.lat
         RETURNING rowid_id`
      )
      const upsertObsRtree = db.query(
        `INSERT OR REPLACE INTO field_observations_rtree (rowid_id, min_lng, max_lng, min_lat, max_lat)
         VALUES (?, ?, ?, ?, ?)`
      )

      for (const obs of SAMPLE_OBSERVATIONS) {
        const row = upsertObs.get(
          obs.id,
          obs.clientId,
          SEED_IDS.petugasUserId,
          obs.category,
          obs.severity,
          obs.title,
          obs.notes,
          JSON.stringify(obs.properties),
          obs.observedAt,
          nowIso,
          nowIso,
          obs.lng,
          obs.lat
        )
        if (row) {
          upsertObsRtree.run(row.rowid_id, obs.lng, obs.lng, obs.lat, obs.lat)
        }
      }
    })

    tx()
    return
  }

  // Mode PostgreSQL + PostGIS
  const pool = getPgPool()
  await pool.begin(async (tx) => {
    await tx.unsafe(
      `SELECT set_config('app.user_id', $1, true), set_config('app.user_role', 'admin', true)`,
      [SEED_IDS.adminUserId]
    )

    await tx.unsafe(
      `INSERT INTO users (id, email, password_hash, name, role)
       VALUES ($1, $2, $3, $4, 'admin'), ($5, $6, $7, $8, 'petugas')
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [
        SEED_IDS.adminUserId,
        'admin@kemitir.id',
        adminHash,
        'Admin GIS Kemitir',
        SEED_IDS.petugasUserId,
        'petugas@kemitir.id',
        petugasHash,
        'Petugas Lapangan KKN',
      ]
    )

    await tx.unsafe(
      `INSERT INTO spatial_layers (
         id, slug, name, description, layer_type, geometry_type,
         min_zoom, max_zoom, bbox, style_config, is_public, feature_count
       ) VALUES ($1, $2, $3, $4, 'vector_mvt', 'Polygon', 0, 18, $5::jsonb, $6::jsonb, true, $7)
       ON CONFLICT (slug) DO UPDATE SET
         feature_count = EXCLUDED.feature_count,
         updated_at = NOW()`,
      [
        SEED_IDS.dusunLayerId,
        'batas-dusun-kemitir',
        'Batas Administrasi & Kerawanan Dusun Kemitir',
        'Peta poligon batas dusun beserta indikator status kekeringan di Desa Kemitir.',
        JSON.stringify([110.285, -7.235, 110.312, -7.208]),
        JSON.stringify({
          fillColorProp: 'status_kekeringan',
          fillOpacity: 0.45,
          strokeColor: '#1e293b',
        }),
        SAMPLE_DUSUN_FEATURES.length,
      ]
    )

    await tx.unsafe(`DELETE FROM vector_features WHERE layer_id = $1`, [SEED_IDS.dusunLayerId])
    for (const feat of SAMPLE_DUSUN_FEATURES) {
      await tx.unsafe(
        `INSERT INTO vector_features (layer_id, properties, geom)
         VALUES ($1, $2::jsonb, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))`,
        [SEED_IDS.dusunLayerId, JSON.stringify(feat.properties), JSON.stringify(feat.geometry)]
      )
    }

    for (const obs of SAMPLE_OBSERVATIONS) {
      await tx.unsafe(
        `INSERT INTO field_observations (
           id, client_id, user_id, category, severity, title, notes, properties, observed_at, geom
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz,
           ST_SetSRID(ST_MakePoint($10, $11), 4326)
         )
         ON CONFLICT (client_id) DO UPDATE SET
           severity = EXCLUDED.severity,
           updated_at = NOW()`,
        [
          obs.id,
          obs.clientId,
          SEED_IDS.petugasUserId,
          obs.category,
          obs.severity,
          obs.title,
          obs.notes,
          JSON.stringify(obs.properties),
          obs.observedAt,
          obs.lng,
          obs.lat,
        ]
      )
    }

    await tx.unsafe(`REFRESH MATERIALIZED VIEW mv_drought_summaries`)
  })
}

if (import.meta.main) {
  seedDatabase()
    .then(() => {
      console.log('[SEED] Berhasil mengisi data awal Desa Kemitir.')
    })
    .catch((err) => {
      console.error('[SEED ERROR]', err)
      process.exit(1)
    })
}
