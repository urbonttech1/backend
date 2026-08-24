import { pool } from './pool';
import { createContextLogger } from '../lib/logger';

const log = createContextLogger('MIGRATE');

export async function runMigrations() {
  try {
    await pool.query(`
      -- ── saved_places (favorite destinations) ──────────────────────────────────
      CREATE TABLE IF NOT EXISTS saved_places (
        id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id     UUID        NOT NULL,
        label       TEXT        NOT NULL,
        address     TEXT        NOT NULL,
        lat         DOUBLE PRECISION,
        lng         DOUBLE PRECISION,
        icon        TEXT        DEFAULT 'map-pin',
        sort_order  INTEGER     DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_saved_places_user ON saved_places(user_id);

      -- ── promo_codes ───────────────────────────────────────────────────────────
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
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );

      -- ── promo_code_uses ───────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS promo_code_uses (
        id              UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        promo_code_id   UUID        NOT NULL,
        user_id         UUID        NOT NULL,
        ride_id         TEXT,
        discount_applied NUMERIC(10,2) NOT NULL,
        used_at         TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(promo_code_id, user_id)
      );

      -- ── preferred_drivers ────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS preferred_drivers (
        id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        passenger_id UUID        NOT NULL,
        driver_id    UUID        NOT NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(passenger_id, driver_id)
      );
      CREATE INDEX IF NOT EXISTS idx_preferred_drivers_passenger ON preferred_drivers(passenger_id);

      -- ── corporate_accounts ───────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS corporate_accounts (
        id                    UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        company_name          TEXT        NOT NULL,
        billing_email         TEXT        NOT NULL,
        stripe_customer_id    TEXT,
        monthly_limit         NUMERIC(10,2),
        current_month_spend   NUMERIC(10,2) DEFAULT 0,
        is_active             BOOLEAN     DEFAULT true,
        created_by            UUID,
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW()
      );

      -- ── corporate_members ────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS corporate_members (
        id                   UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        corporate_account_id UUID        NOT NULL,
        user_id              UUID        NOT NULL,
        role                 TEXT        NOT NULL DEFAULT 'member',
        is_active            BOOLEAN     DEFAULT true,
        joined_at            TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(corporate_account_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_corp_members_user ON corporate_members(user_id);

      -- ── urbont_subscriptions ─────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS urbont_subscriptions (
        id                    UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id               UUID        NOT NULL UNIQUE,
        stripe_subscription_id TEXT,
        stripe_customer_id    TEXT,
        plan                  TEXT        NOT NULL DEFAULT 'pass',
        status                TEXT        NOT NULL DEFAULT 'active',
        discount_pct          NUMERIC(5,2) DEFAULT 10,
        current_period_start  TIMESTAMPTZ,
        current_period_end    TIMESTAMPTZ,
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW()
      );

      -- ── fare_splits ──────────────────────────────────────────────────────────
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

      -- ── fare_split_payments ──────────────────────────────────────────────────
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

      -- ── ride_stops (if standalone table needed) ───────────────────────────────
      -- Stops stored as JSONB column on rides — see ALTER TABLE below

      -- ── Extend rides table ────────────────────────────────────────────────────
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS tip_amount         NUMERIC(10,2);
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS tip_pi_id          TEXT;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS promo_code_id      UUID;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS promo_discount      NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS stops              JSONB DEFAULT '[]'::jsonb;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS accessibility      BOOLEAN DEFAULT false;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancellation_fee   NUMERIC(10,2);
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancel_fee_pi_id   TEXT;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS split_fare         BOOLEAN DEFAULT false;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS split_count        INTEGER DEFAULT 1;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS corporate_acct_id  UUID;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS driver_eta_min     INTEGER;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS receipt_sent       BOOLEAN DEFAULT false;

      -- ── Extend profiles table ─────────────────────────────────────────────────
      ALTER TABLE profiles ADD COLUMN IF NOT EXISTS urbont_pass_active BOOLEAN DEFAULT false;
      ALTER TABLE profiles ADD COLUMN IF NOT EXISTS corporate_acct_id  UUID;

      -- ── Fix ride_status check constraint to include all valid statuses ─────────
      -- Drop existing restrictive constraint (if any) and replace with full set.
      ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_ride_status_check;
      ALTER TABLE rides DROP CONSTRAINT IF EXISTS ride_status_check;
      ALTER TABLE rides ADD CONSTRAINT rides_ride_status_check
        CHECK (ride_status IN ('searching','confirmed','driver_arrived','in_progress','completed','cancelled'));

      -- ── Extend rides table with timestamp columns (safe — ADD IF NOT EXISTS) ───
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS accepted_at      TIMESTAMPTZ;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS wait_started_at  TIMESTAMPTZ;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS started_at       TIMESTAMPTZ;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS wait_fee         NUMERIC(10,2);
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS locked_fare      NUMERIC(10,2);
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS base_fare_breakdown JSONB;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS dropoff_lat      DOUBLE PRECISION;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS dropoff_lng      DOUBLE PRECISION;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_lat       DOUBLE PRECISION;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_lng       DOUBLE PRECISION;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS distance_meters  DOUBLE PRECISION;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS booking_type     TEXT DEFAULT 'ondemand';
      ALTER TABLE rides ADD COLUMN IF NOT EXISTS vehicle_type     TEXT;

      -- ── driver_streaks (consecutive days online) ───────────────────────────────
      CREATE TABLE IF NOT EXISTS driver_streaks (
        driver_id        UUID        PRIMARY KEY,
        current_streak   INTEGER     NOT NULL DEFAULT 0,
        longest_streak   INTEGER     NOT NULL DEFAULT 0,
        last_active_date DATE,
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      );

      -- ── driver_quest_progress (per-week achievements log) ──────────────────────
      -- Quests themselves are computed live from the rides table. This table only
      -- records when a driver claims a completed weekly quest (for badges/history).
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

      -- ── user_push_tokens — multi-device FCM token store ───────────────────────
      -- Original schema had user_id as PK (one token per user).
      -- Recreate as a proper multi-device table keyed on token.
      -- We use CREATE TABLE IF NOT EXISTS so a fresh DB gets the right schema,
      -- then ALTER TABLE IF EXISTS for existing DBs that have the old columns.
      CREATE TABLE IF NOT EXISTS user_push_tokens (
        id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id     UUID        NOT NULL,
        token       TEXT        NOT NULL,
        platform    TEXT        NOT NULL DEFAULT 'android',
        device_id   TEXT,
        active      BOOLEAN     NOT NULL DEFAULT true,
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(token)
      );
      CREATE INDEX IF NOT EXISTS idx_user_push_tokens_user   ON user_push_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_user_push_tokens_active ON user_push_tokens(user_id, active);

      -- Existing DBs: add missing columns safely
      ALTER TABLE user_push_tokens ADD COLUMN IF NOT EXISTS platform   TEXT    NOT NULL DEFAULT 'android';
      ALTER TABLE user_push_tokens ADD COLUMN IF NOT EXISTS device_id  TEXT;
      ALTER TABLE user_push_tokens ADD COLUMN IF NOT EXISTS active      BOOLEAN NOT NULL DEFAULT true;

      -- ── notifications — add type and data columns ─────────────────────────────
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type TEXT    NOT NULL DEFAULT 'system';
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data JSONB   DEFAULT '{}'::jsonb;
    `);
    log.info('Migrations applied successfully');
  } catch (err: any) {
    log.error({ err: err.message }, 'Migration error (non-fatal — tables may already exist)');
  }
}
