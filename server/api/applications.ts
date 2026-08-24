/**
 * /api/applications — Driver & Valet web-signup application intake
 *
 * These endpoints are called by the website registration forms
 * (website/src/pages/driver-signup.tsx and website/src/pages/valet-signup.tsx).
 * They store the application in Supabase so the admin panel can review it,
 * and create a Supabase Auth account (email_confirm: true) so the applicant
 * can log into the mobile app once their application is approved.
 */

import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../db/client';
import { pool } from '../db/pool';
import { createContextLogger } from '../lib/logger';
import { strictRateLimiter } from '../middleware';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

const log = createContextLogger('APPLICATIONS');

export const applicationsRouter = Router();

/* ── helpers ─────────────────────────────────────────────────────────────── */
function sanitize(v: unknown): string {
  if (!v) return '';
  return String(v).trim().substring(0, 500);
}

function emailRe(e: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

/* ── POST /api/applications/driver ───────────────────────────────────────── */
applicationsRouter.post('/driver', strictRateLimiter, async (req: Request, res: Response) => {
  // Accept both JSON bodies and multipart (form-data from the website)
  const body = req.body as Record<string, unknown>;

  const email     = sanitize(body.email);
  const firstName = sanitize(body.firstName);
  const lastName  = sanitize(body.lastName);
  const phone     = sanitize(body.phone);
  const city      = sanitize(body.city);
  const birthDate = sanitize(body.birthDate);
  const idNumber  = sanitize(body.idNumber);

  // Vehicle info
  const vehicleMake  = sanitize(body.vehicleMake);
  const vehicleModel = sanitize(body.vehicleModel);
  const vehicleYear  = sanitize(body.vehicleYear);
  const vehicleColor = sanitize(body.vehicleColor);
  const licensePlate = sanitize(body.licensePlate);
  const vehicleType  = sanitize(body.vehicleType);

  if (!email || !emailRe(email)) {
    return res.status(400).json({ error: 'Valid email required.', errorCode: 'INVALID_EMAIL' });
  }
  if (!firstName || !lastName) {
    return res.status(400).json({ error: 'First and last name required.', errorCode: 'MISSING_FIELDS' });
  }

  try {
    const now = new Date().toISOString();

    // 1. Store application in driver_applications table (auto-created by migration)
    const { error: appErr } = await supabaseAdmin.from('driver_applications').upsert({
      email,
      first_name:    firstName,
      last_name:     lastName,
      phone:         phone || null,
      city:          city  || null,
      birth_date:    birthDate || null,
      id_number:     idNumber  || null,
      vehicle_make:  vehicleMake  || null,
      vehicle_model: vehicleModel || null,
      vehicle_year:  vehicleYear  || null,
      vehicle_color: vehicleColor || null,
      license_plate: licensePlate || null,
      vehicle_type:  vehicleType  || null,
      status:        'pending',
      created_at:    now,
      updated_at:    now,
    }, { onConflict: 'email', ignoreDuplicates: false });

    if (appErr) {
      // Table may not exist yet — try to create it via pool then retry
      log.warn(`[Applications/driver] driver_applications upsert failed: ${appErr.message} — trying pool fallback`);
      try {
        await pool.query(`
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
            status        VARCHAR(30) DEFAULT 'pending',
            notes         TEXT,
            created_at    TIMESTAMPTZ DEFAULT NOW(),
            updated_at    TIMESTAMPTZ DEFAULT NOW()
          );
        `);
        await pool.query(
          `INSERT INTO driver_applications
             (email, first_name, last_name, phone, city, birth_date, id_number,
              vehicle_make, vehicle_model, vehicle_year, vehicle_color, license_plate, vehicle_type,
              status, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$14)
           ON CONFLICT (email) DO UPDATE SET
             first_name=$2, last_name=$3, phone=$4, city=$5, birth_date=$6, id_number=$7,
             vehicle_make=$8, vehicle_model=$9, vehicle_year=$10, vehicle_color=$11,
             license_plate=$12, vehicle_type=$13, updated_at=$14`,
          [email, firstName, lastName, phone||null, city||null, birthDate||null, idNumber||null,
           vehicleMake||null, vehicleModel||null, vehicleYear||null, vehicleColor||null,
           licensePlate||null, vehicleType||null, now]
        );
      } catch (poolErr) {
        log.error(`[Applications/driver] pool fallback also failed: ${(poolErr as Error).message}`);
        // Continue — still try to create the auth account
      }
    }

    // 2. Create a Supabase Auth account (no password — applicant will set it on first login via reset)
    //    email_confirm: true so they don't need to verify before the admin approves them.
    //    We ignore "already exists" errors — re-applications from the same email are fine.
    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: {
        first_name: firstName,
        last_name:  lastName,
        phone,
        role:       'chauffeur',
        applied_at: now,
      },
    });

    let profileCreated = false;
    if (authData?.user?.id) {
      // 3. Create a minimal chauffeur profile so the admin panel can see them
      const userId = authData.user.id;
      const { error: profErr } = await supabaseAdmin.from('profiles').upsert({
        id:                  userId,
        email,
        phone:               phone || null,
        first_name:          firstName,
        last_name:           lastName,
        role:                'chauffeur',
        verification_status: 'pending_documents',
        operating_city:      city || null,
        membership:          'free',
        status_val:          'offline',
        avatar_url:          '/default-avatar.svg',
        created_at:          now,
        updated_at:          now,
      }, { onConflict: 'id', ignoreDuplicates: false });

      if (!profErr) profileCreated = true;
      else log.warn(`[Applications/driver] profile upsert failed: ${profErr.message}`);
    } else if (authErr && !(authErr.message?.toLowerCase().includes('already') || authErr.message?.toLowerCase().includes('exists'))) {
      log.warn(`[Applications/driver] auth user creation failed (non-duplicate): ${authErr.message}`);
    }

    log.info(`[Applications/driver] Application received from ${email} (authCreated: ${!!authData?.user?.id}, profileCreated: ${profileCreated})`);

    return res.status(201).json({
      success: true,
      message: 'Application received. We will review it within 1–2 business days.',
    });
  } catch (err) {
    log.error(`[Applications/driver] Unexpected error: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Failed to submit application. Please try again.', errorCode: 'SERVER_ERROR' });
  }
});

/* ── POST /api/applications/valet ────────────────────────────────────────── */
applicationsRouter.post('/valet', strictRateLimiter, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  const email           = sanitize(body.email);
  const firstName       = sanitize(body.firstName);
  const lastName        = sanitize(body.lastName);
  const phone           = sanitize(body.phone);
  const city            = sanitize(body.city);
  const birthDate       = sanitize(body.birthDate);
  const idNumber        = sanitize(body.idNumber);
  const experienceLevel = sanitize(body.experienceLevel);
  const venueType       = sanitize(body.venueType);
  const schedule        = sanitize(body.schedule);
  const languages       = sanitize(body.languages);

  if (!email || !emailRe(email)) {
    return res.status(400).json({ error: 'Valid email required.', errorCode: 'INVALID_EMAIL' });
  }
  if (!firstName || !lastName) {
    return res.status(400).json({ error: 'First and last name required.', errorCode: 'MISSING_FIELDS' });
  }

  try {
    const now = new Date().toISOString();

    // 1. Store application
    const { error: appErr } = await supabaseAdmin.from('valet_applications').upsert({
      email,
      first_name:       firstName,
      last_name:        lastName,
      phone:            phone || null,
      city:             city  || null,
      birth_date:       birthDate || null,
      id_number:        idNumber  || null,
      experience_level: experienceLevel || null,
      venue_type:       venueType  || null,
      schedule:         schedule   || null,
      languages:        languages  || null,
      status:           'pending',
      created_at:       now,
      updated_at:       now,
    }, { onConflict: 'email', ignoreDuplicates: false });

    if (appErr) {
      log.warn(`[Applications/valet] valet_applications upsert failed: ${appErr.message} — pool fallback`);
      try {
        await pool.query(`
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
            status          VARCHAR(30) DEFAULT 'pending',
            notes           TEXT,
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            updated_at      TIMESTAMPTZ DEFAULT NOW()
          );
        `);
        await pool.query(
          `INSERT INTO valet_applications
             (email, first_name, last_name, phone, city, birth_date, id_number,
              experience_level, venue_type, schedule, languages, status, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$12)
           ON CONFLICT (email) DO UPDATE SET
             first_name=$2, last_name=$3, phone=$4, city=$5, birth_date=$6, id_number=$7,
             experience_level=$8, venue_type=$9, schedule=$10, languages=$11, updated_at=$12`,
          [email, firstName, lastName, phone||null, city||null, birthDate||null, idNumber||null,
           experienceLevel||null, venueType||null, schedule||null, languages||null, now]
        );
      } catch (poolErr) {
        log.error(`[Applications/valet] pool fallback also failed: ${(poolErr as Error).message}`);
      }
    }

    // 2. Create Supabase Auth account
    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: {
        first_name: firstName,
        last_name:  lastName,
        phone,
        role:       'valet',
        applied_at: now,
      },
    });

    let profileCreated = false;
    if (authData?.user?.id) {
      const userId = authData.user.id;
      const { error: profErr } = await supabaseAdmin.from('profiles').upsert({
        id:             userId,
        email,
        phone:          phone || null,
        first_name:     firstName,
        last_name:      lastName,
        role:           'valet',
        operating_city: city || null,
        membership:     'free',
        status_val: 'offline',
        avatar_url:     '/default-avatar.svg',
        created_at:     now,
        updated_at:     now,
      }, { onConflict: 'id', ignoreDuplicates: false });

      if (!profErr) profileCreated = true;
      else log.warn(`[Applications/valet] profile upsert failed: ${profErr.message}`);
    } else if (authErr && !(authErr.message?.toLowerCase().includes('already') || authErr.message?.toLowerCase().includes('exists'))) {
      log.warn(`[Applications/valet] auth user creation failed (non-duplicate): ${authErr.message}`);
    }

    log.info(`[Applications/valet] Application received from ${email} (authCreated: ${!!authData?.user?.id}, profileCreated: ${profileCreated})`);

    return res.status(201).json({
      success: true,
      message: 'Application received. We will review it within 1–2 business days.',
    });
  } catch (err) {
    log.error(`[Applications/valet] Unexpected error: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Failed to submit application. Please try again.', errorCode: 'SERVER_ERROR' });
  }
});
