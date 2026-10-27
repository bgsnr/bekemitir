/**
 * Spesifikasi lengkap OpenAPI 3.1.0 untuk Backend GIS Desa Kemitir (bekemitir).
 * Disajikan secara O(1) melalui GET /api/v1/openapi.json dan UI interaktif di GET /api/v1/docs.
 */
export const openApiSpec = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'bekemitir — Drought Monitoring Web & Mobile GIS API',
    version: '1.0.0',
    description:
      'REST & Spatial Vector Tile (MVT) API untuk sistem pemantauan kekeringan Desa Kemitir (KKN). Mendukung Dual-Client Authentication (Web httpOnly Cookie & Mobile Bearer JWT + Refresh Token Reuse Detection), sinkronisasi offline idempoten, serta pipeline import Shapefile (.zip) & GeoTIFF (.tif) asinkron.',
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Local Development Server (SQLite R*Tree / PostGIS)',
    },
  ],
  tags: [
    { name: 'System', description: 'Healthcheck & informasi status layanan' },
    {
      name: 'Auth',
      description:
        'Autentikasi Dual-Client (Cookie httpOnly untuk Web & Bearer/Refresh Token untuk Mobile)',
    },
    {
      name: 'Layers',
      description: 'Katalog layer spasial dinamis (Vector MVT & Raster PMTiles)',
    },
    {
      name: 'Tiles',
      description:
        'Endpoint biner Mapbox Vector Tile (.mvt) dengan ETag 304 Not Modified & LRU Cache',
    },
    {
      name: 'Observations',
      description:
        'Data observasi lapangan, filter bounding-box R*Tree/GiST, Cursor Pagination O(log N), & Batch Offline Sync',
    },
    {
      name: 'Imports',
      description:
        'Pipeline unggah asinkron Shapefile (.zip) & GeoTIFF (.tif) dengan proteksi Zip-Bomb & Zip-Slip O(E)',
    },
    {
      name: 'Summaries',
      description: 'Ringkasan statistik kekeringan instan dari Materialized View / indeks agregasi',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access Token JWT (HS256) untuk aplikasi mobile (`appgiskemitir`).',
      },
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'kemitir_at',
        description: 'Cookie `httpOnly` Access Token untuk klien web (`webgiskemitir`).',
      },
    },
    schemas: {
      ErrorEnvelope: {
        type: 'object',
        required: ['success', 'error'],
        properties: {
          success: { type: 'boolean', const: false },
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', example: 'VALIDATION_ERROR' },
              message: { type: 'string', example: 'Input permintaan tidak valid.' },
              details: { type: 'array', items: { type: 'object' } },
            },
          },
        },
      },
      PaginationMeta: {
        type: 'object',
        required: ['limit'],
        properties: {
          limit: { type: 'integer', example: 25 },
          nextCursor: {
            type: ['string', 'null'],
            example: 'MjAyNi0xMC0xOFQxMDoxNTowMC4wMDBafDQ0NDQ0NDQ0LTQ0NDQtNDQ0NC04NDQ0LTQ0NDQ0NDQ0NDQwMg',
          },
        },
      },
      UserProfile: {
        type: 'object',
        required: ['id', 'email', 'name', 'role'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email', example: 'petugas@kemitir.id' },
          name: { type: 'string', example: 'Petugas Lapangan KKN' },
          role: { type: 'string', enum: ['anon', 'petugas', 'admin'] },
        },
      },
      SpatialLayer: {
        type: 'object',
        required: [
          'id',
          'slug',
          'name',
          'description',
          'layerType',
          'geometryType',
          'minZoom',
          'maxZoom',
          'bbox',
          'styleConfig',
          'isPublic',
          'featureCount',
          'updatedAt',
          'createdAt',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          slug: { type: 'string', example: 'batas-dusun-kemitir' },
          name: {
            type: 'string',
            example: 'Batas Administrasi & Kerawanan Dusun Kemitir',
          },
          description: { type: 'string' },
          layerType: { type: 'string', enum: ['vector_mvt', 'raster_pmtiles'] },
          geometryType: {
            type: 'string',
            enum: ['Point', 'LineString', 'Polygon', 'MultiPolygon', 'Geometry', 'Raster'],
          },
          r2PmtilesKey: { type: ['string', 'null'] },
          tileUrlTemplate: {
            type: ['string', 'null'],
            example: '/api/v1/tiles/batas-dusun-kemitir/{z}/{x}/{y}.mvt',
          },
          pmtilesUrl: { type: ['string', 'null'] },
          minZoom: { type: 'integer', minimum: 0, maximum: 22, example: 0 },
          maxZoom: { type: 'integer', minimum: 0, maximum: 22, example: 18 },
          bbox: {
            type: 'array',
            items: { type: 'number' },
            minItems: 4,
            maxItems: 4,
            example: [110.285, -7.235, 110.312, -7.208],
          },
          styleConfig: { type: 'object', additionalProperties: true },
          isPublic: { type: 'boolean', example: true },
          featureCount: { type: 'integer', example: 3 },
          updatedAt: { type: 'string', format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      FieldObservation: {
        type: 'object',
        required: [
          'id',
          'clientId',
          'userId',
          'category',
          'severity',
          'title',
          'notes',
          'properties',
          'observedAt',
          'createdAt',
          'updatedAt',
          'lng',
          'lat',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          clientId: {
            type: 'string',
            format: 'uuid',
            description: 'UUID idempotensi yang dibuat di perangkat mobile saat offline.',
          },
          userId: {
            type: ['string', 'null'],
            format: 'uuid',
            description:
              'UUID petugas pembuat observasi (di-mask menjadi null untuk pemanggil anonim demi privasi).',
          },
          category: { type: 'string', example: 'mata_air' },
          severity: {
            type: 'string',
            enum: ['normal', 'waspada', 'siaga', 'awas'],
            example: 'awas',
          },
          title: { type: 'string', example: 'Mata Air Sendang Atas Mengering' },
          notes: { type: 'string' },
          properties: {
            type: 'object',
            additionalProperties: true,
            example: { debit_liter_per_detik: 0.1 },
          },
          photoR2Key: { type: ['string', 'null'] },
          observedAt: { type: 'string', format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          lng: { type: 'number', minimum: -180, maximum: 180, example: 110.304 },
          lat: { type: 'number', minimum: -90, maximum: 90, example: -7.228 },
        },
      },
      ImportJob: {
        type: 'object',
        required: [
          'id',
          'userId',
          'layerName',
          'layerSlug',
          'fileType',
          'sourceR2Key',
          'fileSizeBytes',
          'status',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          userId: { type: 'string', format: 'uuid' },
          layerName: { type: 'string', example: 'Titik Mata Air Desa Kemitir' },
          layerSlug: { type: 'string', example: 'mata-air-kemitir' },
          fileType: { type: 'string', enum: ['shapefile_zip', 'geotiff'] },
          sourceR2Key: { type: 'string' },
          fileSizeBytes: { type: 'integer', example: 24576 },
          status: {
            type: 'string',
            enum: ['pending_upload', 'pending', 'processing', 'completed', 'failed'],
          },
          errorMessage: { type: ['string', 'null'] },
          outputLayerId: { type: ['string', 'null'], format: 'uuid' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          finishedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
    },
  },
  paths: {
    '/api/v1/health': {
      get: {
        tags: ['System'],
        summary: 'Cek status kesehatan server & mode database aktif',
        responses: {
          '200': {
            description: 'Server berjalan normal',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', const: true },
                    data: {
                      type: 'object',
                      properties: {
                        service: { type: 'string', example: 'bekemitir' },
                        status: { type: 'string', example: 'healthy' },
                        dbProvider: { type: 'string', enum: ['sqlite', 'postgres'] },
                        timestamp: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/v1/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Login pengguna (Cookie httpOnly untuk Web, Token Pair untuk Mobile)',
        description:
          'Dilindungi oleh Rate Limiter (maks 10 req/menit per IP) dan verifikasi Argon2id constant-time.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email', example: 'admin@kemitir.id' },
                  password: { type: 'string', minLength: 8, example: 'AdminKemitir2026!' },
                  clientType: {
                    type: 'string',
                    enum: ['web', 'mobile'],
                    default: 'web',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Login berhasil',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', const: true },
                    data: {
                      type: 'object',
                      properties: {
                        clientType: { type: 'string', enum: ['web', 'mobile'] },
                        accessToken: {
                          type: 'string',
                          description: 'Hanya dikembalikan di body jika clientType === "mobile"',
                        },
                        refreshToken: {
                          type: 'string',
                          description: 'Hanya dikembalikan di body jika clientType === "mobile"',
                        },
                        expiresIn: { type: 'integer', example: 900 },
                        user: { $ref: '#/components/schemas/UserProfile' },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': {
            description: 'Email atau password salah',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
            },
          },
          '429': {
            description: 'Terlalu banyak percobaan login',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
            },
          },
        },
      },
    },
    '/api/v1/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary:
          'Rotasi Access & Refresh Token (dilengkapi Token Reuse Detection & Grace Window)',
        description:
          'Untuk Web membaca cookie `kemitir_rt`. Untuk Mobile membaca `refreshToken` dari body JSON. Dilengkapi Grace Window (default 15 detik) agar retry akibat sinyal lemah tidak memutus sesi, namun tetap mencabut seluruh keluarga token jika terdeteksi replay di luar grace window.',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  refreshToken: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Token berhasil dirotasi',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', const: true },
                    data: {
                      type: 'object',
                      properties: {
                        clientType: { type: 'string', enum: ['web', 'mobile'] },
                        accessToken: { type: 'string' },
                        refreshToken: { type: 'string' },
                        expiresIn: { type: 'integer', example: 900 },
                        graceRetry: {
                          type: 'boolean',
                          description:
                            'Bernilai true jika rotasi ditangani di dalam Grace Window (retry sinyal lemah).',
                        },
                        user: { $ref: '#/components/schemas/UserProfile' },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': {
            description: 'Token tidak valid, kedaluwarsa, atau terdeteksi Token Reuse',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } },
            },
          },
        },
      },
    },
    '/api/v1/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Logout & cabut keluarga refresh token aktif',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  refreshToken: {
                    type: 'string',
                    description: 'Opsional untuk aplikasi mobile saat mencabut keluarga refresh token.',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Sesi berhasil diakhiri' },
        },
      },
    },
    '/api/v1/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Ambil profil pengguna yang sedang terautentikasi',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        responses: {
          '200': {
            description: 'Profil pengguna aktif',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', const: true },
                    data: {
                      type: 'object',
                      properties: {
                        user: { $ref: '#/components/schemas/UserProfile' },
                        clientType: { type: 'string', enum: ['web', 'mobile'] },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': { description: 'Belum terautentikasi' },
        },
      },
    },
    '/api/v1/auth/users': {
      get: {
        tags: ['Auth'],
        summary: 'Daftar akun pengguna & petugas lapangan (Khusus Admin)',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        responses: {
          '200': { description: 'Daftar akun pengguna' },
          '403': { description: 'Bukan Admin' },
        },
      },
      post: {
        tags: ['Auth'],
        summary: 'Daftarkan akun petugas lapangan KKN atau admin baru (Khusus Admin)',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password', 'name'],
                properties: {
                  email: { type: 'string', format: 'email', example: 'petugas2@kemitir.id' },
                  password: {
                    type: 'string',
                    minLength: 8,
                    maxLength: 128,
                    example: 'PetugasBaru2026!',
                  },
                  name: { type: 'string', example: 'Petugas Lapangan Dusun 2' },
                  role: { type: 'string', enum: ['petugas', 'admin'], default: 'petugas' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Akun berhasil dibuat' },
          '409': { description: 'Email sudah terdaftar' },
        },
      },
    },
    '/api/v1/layers': {
      get: {
        tags: ['Layers'],
        summary: 'Daftar seluruh layer spasial (Vector MVT & Raster PMTiles)',
        responses: {
          '200': {
            description: 'Katalog layer spasial',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', const: true },
                    data: {
                      type: 'object',
                      properties: {
                        items: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/SpatialLayer' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/v1/layers/{slug}': {
      get: {
        tags: ['Layers'],
        summary: 'Detail satu layer spasial berdasarkan slug',
        parameters: [
          {
            name: 'slug',
            in: 'path',
            required: true,
            schema: { type: 'string', example: 'batas-dusun-kemitir' },
          },
        ],
        responses: {
          '200': { description: 'Detail layer ditemukan' },
          '404': { description: 'Layer tidak ditemukan' },
        },
      },
    },
    '/api/v1/layers/{id}': {
      patch: {
        tags: ['Layers'],
        summary: 'Perbarui metadata atau konfigurasi style layer (Khusus Admin)',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  styleConfig: { type: 'object', additionalProperties: true },
                  isPublic: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Layer berhasil diperbarui & cache tile di-invalidation' },
          '400': { description: 'UUID atau payload tidak valid' },
          '403': { description: 'Bukan Admin' },
          '404': { description: 'Layer tidak ditemukan' },
        },
      },
      delete: {
        tags: ['Layers'],
        summary: 'Hapus layer spasial beserta fitur vektornya (Khusus Admin)',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Layer berhasil dihapus' },
          '400': { description: 'UUID tidak valid' },
          '403': { description: 'Bukan Admin' },
          '404': { description: 'Layer tidak ditemukan' },
        },
      },
    },
    '/api/v1/tiles/{layerSlug}/{z}/{x}/{y}.mvt': {
      get: {
        tags: ['Tiles'],
        summary: 'Ambil Mapbox Vector Tile (.mvt) untuk layer tertentu atau "observations"',
        description:
          'Menghasilkan binary Protobuf MVT (`application/vnd.mapbox-vector-tile`). Mendukung header `If-None-Match` untuk respons `304 Not Modified` dalam waktu O(1). Gunakan `layerSlug = "observations"` untuk memvisualisasikan titik observasi lapangan.',
        parameters: [
          {
            name: 'layerSlug',
            in: 'path',
            required: true,
            schema: { type: 'string', example: 'batas-dusun-kemitir' },
          },
          { name: 'z', in: 'path', required: true, schema: { type: 'integer', example: 14 } },
          { name: 'x', in: 'path', required: true, schema: { type: 'integer', example: 13211 } },
          { name: 'y', in: 'path', required: true, schema: { type: 'integer', example: 8521 } },
          {
            name: 'If-None-Match',
            in: 'header',
            required: false,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Binary Mapbox Vector Tile (.mvt)',
            headers: {
              ETag: { schema: { type: 'string' } },
              'X-Tile-Cache': { schema: { type: 'string', enum: ['HIT', 'MISS'] } },
            },
            content: {
              'application/vnd.mapbox-vector-tile': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          '304': { description: 'Tile belum berubah (ETag cocok)' },
          '400': { description: 'Koordinat tile z/x/y tidak valid' },
          '404': { description: 'Layer tidak ditemukan' },
        },
      },
    },
    '/api/v1/observations': {
      get: {
        tags: ['Observations'],
        summary:
          'Daftar observasi lapangan dengan Cursor Pagination O(log N), Filter BBox 2D, & Delta Sync',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          },
          {
            name: 'cursor',
            in: 'query',
            description: 'Cursor base64url dari `meta.nextCursor` halaman sebelumnya',
            schema: { type: 'string' },
          },
          {
            name: 'severity',
            in: 'query',
            schema: { type: 'string', enum: ['normal', 'waspada', 'siaga', 'awas'] },
          },
          {
            name: 'bbox',
            in: 'query',
            description: 'Filter kotak batas WGS84: `minLng,minLat,maxLng,maxLat`',
            schema: { type: 'string', example: '110.28,-7.24,110.32,-7.20' },
          },
          {
            name: 'updatedSince',
            in: 'query',
            description:
              'Filter ISO-8601 timestamp (`updated_at >= updatedSince`) untuk sinkronisasi delta offline mobile',
            schema: { type: 'string', format: 'date-time' },
          },
        ],
        responses: {
          '200': {
            description: 'Daftar observasi terpaginasi',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', const: true },
                    data: {
                      type: 'object',
                      properties: {
                        items: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/FieldObservation' },
                        },
                      },
                    },
                    meta: { $ref: '#/components/schemas/PaginationMeta' },
                  },
                },
              },
            },
          },
          '400': { description: 'Parameter bbox atau updatedSince tidak valid' },
        },
      },
    },
    '/api/v1/observations/sync': {
      post: {
        tags: ['Observations'],
        summary:
          'Batch Offline Sync idempoten berbasis client_id dengan Poison Pill Isolation (Petugas & Admin)',
        description:
          'Memvalidasi setiap item di dalam batch secara terisolasi sehingga 1 item yang rusak tidak menggagalkan item valid lainnya. Mendukung deduplikasi `clientId` di dalam batch yang sama, pencegahan timpa mundur (`observedAt` out-of-order guard), dan validasi kepemilikan `photoR2Key`.',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 100,
                    items: {
                      type: 'object',
                      required: [
                        'clientId',
                        'category',
                        'severity',
                        'title',
                        'observedAt',
                        'lng',
                        'lat',
                      ],
                      properties: {
                        clientId: { type: 'string', format: 'uuid' },
                        category: { type: 'string', example: 'sumur_warga' },
                        severity: {
                          type: 'string',
                          enum: ['normal', 'waspada', 'siaga', 'awas'],
                        },
                        title: { type: 'string', example: 'Sumur RT 02 Menyusut' },
                        notes: { type: 'string' },
                        properties: { type: 'object', additionalProperties: true },
                        photoR2Key: { type: ['string', 'null'] },
                        observedAt: { type: 'string', format: 'date-time' },
                        lng: { type: 'number', minimum: -180, maximum: 180, example: 110.295 },
                        lat: { type: 'number', minimum: -90, maximum: 90, example: -7.226 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Hasil sinkronisasi batch beserta daftar item yang berhasil dan ditolak',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', const: true },
                    data: {
                      type: 'object',
                      properties: {
                        syncedCount: { type: 'integer', example: 2 },
                        items: {
                          type: 'array',
                          items: { $ref: '#/components/schemas/FieldObservation' },
                        },
                        rejected: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              index: { type: 'integer' },
                              clientId: { type: ['string', 'null'] },
                              reason: { type: 'string' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': { description: 'Belum login' },
        },
      },
    },
    '/api/v1/observations/photo-presign': {
      post: {
        tags: ['Observations'],
        summary: 'Minta Presigned PUT URL R2 untuk unggah foto bukti lapangan',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['contentType', 'sizeBytes'],
                properties: {
                  contentType: {
                    type: 'string',
                    enum: ['image/jpeg', 'image/png', 'image/webp'],
                  },
                  sizeBytes: { type: 'integer', minimum: 100, maximum: 10485760 },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Presigned URL berhasil dibuat' },
        },
      },
    },
    '/api/v1/imports/presign': {
      post: {
        tags: ['Imports'],
        summary:
          'Langkah 1 Import: Buat job & Presigned PUT URL untuk .zip Shapefile / .tif GeoTIFF (Khusus Admin)',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['layerName', 'layerSlug', 'fileType', 'fileSizeBytes'],
                properties: {
                  layerName: {
                    type: 'string',
                    minLength: 2,
                    maxLength: 120,
                    example: 'Jaringan Irigasi Kemitir',
                  },
                  layerSlug: {
                    type: 'string',
                    minLength: 2,
                    maxLength: 64,
                    pattern: '^[a-z0-9-]+$',
                    description:
                      'Slug URL-safe (tidak boleh menggunakan kata kunci sistem seperti "observations").',
                    example: 'irigasi-kemitir',
                  },
                  fileType: { type: 'string', enum: ['shapefile_zip', 'geotiff'] },
                  fileSizeBytes: {
                    type: 'integer',
                    minimum: 64,
                    maximum: 209715200,
                    example: 51200,
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Job dibuat dengan status pending_upload beserta uploadUrl' },
          '400': { description: 'Slug dicadangkan sistem atau ukuran file tidak valid' },
          '403': { description: 'Bukan Admin' },
        },
      },
    },
    '/api/v1/imports/{id}/enqueue': {
      post: {
        tags: ['Imports'],
        summary:
          'Langkah 2 Import: Validasi Magic Bytes & EOCD ZIP (Anti Zip-Bomb/Zip-Slip) lalu masukkan ke antrean worker',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'File lolos validasi keamanan & masuk antrean pending' },
          '400': {
            description:
              'File ditolak oleh Zip-Guard (INVALID_MAGIC_BYTES / ZIP_BOMB_DETECTED / ZIP_SLIP_DETECTED / MISSING_SHAPEFILE_COMPONENTS)',
          },
        },
      },
    },
    '/api/v1/imports': {
      get: {
        tags: ['Imports'],
        summary: 'Daftar riwayat import jobs (Khusus Admin)',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        responses: {
          '200': { description: 'Daftar import jobs' },
        },
      },
    },
    '/api/v1/imports/{id}': {
      get: {
        tags: ['Imports'],
        summary: 'Polling status satu import job (Khusus Admin)',
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Detail status import job' },
          '404': { description: 'Job tidak ditemukan' },
        },
      },
    },
    '/api/v1/summaries/drought': {
      get: {
        tags: ['Summaries'],
        summary: 'Ringkasan statistik tingkat kekeringan Desa Kemitir (O(R) dari Materialized View)',
        responses: {
          '200': {
            description: 'Ringkasan jumlah observasi per tingkat keparahan & jumlah layer publik',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', const: true },
                    data: {
                      type: 'object',
                      properties: {
                        totalObservations: { type: 'integer', example: 4 },
                        bySeverity: {
                          type: 'object',
                          properties: {
                            normal: { type: 'integer', example: 1 },
                            waspada: { type: 'integer', example: 1 },
                            siaga: { type: 'integer', example: 1 },
                            awas: { type: 'integer', example: 1 },
                          },
                        },
                        latestObservedAt: { type: ['string', 'null'], format: 'date-time' },
                        totalPublicLayers: { type: 'integer', example: 1 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
})

// Pre-serialize satu kali saat startup agar respons GET /api/v1/openapi.json berjalan O(1)
export const OPENAPI_JSON_STRING = JSON.stringify(openApiSpec, null, 2)

export const SCALAR_DOCS_HTML = `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>bekemitir — OpenAPI Documentation</title>
    <style>body { margin: 0; padding: 0; }</style>
  </head>
  <body>
    <script id="api-reference" data-url="/api/v1/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`
