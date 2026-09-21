import { pool } from './pool';
import { logger } from '../lib/logger';
import { catalogoSemilla } from '../services/docCatalog';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export async function runMigrations() {
  const client = await pool.connect();
  try {
    // ─── Core Tables ───────────────────────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        id            UUID PRIMARY KEY,
        phone         VARCHAR(20) UNIQUE,
        email         VARCHAR(255),
        first_name    VARCHAR(100),
        last_name     VARCHAR(100),
        avatar_url    TEXT,
        role          VARCHAR(30) NOT NULL DEFAULT 'passenger',
        membership_type VARCHAR(30) DEFAULT 'standard',
        status_val    VARCHAR(30) DEFAULT 'offline',
        rating        NUMERIC(3,2) DEFAULT 5.0,
        total_rides   INTEGER DEFAULT 0,
        vehicle       JSONB,
        background_check JSONB,
        verification_status VARCHAR(50) DEFAULT 'pending_documents',
        rejection_reason TEXT,
        operating_city VARCHAR(100),
        commission_rate NUMERIC(5,2) DEFAULT 10,
        commission_type VARCHAR(50) DEFAULT 'cash_at_pickup',
        total_referrals INTEGER DEFAULT 0,
        membership    VARCHAR(30) DEFAULT 'free',
        -- Driver personal info columns — included here so they exist from initial
        -- table creation rather than requiring a separate safeAlter pass.
        date_of_birth    TEXT,
        drivers_license  TEXT,
        license_expiry   TEXT,
        ssn_last4        TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rides (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        passenger_id       UUID REFERENCES profiles(id) ON DELETE SET NULL,
        driver_id          UUID REFERENCES profiles(id) ON DELETE SET NULL,
        vehicle_type       VARCHAR(50) NOT NULL,
        pickup             JSONB NOT NULL,
        dropoff            JSONB NOT NULL,
        fare               NUMERIC(10,2),
        distance           NUMERIC(10,2),
        duration_minutes   INTEGER,
        payment_method     VARCHAR(50),
        payment_intent_id  TEXT,
        notes              TEXT,
        scheduled_at       TIMESTAMPTZ,
        ride_status        VARCHAR(30) NOT NULL DEFAULT 'searching',
        completed_at       TIMESTAMPTZ,
        cancelled_at       TIMESTAMPTZ,
        cancel_reason      TEXT,
        rating             SMALLINT,
        flight_number      TEXT,
        airline            TEXT,
        airport_mode       VARCHAR(20),
        created_at         TIMESTAMPTZ DEFAULT NOW(),
        updated_at         TIMESTAMPTZ DEFAULT NOW()
      );
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='rides' AND column_name='airline') THEN
          ALTER TABLE rides ADD COLUMN airline TEXT;
        END IF;
      END
      $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS driver_documents (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id      UUID REFERENCES profiles(id) ON DELETE CASCADE,
        doc_key        VARCHAR(100) NOT NULL,
        document_type  VARCHAR(100),
        status         VARCHAR(30) NOT NULL DEFAULT 'pending',
        storage_url    TEXT,
        image_url      TEXT,
        file_name      VARCHAR(255),
        driver_name    VARCHAR(255),
        expiry_date    DATE,
        notified_30d   BOOLEAN DEFAULT false,
        notified_7d    BOOLEAN DEFAULT false,
        rejection_reason TEXT,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_driver_doc UNIQUE (driver_id, doc_key)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID REFERENCES profiles(id) ON DELETE CASCADE,
        title       VARCHAR(255) NOT NULL,
        body        TEXT,
        type        VARCHAR(50) DEFAULT 'system',
        read        BOOLEAN DEFAULT false,
        data        JSONB,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS incidents (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ride_id         UUID REFERENCES rides(id) ON DELETE SET NULL,
        driver_id       UUID REFERENCES profiles(id) ON DELETE SET NULL,
        passenger_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
        reported_by_id  UUID REFERENCES profiles(id) ON DELETE SET NULL,
        reporter_role   VARCHAR(30) NOT NULL,
        reporter_name   VARCHAR(255),
        incid_type      VARCHAR(100),
        severity        VARCHAR(20) DEFAULT 'low',
        incid_status    VARCHAR(30) DEFAULT 'open',
        location        TEXT,
        description     TEXT,
        notes           TEXT,
        resolution      TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id        UUID REFERENCES profiles(id) ON DELETE SET NULL,
        ride_id        UUID REFERENCES rides(id) ON DELETE SET NULL,
        user_name      VARCHAR(255),
        user_phone     VARCHAR(20),
        user_type      VARCHAR(30) DEFAULT 'passenger',
        category       VARCHAR(100),
        subject        VARCHAR(500) NOT NULL,
        description    TEXT,
        status         VARCHAR(30) DEFAULT 'open',
        priority       VARCHAR(20) DEFAULT 'normal',
        assigned_to    VARCHAR(255),
        admin_notes    TEXT,
        resolved_at    TIMESTAMPTZ,
        messages       JSONB DEFAULT '[]',
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS complaints (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ride_id         UUID REFERENCES rides(id) ON DELETE SET NULL,
        user_id         UUID REFERENCES profiles(id) ON DELETE SET NULL,
        driver_id       UUID REFERENCES profiles(id) ON DELETE SET NULL,
        user_name       VARCHAR(255),
        user_phone      VARCHAR(20),
        user_type       VARCHAR(30) DEFAULT 'passenger',
        complaint_type  VARCHAR(100),
        priority        VARCHAR(20) DEFAULT 'normal',
        comp_status     VARCHAR(30) DEFAULT 'open',
        description     TEXT,
        resolution      TEXT,
        admin_notes     TEXT,
        resolved_at     TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS client_feedback (
        id            SERIAL PRIMARY KEY,
        user_id       VARCHAR(255),
        type          VARCHAR(50) NOT NULL DEFAULT 'trip_review',
        category      VARCHAR(100),
        rating        INTEGER,
        area_ratings  JSONB,
        comment       TEXT,
        chauffeur_id  VARCHAR(255),
        trip_id       VARCHAR(255),
        is_anonymous  BOOLEAN DEFAULT false,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ─── Safe Column Additions (for existing Supabase tables) ─────────────────

    const safeAlter = async (sql: string) => {
      try { await client.query(sql); } catch { /* column already exists */ }
    };

    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS verification_status VARCHAR(50) DEFAULT 'pending_documents'`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS operating_city VARCHAR(100)`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2) DEFAULT 10`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS commission_type VARCHAR(50) DEFAULT 'cash_at_pickup'`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS total_referrals INTEGER DEFAULT 0`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS membership VARCHAR(30) DEFAULT 'free'`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS pin_hash TEXT`);

    await safeAlter(`ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS storage_url    TEXT`);
    await safeAlter(`ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS image_url      TEXT`);
    await safeAlter(`ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS doc_key        VARCHAR(100)`);
    await safeAlter(`ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS document_type  VARCHAR(100)`);
    await safeAlter(`ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS driver_name    VARCHAR(255)`);
    await safeAlter(`ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS file_name      VARCHAR(255)`);
    await safeAlter(`ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS expiry_date    DATE`);
    await safeAlter(`ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);
    await safeAlter(`ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS notified_30d   BOOLEAN DEFAULT false`);
    await safeAlter(`ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS notified_7d    BOOLEAN DEFAULT false`);

    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS flight_number TEXT`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS airline TEXT`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS airport_mode VARCHAR(20)`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_pin VARCHAR(6)`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS dispatched_by_valet BOOLEAN DEFAULT false`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS valet_booking_ref VARCHAR(50)`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS guest_name VARCHAR(255)`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS guest_phone VARCHAR(30)`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS dispatch_35m_sent BOOLEAN DEFAULT false`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS dispatch_15m_sent BOOLEAN DEFAULT false`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS stops JSONB`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS platform_fee_amount NUMERIC(10,2)`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS stripe_transfer_id TEXT`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_account_id VARCHAR(100)`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_connect_status VARCHAR(30) DEFAULT 'not_connected'`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS valet_user_id UUID REFERENCES profiles(id) ON DELETE SET NULL`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS valet_commission_paid BOOLEAN DEFAULT false`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS valet_commission_transfer_id TEXT`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS payment_status VARCHAR(30) DEFAULT 'pending'`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS payment_error TEXT`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_lat NUMERIC(9,6)`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_lng NUMERIC(9,6)`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS dropoff_lat NUMERIC(9,6)`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS dropoff_lng NUMERIC(9,6)`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS booking_type VARCHAR(30) DEFAULT 'now'`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS hourly_hours NUMERIC(4,1)`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancel_reason TEXT`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS urbont_credits NUMERIC(10,2) NOT NULL DEFAULT 0.00`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS total_requests_received INTEGER DEFAULT 0`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS needs_review BOOLEAN DEFAULT false`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS rating_flagged_at TIMESTAMPTZ`);

    // ── Rides schema compatibility (Supabase vs pool CREATE TABLE alignment) ──────
    // The Supabase DB was initialised with supabase_schema.sql which uses
    // pickup_address / dropoff_address TEXT columns, while the server API
    // inserts/reads pickup JSONB and dropoff JSONB.  Add the JSONB columns and
    // relax the NOT NULL constraints so both schemas can coexist.
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup JSONB`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS dropoff JSONB`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS payment_intent_id TEXT`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS distance NUMERIC(10,2)`);
    // Ensure TEXT address columns exist regardless of how the Supabase schema was initialised.
    // Some deployments use pickup JSONB / dropoff JSONB exclusively and never had the TEXT columns.
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_address TEXT`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS dropoff_address TEXT`);
    // Drop NOT NULL on columns that the server does not always populate
    await safeAlter(`ALTER TABLE rides ALTER COLUMN pickup_address DROP NOT NULL`);
    await safeAlter(`ALTER TABLE rides ALTER COLUMN dropoff_address DROP NOT NULL`);
    await safeAlter(`ALTER TABLE rides ALTER COLUMN fare DROP NOT NULL`);

    // Valet dispatch passenger/luggage counts
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS passengers INTEGER DEFAULT 1`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS luggage INTEGER DEFAULT 0`);
    // Valet $10 surcharge stored separately so receipts and driver-cash reconciliation can split it from the base fare
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS valet_surcharge NUMERIC(10,2)`);

    // ── Driver vehicle + background_check on profiles (missing from Supabase schema) ─
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS vehicle JSONB`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS background_check JSONB`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS membership_type VARCHAR(30) DEFAULT 'standard'`);
    // ── Driver personal info fields (for onboarding parity with Uber/Lyft) ──────
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS date_of_birth TEXT`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS drivers_license TEXT`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS license_expiry TEXT`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ssn_last4 TEXT`);

    // ─── Driver Locations (real-time GPS tracking) ─────────────────────────────

    // ─── Support Tickets — safe column additions for legacy schema ────────────
    // The table may have been created with the old schema (ticket_status, no description/ride_id).
    // These safeAlter calls bring any existing table up to the current spec.
    await safeAlter(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS status       VARCHAR(30) DEFAULT 'open'`);
    await safeAlter(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS description  TEXT`);
    await safeAlter(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS ride_id      UUID REFERENCES rides(id) ON DELETE SET NULL`);
    await safeAlter(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS admin_notes  TEXT`);
    await safeAlter(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolved_at  TIMESTAMPTZ`);
    await safeAlter(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS user_name    VARCHAR(255)`);
    // Columns referenced by /api/admin support-tickets INSERT but missing from legacy schema
    await safeAlter(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS user_phone   VARCHAR(20)`);
    await safeAlter(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS user_type    VARCHAR(30) DEFAULT 'passenger'`);
    await safeAlter(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS category     VARCHAR(100)`);
    await safeAlter(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS priority     VARCHAR(20) DEFAULT 'normal'`);
    await safeAlter(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_to  VARCHAR(255)`);
    await safeAlter(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS messages     JSONB DEFAULT '[]'::jsonb`);
    await safeAlter(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ DEFAULT NOW()`);
    await safeAlter(`ALTER TABLE support_tickets ALTER COLUMN subject DROP NOT NULL`);
    await safeAlter(`ALTER TABLE support_tickets ALTER COLUMN message DROP NOT NULL`);

    // ─── Incidents — same pattern: legacy schema is missing most columns ──────
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS driver_id       UUID REFERENCES profiles(id) ON DELETE SET NULL`);
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS passenger_id    UUID REFERENCES profiles(id) ON DELETE SET NULL`);
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS reported_by_id  UUID REFERENCES profiles(id) ON DELETE SET NULL`);
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS reporter_role   VARCHAR(30)`);
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS reporter_name   VARCHAR(255)`);
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS incid_type      VARCHAR(100)`);
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS severity        VARCHAR(20) DEFAULT 'low'`);
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS incid_status    VARCHAR(30) DEFAULT 'open'`);
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS location        TEXT`);
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS description     TEXT`);
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS notes           TEXT`);
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS resolution      TEXT`);
    // Reportes del conductor desde la pantalla Help (api/driver-incidents.ts):
    // coordenadas exactas, cuándo ocurrió y las rutas de las fotos en el bucket
    // privado `incident-photos`. `location` sigue como texto para el panel.
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS lat             NUMERIC(9,6)`);
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS lng             NUMERIC(9,6)`);
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS occurred_at     TIMESTAMPTZ`);
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS attachments     JSONB NOT NULL DEFAULT '[]'`);
    await safeAlter(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ DEFAULT NOW()`);
    // Legacy `type` and `details` columns may be NOT NULL — relax them so new INSERTs work
    await safeAlter(`ALTER TABLE incidents ALTER COLUMN type DROP NOT NULL`);
    await safeAlter(`ALTER TABLE incidents ALTER COLUMN details DROP NOT NULL`);
    await safeAlter(`ALTER TABLE incidents ALTER COLUMN user_id DROP NOT NULL`);

    // ─── Push Notification Tokens ─────────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_push_tokens (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        token       TEXT NOT NULL UNIQUE,
        platform    VARCHAR(10) NOT NULL DEFAULT 'web' CHECK (platform IN ('ios', 'android', 'web')),
        device_id   TEXT,
        active      BOOLEAN NOT NULL DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS driver_locations (
        driver_id   UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
        lat         NUMERIC(10,7) NOT NULL,
        lng         NUMERIC(10,7) NOT NULL,
        heading     NUMERIC(5,1) DEFAULT 0,
        speed       NUMERIC(6,2) DEFAULT 0,
        is_online   BOOLEAN DEFAULT true,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ─── Enable Supabase Realtime on new table ─────────────────────────────────

    try {
      await client.query(`ALTER PUBLICATION supabase_realtime ADD TABLE driver_locations`);
    } catch { /* already in publication */ }
    try {
      await client.query(`ALTER PUBLICATION supabase_realtime ADD TABLE notifications`);
    } catch { /* already in publication */ }

    // ─── Indexes ───────────────────────────────────────────────────────────────

    const safeIndex = async (sql: string) => {
      try { await client.query(sql); } catch { /* index already exists */ }
    };

    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_profiles_phone ON profiles(phone)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_rides_passenger ON rides(passenger_id)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_id)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(ride_status)`);
    await safeAlter(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'system'`);
    await safeAlter(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read BOOLEAN DEFAULT false`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_driver_docs_driver ON driver_documents(driver_id)`);
    // Named UNIQUE constraint — required for Supabase PostgREST onConflict upsert.
    // Using DO...END so it is idempotent (no IF NOT EXISTS for ALTER TABLE ADD CONSTRAINT).
    try {
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'driver_documents_driver_doc_key_unique'
              AND conrelid = 'driver_documents'::regclass
          ) THEN
            ALTER TABLE driver_documents
              ADD CONSTRAINT driver_documents_driver_doc_key_unique
              UNIQUE (driver_id, doc_key);
          END IF;
        END $$
      `);
    } catch (constraintErr) {
      logger.warn(`[migrations] driver_documents unique constraint: ${(constraintErr as Error).message}`);
    }
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_complaints_user ON complaints(user_id)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(comp_status)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON user_push_tokens(user_id) WHERE active = true`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_push_tokens_token ON user_push_tokens(token)`);

    // ─── PostGIS: Geospatial driver search ────────────────────────────────────

    // Enable PostGIS extension (Supabase includes it by default)
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
    } catch { /* might need superuser on some plans */ }

    // Ensure updated_at exists on driver_locations (table may have been created without it)
    await safeAlter(`ALTER TABLE driver_locations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
    await safeAlter(`ALTER TABLE driver_locations ADD COLUMN IF NOT EXISTS heading NUMERIC(5,1) DEFAULT 0`);
    await safeAlter(`ALTER TABLE driver_locations ADD COLUMN IF NOT EXISTS speed NUMERIC(6,2) DEFAULT 0`);
    await safeAlter(`ALTER TABLE driver_locations ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT true`);

    // Add geography column to driver_locations (keeps lat/lng for compat)
    await safeAlter(`
      ALTER TABLE driver_locations
      ADD COLUMN IF NOT EXISTS location GEOGRAPHY(Point, 4326)
    `);

    // Backfill location from existing lat/lng rows
    try {
      await client.query(`
        UPDATE driver_locations
        SET location = ST_SetSRID(ST_MakePoint(lng::float8, lat::float8), 4326)::geography
        WHERE location IS NULL AND lat IS NOT NULL AND lng IS NOT NULL
      `);
    } catch { /* postgis not yet enabled on this plan */ }

    // GIST spatial index — enables O(log n) ST_DWithin queries
    await safeIndex(`
      CREATE INDEX IF NOT EXISTS idx_driver_locations_gist
      ON driver_locations USING GIST(location)
    `);

    // Index on is_online + updated_at for filtering active drivers
    await safeIndex(`
      CREATE INDEX IF NOT EXISTS idx_driver_locations_online_updated
      ON driver_locations(is_online, updated_at DESC)
    `);

    // RPC function: find_nearby_drivers — requires PostGIS; skip silently if unavailable
    try { await client.query(`
      DROP FUNCTION IF EXISTS find_nearby_drivers;
      CREATE OR REPLACE FUNCTION public.find_nearby_drivers(
        ref_lat    FLOAT8,
        ref_lng    FLOAT8,
        radius_km  FLOAT8 DEFAULT 10,
        max_results INT DEFAULT 20
      )
      RETURNS TABLE (
        driver_id   UUID,
        lat         NUMERIC,
        lng         NUMERIC,
        heading     NUMERIC,
        speed       NUMERIC,
        updated_at  TIMESTAMPTZ,
        distance_km FLOAT8
      )
      LANGUAGE SQL
      STABLE
      SECURITY DEFINER
      AS $$
        SELECT
          dl.driver_id,
          dl.lat,
          dl.lng,
          dl.heading,
          dl.speed,
          dl.updated_at,
          (ST_Distance(
            dl.location,
            ST_SetSRID(ST_MakePoint(ref_lng, ref_lat), 4326)::geography
          ) / 1000)::FLOAT8 AS distance_km
        FROM driver_locations dl
        WHERE
          dl.is_online = true
          AND dl.location IS NOT NULL
          AND dl.updated_at > NOW() - INTERVAL '5 minutes'
          AND ST_DWithin(
            dl.location,
            ST_SetSRID(ST_MakePoint(ref_lng, ref_lat), 4326)::geography,
            radius_km * 1000
          )
        ORDER BY dl.location <-> ST_SetSRID(ST_MakePoint(ref_lng, ref_lat), 4326)::geography
        LIMIT max_results;
      $$;
    `); } catch { /* PostGIS not available — /api/drivers/nearby will use Haversine fallback */ }

    // ─── App Config (maintenance_mode, min_version, surge_multiplier) ──────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_config (
        key        VARCHAR(100) PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      INSERT INTO app_config (key, value) VALUES
        ('maintenance_mode', 'false'),
        ('min_version', '1.0.0'),
        ('surge_multiplier', '1.0')
      ON CONFLICT (key) DO NOTHING;
    `);

    // ─── Ride Audit Log ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ride_logs (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ride_id         UUID REFERENCES rides(id) ON DELETE CASCADE,
        old_status      VARCHAR(30),
        new_status      VARCHAR(30) NOT NULL,
        changed_by_id   UUID,
        changed_by_role VARCHAR(30),
        gps_lat         NUMERIC,
        gps_lng         NUMERIC,
        metadata        JSONB DEFAULT '{}',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_ride_logs_ride_id ON ride_logs(ride_id)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_ride_logs_created_at ON ride_logs(created_at DESC)`);

    // ─── Ride Chat Messages ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ride_chats (
        id            BIGSERIAL PRIMARY KEY,
        ride_id       TEXT NOT NULL,
        sender_role   VARCHAR(20) NOT NULL,
        original_text TEXT NOT NULL,
        translated_text TEXT,
        source_lang   VARCHAR(10) DEFAULT 'en',
        target_lang   VARCHAR(10) DEFAULT 'es',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // ─── Catálogo de documentos, administrable desde el panel ───────────────
    // Antes vivía sólo en el código (server/services/docCatalog.ts). Se siembra
    // con esas mismas listas; a partir de ahí manda la tabla.
    await client.query(`
      CREATE TABLE IF NOT EXISTS document_catalog (
        doc_key    VARCHAR(40) PRIMARY KEY,
        label      TEXT NOT NULL,
        category   TEXT NOT NULL,
        hint       TEXT DEFAULT '',
        expires    BOOLEAN NOT NULL DEFAULT false,
        active     BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    for (const d of catalogoSemilla()) {
      // ON CONFLICT DO NOTHING: lo que el panel haya cambiado no se pisa en el
      // siguiente arranque.
      await client.query(
        `INSERT INTO document_catalog (doc_key, label, category, hint, expires, active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (doc_key) DO NOTHING`,
        [d.key, d.label, d.category, d.hint, d.expires, d.active, d.sortOrder],
      );
    }

    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_ride_chats_ride_id ON ride_chats(ride_id)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_ride_chats_created_at ON ride_chats(created_at ASC)`);
    // Notas de voz subidas como archivo (bucket privado ride-chat-audio).
    await client.query(`
      ALTER TABLE ride_chats
        ADD COLUMN IF NOT EXISTS audio_path        TEXT,
        ADD COLUMN IF NOT EXISTS audio_mime        TEXT,
        ADD COLUMN IF NOT EXISTS audio_duration_ms INTEGER;
    `);
    // Un archivo, un mensaje: evita que el mismo voiceNoteId se envíe dos veces.
    await safeIndex(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ride_chats_audio_path ON ride_chats(audio_path) WHERE audio_path IS NOT NULL`);

    // ─── Driver Scoring & Verification ───────────────────────────────────────
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS priority_score     NUMERIC(4,2) DEFAULT 1.00`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trips_completed    INTEGER      DEFAULT 0`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trips_rejected     INTEGER      DEFAULT 0`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS consecutive_rejections INTEGER  DEFAULT 0`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_blocked         BOOLEAN      DEFAULT FALSE`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS block_reason       TEXT`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS selfie_due_at      TIMESTAMPTZ`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_selfie_at     TIMESTAMPTZ`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trips_since_selfie INTEGER      DEFAULT 0`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS selfie_threshold   INTEGER      DEFAULT 25`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS driver_selfie_log (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id   UUID REFERENCES profiles(id) ON DELETE CASCADE,
        captured_at TIMESTAMPTZ DEFAULT NOW(),
        verified    BOOLEAN DEFAULT TRUE,
        trigger_reason VARCHAR(30)
      );
    `);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_selfie_log_driver_id ON driver_selfie_log(driver_id)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_selfie_log_captured_at ON driver_selfie_log(captured_at DESC)`);
    await safeIndex(`
      CREATE INDEX IF NOT EXISTS idx_profiles_priority
        ON profiles(priority_score DESC)
        WHERE role IN ('driver','chauffeur')
    `);

    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(100)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS gift_requests (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type       VARCHAR(30) NOT NULL,
        details    JSONB NOT NULL DEFAULT '{}',
        status     VARCHAR(30) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await safeAlter(`ALTER TABLE gift_requests ADD COLUMN IF NOT EXISTS requester_user_id UUID REFERENCES profiles(id) ON DELETE SET NULL`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_gift_requests_user ON gift_requests(requester_user_id)`);

    // ─── Passenger Account Security ───────────────────────────────────────────
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS account_status    VARCHAR(20)  DEFAULT 'active'`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS status_reason     TEXT`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS suspension_until  TIMESTAMPTZ`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS infraction_count  INTEGER      DEFAULT 0`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_flagged_at   TIMESTAMPTZ`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS account_infractions (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id          UUID REFERENCES profiles(id) ON DELETE CASCADE,
        infraction_type  VARCHAR(50) NOT NULL,
        severity         VARCHAR(20) NOT NULL,
        description      TEXT,
        action_taken     VARCHAR(50),
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        created_by       UUID
      );
    `);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_account_infractions_user ON account_infractions(user_id)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_account_infractions_created ON account_infractions(created_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS device_sessions (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        fingerprint    TEXT NOT NULL,
        user_id        UUID REFERENCES profiles(id) ON DELETE CASCADE,
        ip_address     TEXT,
        user_agent     TEXT,
        first_seen_at  TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at   TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await safeIndex(`CREATE UNIQUE INDEX IF NOT EXISTS idx_device_sessions_fp_user ON device_sessions(fingerprint, user_id)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_device_sessions_fp ON device_sessions(fingerprint)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_device_sessions_user ON device_sessions(user_id)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_profiles_account_status ON profiles(account_status)`);

    // ─── Passenger profile extra fields ──────────────────────────────────────
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS title         VARCHAR(20)`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS business_name  VARCHAR(255)`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS hotel_name     VARCHAR(255)`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS date_of_birth  DATE`);

    // ─── Referral Code on Profiles ────────────────────────────────────────────
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS referral_code  VARCHAR(20) UNIQUE`);
    // Backfill referral codes for existing profiles that don't have one yet
    try {
      await client.query(`
        UPDATE profiles
        SET referral_code = UPPER(SUBSTRING(REPLACE(id::text, '-', ''), 1, 8))
        WHERE referral_code IS NULL
      `);
    } catch { /* ignore if concurrent update */ }

    // ─── Referrals Table ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        referrer_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        referred_user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
        name             VARCHAR(255),
        status           VARCHAR(30) NOT NULL DEFAULT 'Pending',
        reward_amount    NUMERIC(10,2) DEFAULT 0,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_user_id)`);

    // ─── Web Push Subscriptions ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        endpoint   TEXT NOT NULL UNIQUE,
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)`);

    // ── Passenger soft-delete for ride history ──────────────────────────────────
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS hidden_by_passenger BOOLEAN DEFAULT false`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_rides_hidden ON rides(hidden_by_passenger, passenger_id)`);

    // ── Passenger home / work address (persistent saved locations) ─────────────
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS home_address TEXT`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS work_address TEXT`);

    // ── Passenger ride preferences (music, conversation, temp, door, amenities) ─
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}'`);

    // ── FEATURE PACK: Uber-parity features ─────────────────────────────────────

    // Saved places (favorite destinations)
    await client.query(`
      CREATE TABLE IF NOT EXISTS saved_places (
        id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id    UUID        NOT NULL,
        label      TEXT        NOT NULL,
        address    TEXT        NOT NULL,
        lat        DOUBLE PRECISION,
        lng        DOUBLE PRECISION,
        icon       TEXT        DEFAULT 'star',
        sort_order INTEGER     DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_saved_places_user ON saved_places(user_id)`);

    // Promo codes
    await client.query(`
      CREATE TABLE IF NOT EXISTS promo_codes (
        id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        code            TEXT        UNIQUE NOT NULL,
        description     TEXT,
        discount_type   TEXT        NOT NULL DEFAULT 'percent',
        discount_value  NUMERIC(10,2) NOT NULL,
        max_uses        INTEGER,
        used_count      INTEGER     DEFAULT 0,
        min_ride_amount NUMERIC(10,2) DEFAULT 0,
        expires_at      TIMESTAMPTZ,
        is_active       BOOLEAN     DEFAULT true,
        vehicle_class   TEXT        DEFAULT 'all',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Backfill vehicle_class for tables created before this column was added
    await safeAlter(`ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS vehicle_class TEXT DEFAULT 'all'`);

    // Promo code redemptions (one per user per code)
    await client.query(`
      CREATE TABLE IF NOT EXISTS promo_code_uses (
        id               UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        promo_code_id    UUID        NOT NULL,
        user_id          UUID        NOT NULL,
        ride_id          TEXT,
        discount_applied NUMERIC(10,2) NOT NULL,
        used_at          TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(promo_code_id, user_id)
      );
    `);

    // Preferred drivers (passenger can favourite specific drivers)
    await client.query(`
      CREATE TABLE IF NOT EXISTS preferred_drivers (
        id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        passenger_id UUID        NOT NULL,
        driver_id    UUID        NOT NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(passenger_id, driver_id)
      );
    `);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_preferred_drivers_pass ON preferred_drivers(passenger_id)`);

    // Corporate accounts
    await client.query(`
      CREATE TABLE IF NOT EXISTS corporate_accounts (
        id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        company_name        TEXT        NOT NULL,
        billing_email       TEXT        NOT NULL,
        stripe_customer_id  TEXT,
        monthly_limit       NUMERIC(10,2),
        current_month_spend NUMERIC(10,2) DEFAULT 0,
        is_active           BOOLEAN     DEFAULT true,
        created_by          UUID,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Corporate members
    await client.query(`
      CREATE TABLE IF NOT EXISTS corporate_members (
        id                   UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        corporate_account_id UUID        NOT NULL,
        user_id              UUID        NOT NULL,
        role                 TEXT        NOT NULL DEFAULT 'member',
        is_active            BOOLEAN     DEFAULT true,
        joined_at            TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(corporate_account_id, user_id)
      );
    `);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_corp_members_user ON corporate_members(user_id)`);

    // URBONT Pass subscriptions
    await client.query(`
      CREATE TABLE IF NOT EXISTS urbont_subscriptions (
        id                     UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id                UUID        NOT NULL UNIQUE,
        stripe_subscription_id TEXT,
        stripe_customer_id     TEXT,
        plan                   TEXT        NOT NULL DEFAULT 'pass',
        status                 TEXT        NOT NULL DEFAULT 'active',
        discount_pct           NUMERIC(5,2) DEFAULT 10,
        current_period_start   TIMESTAMPTZ,
        current_period_end     TIMESTAMPTZ,
        created_at             TIMESTAMPTZ DEFAULT NOW(),
        updated_at             TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Split fare sessions
    await client.query(`
      CREATE TABLE IF NOT EXISTS fare_splits (
        id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        ride_id     TEXT        NOT NULL,
        token       TEXT        UNIQUE NOT NULL,
        total_cents INTEGER     NOT NULL,
        split_count INTEGER     NOT NULL DEFAULT 2,
        paid_count  INTEGER     NOT NULL DEFAULT 0,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS fare_split_payments (
        id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        fare_split_id     UUID        NOT NULL,
        payer_name        TEXT,
        payer_email       TEXT,
        amount_cents      INTEGER     NOT NULL,
        payment_intent_id TEXT,
        status            TEXT        DEFAULT 'pending',
        paid_at           TIMESTAMPTZ,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── New columns on existing tables ─────────────────────────────────────────
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS tip_amount        NUMERIC(10,2)`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS tip_pi_id         TEXT`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS promo_code_id     UUID`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS promo_discount     NUMERIC(10,2) DEFAULT 0`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS stops             JSONB DEFAULT '[]'::jsonb`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS accessibility     BOOLEAN DEFAULT false`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancellation_fee  NUMERIC(10,2)`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancel_fee_pi_id  TEXT`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS split_fare        BOOLEAN DEFAULT false`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS split_count       INTEGER DEFAULT 1`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS corporate_acct_id UUID`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS driver_eta_min    INTEGER`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS receipt_sent      BOOLEAN DEFAULT false`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS urbont_pass_active BOOLEAN DEFAULT false`);
    await safeAlter(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS corporate_acct_id  UUID`);

    // ── Timestamp / extended columns that the API uses ───────────────────────────
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS accepted_at      TIMESTAMPTZ`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS wait_started_at  TIMESTAMPTZ`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS started_at       TIMESTAMPTZ`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS wait_fee         NUMERIC(10,2)`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS locked_fare      NUMERIC(10,2)`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS base_fare_breakdown JSONB`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS dropoff_lat      DOUBLE PRECISION`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS dropoff_lng      DOUBLE PRECISION`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_lat       DOUBLE PRECISION`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_lng       DOUBLE PRECISION`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS distance_meters  DOUBLE PRECISION`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS surge_multiplier NUMERIC(4,2) DEFAULT 1.0`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS distance_miles   NUMERIC(10,4)`);
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS booking_type     TEXT DEFAULT 'ondemand'`);

    // ── Fix ride_status check constraint to include all operational statuses ──────
    // Includes 'scheduled' (Uber/Lyft model: pre-dispatch state for future bookings)
    // and 'driver_arrived' (driver at pickup, wait timer running).
    try {
      await client.query(`ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_ride_status_check`);
      await client.query(`ALTER TABLE rides DROP CONSTRAINT IF EXISTS ride_status_check`);
      await client.query(`ALTER TABLE rides ADD CONSTRAINT rides_ride_status_check CHECK (ride_status IN ('scheduled','searching','confirmed','driver_arrived','in_progress','completed','cancelled'))`);
    } catch { /* ignore if constraint management fails */ }

    // ─── Feedback / Disputes ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS feedback (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
        ride_id    UUID REFERENCES rides(id) ON DELETE SET NULL,
        type       VARCHAR(50) NOT NULL DEFAULT 'general',
        category   VARCHAR(100),
        rating     INTEGER,
        comment    TEXT,
        metadata   JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_feedback_ride ON feedback(ride_id)`);

    // ─── Favorite Drivers (passenger bookmarks) ───────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS favorite_drivers (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        passenger_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        driver_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(passenger_id, driver_id)
      );
    `);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_fav_drivers_passenger ON favorite_drivers(passenger_id)`);

    // ─── Airport Queue (FIFO driver queue at MIA / FLL / OPF) ────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS airport_queue (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        airport_code VARCHAR(10) NOT NULL DEFAULT 'MIA',
        position     INTEGER NOT NULL DEFAULT 1,
        active       BOOLEAN NOT NULL DEFAULT true,
        joined_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_airport_queue_driver ON airport_queue(driver_id)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_airport_queue_active ON airport_queue(airport_code, active, joined_at)`);

    // ─── Driver Stats (streaks, acceptance, earnings) ────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS driver_stats (
        driver_id          UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
        consecutive_trips  INTEGER      NOT NULL DEFAULT 0,
        total_earned       NUMERIC(10,2) NOT NULL DEFAULT 0,
        trips_accepted     INTEGER      NOT NULL DEFAULT 0,
        trips_offered      INTEGER      NOT NULL DEFAULT 0,
        trips_completed    INTEGER      NOT NULL DEFAULT 0,
        last_updated       TIMESTAMPTZ  DEFAULT NOW()
      );
    `);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_driver_stats_driver ON driver_stats(driver_id)`);

    // RPC: upsert_driver_stats_accept — atomically increment trips_accepted + trips_offered
    try {
      await client.query(`
        CREATE OR REPLACE FUNCTION public.upsert_driver_stats_accept(p_driver_id UUID)
        RETURNS void
        LANGUAGE SQL
        SECURITY DEFINER
        AS $$
          INSERT INTO driver_stats (driver_id, trips_accepted, trips_offered, last_updated)
          VALUES (p_driver_id, 1, 1, NOW())
          ON CONFLICT (driver_id) DO UPDATE
            SET trips_accepted = driver_stats.trips_accepted + 1,
                trips_offered  = driver_stats.trips_offered  + 1,
                last_updated   = NOW();
        $$;
      `);
    } catch { /* ignore if DB doesn't support */ }

    // ── driver_streaks (consecutive days online) ─────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS driver_streaks (
        driver_id        UUID        PRIMARY KEY,
        current_streak   INTEGER     NOT NULL DEFAULT 0,
        longest_streak   INTEGER     NOT NULL DEFAULT 0,
        last_active_date DATE,
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── driver_quest_progress (per-week claimed quests log) ──────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS driver_quest_progress (
        id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        driver_id    UUID        NOT NULL,
        quest_key    TEXT        NOT NULL,
        week_start   DATE        NOT NULL,
        completed_at TIMESTAMPTZ DEFAULT NOW(),
        reward_paid  BOOLEAN     DEFAULT false,
        UNIQUE (driver_id, quest_key, week_start)
      );
      CREATE INDEX IF NOT EXISTS idx_quest_progress_driver ON driver_quest_progress(driver_id);
    `);

    // ─── Admin Panel Users ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        email         TEXT        UNIQUE NOT NULL,
        password_hash TEXT        NOT NULL,
        name          TEXT        NOT NULL,
        role          TEXT        NOT NULL DEFAULT 'support'
                        CHECK (role IN ('owner','developer','support','operations','analyst')),
        active        BOOLEAN     NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login    TIMESTAMPTZ
      );
    `);

      // NOTE: The hardcoded admin_users seed (owner/developer/support/operations/analyst)
      // was intentionally removed from here. It used ON CONFLICT (email) DO UPDATE and
      // ran on every server start/deploy, which reset admin passwords/names/roles to
      // fixed values baked into source control on every restart. Admin accounts must
      // now be provisioned through a separate, controlled mechanism (manual seeding
      // script, env-driven bootstrap, or admin panel) — never automatically at startup.
      await safeIndex(`CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users(email)`);

    // ─── Rides: Ensure all columns exist (idempotent, Supabase + pool) ─────────
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='rides' AND column_name='ride_status') THEN
            ALTER TABLE rides ADD COLUMN ride_status TEXT DEFAULT 'searching';
            UPDATE rides SET ride_status = status WHERE ride_status IS NULL;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='rides' AND column_name='vehicle_type') THEN
            ALTER TABLE rides ADD COLUMN vehicle_type TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='rides' AND column_name='duration_minutes') THEN
            ALTER TABLE rides ADD COLUMN duration_minutes INTEGER;
            UPDATE rides SET duration_minutes = duration WHERE duration_minutes IS NULL;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='rides' AND column_name='payment_method') THEN
            ALTER TABLE rides ADD COLUMN payment_method TEXT DEFAULT 'card';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='rides' AND column_name='notes') THEN
            ALTER TABLE rides ADD COLUMN notes TEXT;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='rides' AND column_name='scheduled_at') THEN
            ALTER TABLE rides ADD COLUMN scheduled_at TIMESTAMPTZ;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='rides' AND column_name='updated_at') THEN
            ALTER TABLE rides ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
          END IF;
        END
        $$;
      `);

    // ─── Driver & Valet Application Intake ───────────────────────────────────
    // These tables store applications submitted from the website signup forms
    // (website/src/pages/driver-signup.tsx and website/src/pages/valet-signup.tsx).
    await client.query(`
      CREATE TABLE IF NOT EXISTS driver_applications (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email         VARCHAR(255) UNIQUE NOT NULL,
        first_name    VARCHAR(100),
        last_name     VARCHAR(100),
        phone         VARCHAR(20),
        city          VARCHAR(100),
        birth_date    DATE,
        id_number     VARCHAR(100),
        vehicle_make  VARCHAR(100),
        vehicle_model VARCHAR(100),
        vehicle_year  VARCHAR(10),
        vehicle_color VARCHAR(50),
        license_plate VARCHAR(20),
        vehicle_type  VARCHAR(50),
        status        VARCHAR(30) NOT NULL DEFAULT 'pending',
        notes         TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_driver_apps_status ON driver_applications(status)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_driver_apps_email ON driver_applications(email)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS valet_applications (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email           VARCHAR(255) UNIQUE NOT NULL,
        first_name      VARCHAR(100),
        last_name       VARCHAR(100),
        phone           VARCHAR(20),
        city            VARCHAR(100),
        birth_date      DATE,
        id_number       VARCHAR(100),
        experience_level VARCHAR(50),
        venue_type      VARCHAR(50),
        schedule        VARCHAR(50),
        languages       VARCHAR(100),
        status          VARCHAR(30) NOT NULL DEFAULT 'pending',
        notes           TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_valet_apps_status ON valet_applications(status)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_valet_apps_email ON valet_applications(email)`);

        // Reload PostgREST schema cache so Supabase JS client sees the new tables and functions
    // ── Client-side error reports ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS client_errors (
        id               SERIAL PRIMARY KEY,
        error_id         VARCHAR(64),
        message          TEXT NOT NULL,
        stack            TEXT,
        component_stack  TEXT,
        url              TEXT,
        user_agent       TEXT,
        reported_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS client_errors_reported_at_idx ON client_errors (reported_at DESC);
    `);

    // Dedup columns for horizontal scaling & prevent duplicate push notifications.
    // Backing columns for the atomic compare-and-swap claims in server/jobs/cron.ts
    // (sendScheduledRideReminders / sendRateReminders). Must exist before those
    // jobs run or their .eq('reminder_*_sent', false) filters fail.
    await client.query(`
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS reminder_24h_sent BOOLEAN DEFAULT false;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS reminder_1h_sent BOOLEAN DEFAULT false;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS rate_reminder_sent BOOLEAN DEFAULT false;
      CREATE INDEX IF NOT EXISTS rides_reminders_idx ON rides (ride_status, scheduled_at) WHERE ride_status = 'scheduled';
    `);

    // ── Auditoría de esquema (2026-09) ────────────────────────────────────────

    // `rides.no_show` / `no_show_fee`: server/api/rides/cancel.ts las escribía
    // desde siempre, pero NUNCA se crearon. PostgREST rechazaba el update entero
    // por columna inexistente, así que la cancelación por no-show cobraba el
    // cargo en Stripe y luego dejaba el viaje activo, en silencio, porque el
    // resultado del update tampoco se comprobaba.
    await client.query(`
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS no_show     BOOLEAN DEFAULT FALSE;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS no_show_fee NUMERIC(10,2) DEFAULT 0;
    `);

    // Un chofer sólo puede estar una vez en la cola de un aeropuerto. Sin esto,
    // reintentos o dobles taps lo duplicaban y le daban varios turnos.
    await safeIndex(
      `CREATE UNIQUE INDEX IF NOT EXISTS airport_queue_driver_airport_unique
         ON airport_queue (driver_id, airport_code)`,
    );

    // `payment_method` admitía cualquier string. Los únicos valores que el código
    // distingue son 'card' y 'cash' (rides/stats.ts, rides/valet.ts); cualquier
    // otro haría que el cobro se saltara silenciosamente esas ramas.
    //
    // OJO: deliberadamente NO se restringe `vehicle_type`. Guarda nombres de
    // display libres ('Business Class', 'Premium SUV', 'Van & Sprinter') y el
    // emparejamiento con choferes usa ilike (rides/accept.ts:71-110), así que un
    // CHECK contra las claves canónicas de VEHICLE_FARE_RULES rechazaría toda
    // reserva real. Normalizar en escritura con VEHICLE_ALIAS es requisito previo.
    // Guardado contra el catálogo: ADD CONSTRAINT no admite IF NOT EXISTS, y sin
    // esto el segundo arranque fallaría. Mismo idioma que chauffeur-docs.ts.
    await safeAlter(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'rides_payment_method_check'
        ) THEN
          ALTER TABLE rides ADD CONSTRAINT rides_payment_method_check
            CHECK (payment_method IS NULL OR payment_method IN ('card','cash'));
        END IF;
      END $$;
    `);

    // Sin updated_at no se puede auditar ni sincronizar incrementalmente.
    await safeAlter(`ALTER TABLE ride_logs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

    // Dos columnas más que el código consultaba y nunca se crearon. Postgres
    // rechaza el SELECT entero cuando una sola columna falta, así que cada una
    // rompía su endpoint por completo.
    //
    // `driver_earnings` SIN DEFAULT a propósito: el webhook de Stripe busca los
    // pagos pendientes con `.not('driver_earnings','is',null)`, y un default de 0
    // haría que no encontrara ninguno nunca.
    await client.query(`
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS driver_earnings NUMERIC(10,2);
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS long_pickup_fee NUMERIC(10,2) DEFAULT 0;
    `);

    // ── Zonas de servicio ─────────────────────────────────────────────────────
    //
    // Saca la geocerca del código a la base, para poder abrir una ciudad desde el
    // panel en vez de con un despliegue. Antes era un círculo con centro y radio
    // hardcodeados en rides/create.ts.
    //
    // Por ahora sólo círculos.
    //
    // El plan contemplaba una columna `boundary GEOGRAPHY(POLYGON)` para refinar
    // la forma después, pero PostGIS está instalado en el esquema `tiger` —efecto
    // colateral de postgis_tiger_geocoder— y no en `public` ni `extensions`, así
    // que el tipo `geography` no se resuelve desde aquí. Los círculos no lo
    // necesitan: la verificación es aritmética en memoria. Cuando se quiera pasar
    // a polígonos habrá que reubicar la extensión primero.
    await client.query(`
      CREATE TABLE IF NOT EXISTS service_zones (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        active      BOOLEAN NOT NULL DEFAULT true,
        -- El surge se calcula con la hora local de la ciudad, no la del servidor.
        timezone    TEXT NOT NULL DEFAULT 'America/New_York',
        center_lat  NUMERIC(10,6) NOT NULL,
        center_lng  NUMERIC(10,6) NOT NULL,
        radius_km   NUMERIC(8,2)  NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Un radio de 0 dejaría la zona sin cubrir nada.
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_zones_radius_check') THEN
          ALTER TABLE service_zones ADD CONSTRAINT service_zones_radius_check CHECK (radius_km > 0);
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_service_zones_active ON service_zones (active) WHERE active;
    `);

    // El país de la zona. Hoy todas son 'US' y nada lo usa todavía, pero sale
    // gratis en cuanto la zona se crea eligiendo una ciudad del catálogo, y es
    // lo que después necesitarán la moneda, el país de la cuenta de Stripe y el
    // filtro de países del buscador de direcciones.
    // Ver docs/GEOCERCA_INTERNACIONAL.md.
    await safeAlter(`ALTER TABLE service_zones ADD COLUMN IF NOT EXISTS country_code CHAR(2) NOT NULL DEFAULT 'US'`);

    // ── Catálogo de ciudades ────────────────────────────────────────────────
    //
    // Poblado desde GeoNames (scripts/import-cities.mjs), no a mano. Existe para
    // que el panel deje de pedir coordenadas: se escribe «Bogotá» y de ahí salen
    // el centro, la zona horaria y el país.
    //
    // NO participa en la geocerca. La resolución sigue siendo lat/lng contra los
    // círculos de `service_zones`, en memoria. Esta tabla sólo sirve para elegir
    // un centro y para explicar qué cubre un radio.
    //
    // La tabla se crea vacía. Si nadie corre el importador, el buscador del panel
    // no devuelve nada y se siguen escribiendo coordenadas a mano: se degrada,
    // no se rompe.
    await client.query(`
      CREATE TABLE IF NOT EXISTS cities (
        geoname_id   INTEGER PRIMARY KEY,
        name         TEXT    NOT NULL,
        -- Sin acentos. Es contra esta columna que se busca, para que «Bogota»
        -- encuentre «Bogotá» sin obligar a nadie a teclear tildes.
        ascii_name   TEXT    NOT NULL,
        country_code CHAR(2) NOT NULL,
        admin1       TEXT,
        lat          NUMERIC(9,5) NOT NULL,
        lng          NUMERIC(9,5) NOT NULL,
        population   INTEGER NOT NULL DEFAULT 0,
        -- IANA, tal cual viene de GeoNames: 'America/Bogota', 'Europe/Madrid'.
        timezone     TEXT    NOT NULL
      );

      -- Búsqueda por prefijo: lower(ascii_name) LIKE 'madr%'. text_pattern_ops es
      -- lo que hace que ese LIKE use el índice en vez de recorrer 34.000 filas.
      CREATE INDEX IF NOT EXISTS idx_cities_name
        ON cities (lower(ascii_name) text_pattern_ops);

      -- Prefiltro de caja para «qué ciudades hay alrededor de este centro»,
      -- el mismo truco que usa serviceZones.ts en memoria.
      CREATE INDEX IF NOT EXISTS idx_cities_latlng ON cities (lat, lng);

      -- Desempate: entre dos ciudades del mismo nombre gana la más poblada.
      -- Sin esto, «Madrid» devuelve la de Colombia (135.000 hab.) antes que la
      -- de España (3.255.944), y se abriría servicio en el sitio equivocado.
      CREATE INDEX IF NOT EXISTS idx_cities_population ON cities (population DESC);
    `);

    // Semilla: exactamente el círculo que estaba en el código. Sin ON CONFLICT
    // DO UPDATE — si alguien ya ajustó el radio desde el panel, no se pisa.
    await client.query(`
      INSERT INTO service_zones (id, name, timezone, center_lat, center_lng, radius_km)
      VALUES ('miami', 'Miami / Sur de Florida', 'America/New_York', 25.761700, -80.191800, 125)
      ON CONFLICT (id) DO NOTHING
    `);

    // La zona en la que se creó el viaje, congelada como locked_fare: el pasajero
    // aceptó un precio que pertenece a una zona, y cruzar una frontera a mitad de
    // trayecto no debe cambiarlo.
    await safeAlter(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS zone_id TEXT`);

    // ─── Historial de viajes por conductor ──────────────────────────────────────
    // `rides.driver_id` sólo guarda al conductor actual: cuando uno cancela un
    // viaje aceptado o el sistema se lo reasigna, el viaje vuelve a `searching` y
    // pierde ese dato, y a quien sólo se le ofreció nunca lo tuvo. Sin esta tabla
    // su ficha del panel y su pestaña Trips no podían mostrar esos viajes.
    await client.query(`
      CREATE TABLE IF NOT EXISTS driver_ride_events (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ride_id    UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
        driver_id  UUID NOT NULL,
        event      VARCHAR(30) NOT NULL CHECK (event IN ('offered', 'driver_cancelled', 'reassigned', 'rejected')),
        reason     TEXT,
        metadata   JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await safeIndex(`CREATE UNIQUE INDEX IF NOT EXISTS uq_driver_ride_events ON driver_ride_events (ride_id, driver_id, event)`);
    await safeIndex(`CREATE INDEX IF NOT EXISTS idx_driver_ride_events_driver ON driver_ride_events (driver_id, created_at DESC)`);

    // `rejected`: el conductor rechazó la oferta. Hace falta para medir la
    // aceptación por viaje —aceptadas ÷ (aceptadas + rechazadas)—. La restricción
    // original no lo admitía, y en las bases que ya tenían la tabla el CREATE de
    // arriba no hace nada: se reemplaza aquí. Sólo amplía los valores permitidos.
    try {
      await client.query(`
        DO $$
        DECLARE c text;
        BEGIN
          FOR c IN
            SELECT conname FROM pg_constraint
             WHERE conrelid = 'driver_ride_events'::regclass
               AND contype = 'c'
               AND pg_get_constraintdef(oid) ILIKE '%event%'
          LOOP
            EXECUTE format('ALTER TABLE driver_ride_events DROP CONSTRAINT %I', c);
          END LOOP;
          ALTER TABLE driver_ride_events ADD CONSTRAINT driver_ride_events_event_check
            CHECK (event IN ('offered', 'driver_cancelled', 'reassigned', 'rejected'));
        END $$;
      `);
    } catch (err) {
      logger.warn(`[Migrations] driver_ride_events: no se pudo admitir el evento 'rejected': ${(err as Error).message}`);
    }

    // NOTA — `find_nearby_drivers` sigue rota: referencia
    // `driver_locations.location`, una columna GEOGRAPHY que nunca se creó, así
    // que el RPC falla en cada despacho y socketService cae a una consulta manual
    // sin índice espacial. Arreglarla exige PostGIS accesible, y hoy vive en el
    // esquema `tiger` (ver la nota de service_zones). Queda pendiente de reubicar
    // la extensión; el repliegue actual funciona, sólo que sin índice.

    // Reload PostgREST schema cache so Supabase JS client sees the new tables and functions
    try {
      await client.query(`NOTIFY pgrst, 'reload schema'`);
    } catch { /* ignore */ }

    logger.info('[Migrations] ✓ All tables and indexes are up to date.');
  } catch (err) {
    logger.error({ err: errMsg(err) }, '[Migrations] Error');
    throw err;
  } finally {
    client.release();
  }
}
