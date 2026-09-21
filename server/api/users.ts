import { Router, Request, Response } from 'express';
import { createContextLogger } from '../lib/logger';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
const log = createContextLogger('USERS');
import { requireSupabaseAuth, validateBody } from '../middleware';
import {
  createUserDoc,
  createDriverDoc,
  getUserDoc,
  getDriverDoc,
  createConciergePartner,
} from '../db/helpers';
import { supabaseAdmin } from '../db/client';
import { pool } from '../db/pool';
import { randomUUID } from 'crypto';
import { notifyUser } from '../services/fcm';
import { passengerNotif, driverNotif } from '../services/notificationTemplates';

const AVATAR_ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export const userRouter = Router();

userRouter.post('/onboard', requireSupabaseAuth, validateBody(['role']), async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });

  const { role, firstName, lastName, phone, email, businessName, contactPerson } = req.body;

  try {
    if (role === 'passenger') {
      await createUserDoc(uid, { first_name: firstName, last_name: lastName, phone, email });
      // Welcome push — fire-and-forget after a 5-second delay so the token has time to register
      setTimeout(() => {
        notifyUser(uid!, passengerNotif.welcome(firstName)).catch(() => {});
      }, 5000);
      return res.json({ success: true, role: 'passenger' });
    }

    if (role === 'chauffeur') {
      await createDriverDoc(uid, { first_name: firstName, last_name: lastName, phone, email });
      setTimeout(() => {
        notifyUser(uid!, driverNotif.welcome(firstName)).catch(() => {});
      }, 5000);
      return res.json({ success: true, role: 'chauffeur' });
    }

    if (role === 'concierge') {
      await createConciergePartner(uid, { business_name: businessName, contact_person: contactPerson, phone, email });
      setTimeout(() => {
        notifyUser(uid!, {
          title: 'Welcome to URBONT Concierge',
          body: `${contactPerson ? `Hi ${contactPerson}! ` : ''}Your concierge dashboard is ready. Start dispatching premium rides for your guests.`,
          data: { type: 'concierge_welcome', screen: 'valet_home' },
        }).catch(() => {});
      }, 5000);
      return res.json({ success: true, role: 'concierge' });
    }

    return res.status(400).json({ error: 'Invalid role. Must be passenger, driver, or concierge.' });
  } catch (err) {
    log.error(`[onboard]: ${err}`);
    return res.status(500).json({ error: 'Failed to create user profile.' });
  }
});

userRouter.get('/me', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });

  try {
    const role = req.supabaseRole || 'passenger';

    if (role === 'chauffeur') {
      const doc = await getDriverDoc(uid);
      if (!doc) return res.status(404).json({ error: 'Driver profile not found.' });
      return res.json(doc);
    }

    const doc = await getUserDoc(uid);
    if (!doc) return res.status(404).json({ error: 'User profile not found.' });
    return res.json(doc);
  } catch (err) {
    log.error(`[me]: ${err}`);
    return res.status(500).json({ error: 'Failed to fetch profile.' });
  }
});

userRouter.post('/pin', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  const { pinHash } = req.body;
  if (!pinHash || typeof pinHash !== 'string' || pinHash.length < 10) {
    return res.status(400).json({ error: 'Invalid PIN hash.' });
  }
  try {
    await supabaseAdmin.from('profiles').update({ pin_hash: pinHash, updated_at: new Date().toISOString() }).eq('id', uid);
    return res.json({ success: true });
  } catch (err) {
    log.error(`[pin save]: ${err}`);
    return res.status(500).json({ error: 'Failed to save PIN.' });
  }
});

userRouter.get('/pin', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const { data } = await supabaseAdmin.from('profiles').select('pin_hash').eq('id', uid).maybeSingle();
    return res.json({ pinHash: data?.pin_hash ?? null });
  } catch (err) {
    log.error(`[pin get]: ${err}`);
    return res.status(500).json({ error: 'Failed to get PIN.' });
  }
});

userRouter.delete('/pin', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    await supabaseAdmin
      .from('profiles')
      .update({ pin_hash: null, updated_at: new Date().toISOString() })
      .eq('id', uid);
    log.info(`[pin] Cleared pin_hash for user ${uid}`);
    return res.json({ success: true });
  } catch (err) {
    log.error(`[pin delete]: ${err}`);
    return res.status(500).json({ error: 'Failed to clear PIN.' });
  }
});

userRouter.post('/verify-pin', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  const { pinHash } = req.body as { pinHash?: string };
  if (!pinHash || typeof pinHash !== 'string' || pinHash.length !== 64 || !/^[0-9a-f]+$/.test(pinHash)) {
    return res.status(400).json({ error: 'Invalid PIN hash.' });
  }
  try {
    const { data } = await supabaseAdmin
      .from('profiles')
      .select('pin_hash')
      .eq('id', uid)
      .maybeSingle();
    if (!data?.pin_hash) return res.status(404).json({ error: 'PIN not set.' });
    return res.json({ match: data.pin_hash === pinHash });
  } catch (err) {
    log.error(`[pin verify]: ${err}`);
    return res.status(500).json({ error: 'Verification failed.' });
  }
});

// Extended columns that may be absent on Supabase instances set up from an older
// version of supabase_schema.sql (before home_address, work_address, and driver
// personal-info columns were added).  We add them on first use if the pool is
// available, so the server self-heals without requiring a manual migration.
const EXTENDED_COLUMNS = [
  'home_address',
  'work_address',
  'date_of_birth',
  'drivers_license',
  'license_expiry',
  'ssn_last4',
] as const;

/** Best-effort: add any missing extended columns via the direct-SQL pool.
 *  Each column is attempted independently so a failure on one (e.g. no DDL
 *  permission on that specific column) does not prevent the rest from being
 *  added — unlike a single try/catch around the whole loop which exits on the
 *  first error and leaves the remaining columns un-migrated.
 */
async function ensureExtendedColumns(): Promise<void> {
  for (const col of EXTENDED_COLUMNS) {
    try {
      await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS "${col}" TEXT`);
    } catch {
      // Pool unavailable or no DDL permission for this column — skip it and
      // continue with the rest. Silently ignore so the server doesn't crash.
    }
  }
}

/** True when the supabaseAdmin/PostgREST error indicates a missing column.
 *
 *  Two distinct error shapes need to be handled:
 *  - PostgreSQL native:  code '42703', message "column X of relation Y does not exist"
 *  - Supabase PostgREST: code 'PGRST200', message "Could not find the 'X' column of
 *    'profiles' in the schema cache"  — PostgREST wraps PG errors and returns its own
 *    error codes; '42703' is NOT propagated, so checking only for '42703' misses these.
 */
function isColumnError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  const code = err.code ?? '';
  const msg  = err.message ?? '';
  return (
    code === '42703'    ||   // PostgreSQL: column does not exist
    code === 'PGRST200' ||   // PostgREST:  schema cache miss (most common in Supabase)
    /column .+ does not exist/i.test(msg) ||
    /could not find the .+ column/i.test(msg)  // PostgREST schema cache message
  );
}

userRouter.patch('/profile', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });

  const {
    firstName, lastName, email, phone,
    title, businessName, propertyName,
    homeAddress, workAddress,
    dateOfBirth, driversLicense, licenseExpiry, ssnLast4,
  } = req.body as {
    firstName?: string; lastName?: string; email?: string; phone?: string;
    dateOfBirth?: string; driversLicense?: string; licenseExpiry?: string; ssnLast4?: string;
    title?: string; businessName?: string; propertyName?: string;
    homeAddress?: string; workAddress?: string;
  };

  try {
    const now = new Date().toISOString();

    // ── Core fields — present in EVERY schema version, safe to always send ──
    const coreUpdate: Record<string, unknown> = { updated_at: now };
    if (firstName    !== undefined) coreUpdate.first_name    = firstName;
    if (lastName     !== undefined) coreUpdate.last_name     = lastName;
    if (email        !== undefined) coreUpdate.email         = email;
    if (phone        !== undefined) coreUpdate.phone         = phone;
    if (businessName !== undefined) coreUpdate.business_name = businessName;
    if (propertyName !== undefined) coreUpdate.business_name = propertyName;
    if (title        !== undefined) coreUpdate.title         = title;

    // ── Extended fields — may be absent on older Supabase schema deployments ─
    // home_address, work_address, and driver personal-info columns were added
    // after the initial schema; on old instances they only exist after migrations.
    const extendedUpdate: Record<string, unknown> = {};
    if (homeAddress    !== undefined) extendedUpdate.home_address    = homeAddress;
    if (workAddress    !== undefined) extendedUpdate.work_address    = workAddress;
    if (dateOfBirth    !== undefined) extendedUpdate.date_of_birth   = dateOfBirth;
    if (driversLicense !== undefined) extendedUpdate.drivers_license = driversLicense;
    if (licenseExpiry  !== undefined) extendedUpdate.license_expiry  = licenseExpiry;
    if (ssnLast4       !== undefined) extendedUpdate.ssn_last4       = ssnLast4;

    const hasExtendedFields = Object.keys(extendedUpdate).length > 0;
    const fullUpdate = { ...coreUpdate, ...extendedUpdate };

    // ── Strategy 1: supabaseAdmin with ALL fields ─────────────────────────
    const { error: fullErr } = await supabaseAdmin
      .from('profiles')
      .update(fullUpdate)
      .eq('id', uid);

    if (!fullErr) return res.json({ success: true });

    log.warn(`[profile patch] full update failed (${fullErr.code} ${fullErr.message}) — will retry`);

    // ── Unique constraint violation ───────────────────────────────────────
    // Code 23505 = PostgreSQL unique_violation.
    //
    // IMPORTANT: PostgREST puts "Key (field)=(value) already exists" in
    // fullErr.details, NOT in fullErr.message (which only says "duplicate key
    // value violates unique constraint "profiles_phone_key"").  Always check
    // details first; fall back to message for older PostgREST versions.
    if (fullErr.code === '23505') {
      const detail = fullErr.details ?? fullErr.message ?? '';
      const conflictField = /Key \(([^)]+)\)/.exec(detail)?.[1] ?? null;

      // If the 23505 is on phone or email — which are always sent as part of
      // the form state even when the driver is only editing license/SSN/address
      // — strip the conflicting field and retry so the other changes still get
      // saved.  If phone/email were the ONLY change, hasOtherChanges is false
      // and we fall through to the normal 409 so the user knows about the conflict.
      if (conflictField === 'phone' || conflictField === 'email') {
        const retryUpdate = { ...fullUpdate };
        delete retryUpdate[conflictField];
        const hasOtherChanges = Object.keys(retryUpdate).filter(k => k !== 'updated_at').length > 0;
        if (hasOtherChanges) {
          const { error: retryErr } = await supabaseAdmin
            .from('profiles')
            .update(retryUpdate)
            .eq('id', uid);
          if (!retryErr) {
            log.warn(`[profile patch] 23505 on ${conflictField} — saved other fields without it`);
            return res.json({
              success: true,
              warning: `Changes saved. Your ${conflictField} could not be updated — another account of the same type already uses it.`,
            });
          }
        }
      }

      return res.status(409).json({
        error: `That ${conflictField ?? 'field'} is already in use by another account of the same type.`,
      });
    }

    // ── Strategy 2: column error path ────────────────────────────────────
    // Triggered when any field references a column that doesn't exist yet in
    // the production DB (home_address, work_address, or driver columns added
    // after the initial schema). Auto-add all extended columns via pool, then
    // retry. Falls back to core-only fields if pool is unavailable.
    if (isColumnError(fullErr)) {
      // 2a. Try to auto-migrate ALL missing extended columns via pool.
      await ensureExtendedColumns();

      // 2b. Retry with all fields (succeeds if pool added the missing columns).
      const { error: retryErr } = await supabaseAdmin
        .from('profiles')
        .update(fullUpdate)
        .eq('id', uid);

      if (!retryErr) return res.json({ success: true });

      log.warn(`[profile patch] retry after column creation failed (${retryErr.message}) — saving core fields only`);

      // 2c. Core fields only — guaranteed to exist in every schema version.
      //     Extended fields (home_address, drivers_license, etc.) will be
      //     persisted once the DB is properly migrated.
      const { error: coreErr } = await supabaseAdmin
        .from('profiles')
        .update(coreUpdate)
        .eq('id', uid);

      if (!coreErr) {
        log.warn(`[profile patch] saved core fields only; extended columns missing in DB. Run runMigrations() or: ALTER TABLE profiles ADD COLUMN IF NOT EXISTS home_address TEXT, ADD COLUMN IF NOT EXISTS work_address TEXT, ADD COLUMN IF NOT EXISTS drivers_license TEXT, ADD COLUMN IF NOT EXISTS license_expiry TEXT, ADD COLUMN IF NOT EXISTS ssn_last4 TEXT, ADD COLUMN IF NOT EXISTS date_of_birth TEXT;`);
        // IMPORTANT: must NOT report a plain success here when extended fields were
        // requested but silently dropped — the frontend showed "Profile saved
        // successfully" while date of birth / license / address never persisted.
        // Surface `warning` (same shape the frontend already renders for the
        // unique-constraint case) so the driver knows those fields didn't save.
        return res.json({
          success: true,
          warning: hasExtendedFields
            ? 'Your name/phone/email were saved, but address, date of birth, and license fields could not be saved right now. Please try again later.'
            : undefined,
        });
      }

      log.error(`[profile patch] even core-fields update failed: ${coreErr.message}`);
    }

    // ── Strategy 3: pool direct SQL (covers non-column errors and any case
    //    where supabaseAdmin is misconfigured) ─────────────────────────────
    log.warn(`[profile patch] falling back to pool direct SQL`);
    try {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let idx = 1;
      for (const [col, val] of Object.entries(fullUpdate)) {
        // IMPORTANT: use ${idx++} (with the $ prefix) to generate proper
        // PostgreSQL parameterized placeholders ($1, $2, …).  Without the $
        // the query becomes  SET "col" = 1 WHERE id = 5  which is invalid SQL
        // (integer literals instead of parameters) and always throws.
        setClauses.push(`"${col}" = $${idx++}`);
        values.push(val);
      }
      values.push(uid);
      const result = await pool.query(
        `UPDATE profiles SET ${setClauses.join(", ")} WHERE id = $${idx}`,
        values,
      );
      if ((result.rowCount ?? 0) === 0) {
        log.warn(`[profile patch] pool UPDATE matched 0 rows for uid=${uid}`);
        return res.status(404).json({ error: 'Profile not found. Please log out and back in.' });
      }
      return res.json({ success: true });
    } catch (poolErr) {
      // Pool also failed — one last attempt with core fields via supabaseAdmin.
      log.error(`[profile patch] pool also failed: ${errMsg(poolErr)}`);
      const { error: lastErr } = await supabaseAdmin
        .from('profiles')
        .update(coreUpdate)
        .eq('id', uid);
      if (!lastErr) return res.json({ success: true });
      log.error(`[profile patch] all strategies exhausted. Last error: ${lastErr.code} ${lastErr.message}`);
      return res.status(500).json({ error: `Failed to save profile. Please try again. (${lastErr.code ?? 'unknown'})` });
    }
  } catch (err) {
    log.error(`[profile patch] unexpected error: ${errMsg(err)}`);
    return res.status(500).json({ error: errMsg(err) || 'Failed to save profile.' });
  }
});

userRouter.post('/avatar', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });

  const { mimeType, base64 } = req.body as { mimeType?: string; base64?: string };

  if (!mimeType || !base64) {
    return res.status(400).json({ error: 'Missing mimeType or base64.' });
  }

  if (!AVATAR_ALLOWED_TYPES.includes(mimeType.toLowerCase())) {
    return res.status(400).json({ error: 'Invalid file type. Only JPEG, PNG, WebP, and HEIC are allowed.' });
  }

  try {
    const rawBase64 = base64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(rawBase64, 'base64');

    if (buffer.length > AVATAR_MAX_BYTES) {
      return res.status(400).json({ error: 'Image too large. Maximum size is 5 MB.' });
    }

    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const storagePath = `${uid}/avatar_${Date.now()}_${randomUUID().substring(0, 8)}.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('avatars')
      .upload(storagePath, buffer, { contentType: mimeType, upsert: true });

    if (uploadError) {
      log.error(`[avatar upload] Storage error: ${uploadError.message}`);
      return res.status(500).json({ error: 'Upload failed. Please try again.' });
    }

    const { data: urlData } = supabaseAdmin.storage.from('avatars').getPublicUrl(storagePath);
    const avatarUrl = urlData?.publicUrl || '';

    await supabaseAdmin.from('profiles').update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() }).eq('id', uid);

    return res.json({ success: true, avatarUrl });
  } catch (err) {
    log.error(`[avatar upload]: ${err}`);
    return res.status(500).json({ error: 'Failed to upload photo.' });
  }
});

// ── POST /api/users/vehicle-photo — upload vehicle photo ─────────────────────
userRouter.post('/vehicle-photo', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  const { mimeType, base64 } = req.body as { mimeType?: string; base64?: string };
  if (!mimeType || !base64) return res.status(400).json({ error: 'Missing mimeType or base64.' });
  if (!AVATAR_ALLOWED_TYPES.includes(mimeType.toLowerCase())) return res.status(400).json({ error: 'Invalid file type.' });
  try {
    const rawBase64 = base64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(rawBase64, 'base64');
    if (buffer.length > AVATAR_MAX_BYTES) return res.status(400).json({ error: 'Image too large. Max 5 MB.' });
    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const storagePath = `${uid}/vehicle_${Date.now()}.${ext}`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from('avatars')
      .upload(storagePath, buffer, { contentType: mimeType, upsert: true });
    if (uploadError) return res.status(500).json({ error: 'Upload failed.' });
    const { data: urlData } = supabaseAdmin.storage.from('avatars').getPublicUrl(storagePath);
    const photoUrl = urlData?.publicUrl || '';
    const { data: existing } = await supabaseAdmin.from('profiles').select('vehicle').eq('id', uid).maybeSingle();
    const currentVehicle = ((existing as Record<string,unknown>)?.vehicle ?? {}) as Record<string, unknown>;
    await supabaseAdmin.from('profiles').update({
      vehicle: { ...currentVehicle, vehicle_photo_url: photoUrl },
      updated_at: new Date().toISOString(),
    }).eq('id', uid);
    return res.json({ success: true, photoUrl });
  } catch (err) {
    log.error(`[vehicle-photo upload]: ${err}`);
    return res.status(500).json({ error: 'Failed to upload.' });
  }
});

// ── T013: GET /api/users/me/trusted-contact — get trusted contact ─────────────
userRouter.get('/me/trusted-contact', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const { data: user } = await supabaseAdmin.auth.admin.getUserById(uid);
    const meta = user?.user?.user_metadata ?? {};
    return res.json({
      name:  meta.trusted_contact_name  ?? null,
      phone: meta.trusted_contact_phone ?? null,
    });
  } catch (err) {
    log.error(`[trusted-contact get]: ${err}`);
    return res.status(500).json({ error: 'Failed to fetch trusted contact.' });
  }
});

// ── T013: PUT /api/users/me/trusted-contact — save trusted contact ────────────
userRouter.put('/me/trusted-contact', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  const { name, phone } = req.body as { name?: string; phone?: string };
  if (!phone) return res.status(400).json({ error: 'Phone number is required.' });
  try {
    const { data: existing } = await supabaseAdmin.auth.admin.getUserById(uid);
    const current = existing?.user?.user_metadata ?? {};
    await supabaseAdmin.auth.admin.updateUserById(uid, {
      user_metadata: { ...current, trusted_contact_name: name ?? '', trusted_contact_phone: phone },
    });
    return res.json({ success: true });
  } catch (err) {
    log.error(`[trusted-contact put]: ${err}`);
    return res.status(500).json({ error: 'Failed to save trusted contact.' });
  }
});

// ── GET /api/users/preferences — fetch passenger ride preferences ─────────────
userRouter.get('/preferences', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const { data } = await supabaseAdmin
      .from('profiles')
      .select('preferences')
      .eq('id', uid)
      .maybeSingle();
    return res.json((data as Record<string,unknown>)?.preferences ?? {});
  } catch (err) {
    log.error(`[preferences get]: ${err}`);
    return res.status(500).json({ error: 'Failed to fetch preferences.' });
  }
});

// ── PATCH /api/users/preferences — save passenger ride preferences ────────────
// Deep-merges incoming fields with existing preferences so callers only need to
// send the keys they are changing; unrelated keys are preserved.
userRouter.patch('/preferences', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const incoming = req.body as Record<string, unknown>;

    // Fetch current preferences so we can merge (not overwrite)
    const { data: existing } = await supabaseAdmin
      .from('profiles')
      .select('preferences')
      .eq('id', uid)
      .maybeSingle();
    const current = ((existing as Record<string,unknown>)?.preferences ?? {}) as Record<string, unknown>;
    const merged = { ...current, ...incoming };

    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ preferences: merged, updated_at: new Date().toISOString() })
      .eq('id', uid);
    if (error) throw error;
    return res.json({ success: true, preferences: merged });
  } catch (err) {
    log.error(`[preferences patch]: ${err}`);
    return res.status(500).json({ error: 'Failed to save preferences.' });
  }
});

// ── DELETE /api/users/me — permanently delete account ─────────────────────────
userRouter.delete('/me', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    // 1. Anonymize ride history (retain for legal/financial audits but scrub PII)
    await supabaseAdmin.from('rides')
      .update({ passenger_name: 'Deleted User', passenger_phone: null, passenger_id: null })
      .eq('passenger_id', uid);

    // 2. Delete profile data
    await supabaseAdmin.from('profiles').delete().eq('id', uid);

    // 3. Delete Supabase auth user (if available)
    try {
      await supabaseAdmin.auth.admin.deleteUser ? (supabaseAdmin.auth.admin as { deleteUser: (uid: string) => Promise<unknown> }).deleteUser(uid) : null;
    } catch { /* ignore — auth user may already be deleted */ }

    return res.json({ success: true, message: 'Account deleted successfully.' });
  } catch (err) {
    log.error(`[delete account]: ${err}`);
    return res.status(500).json({ error: 'Failed to delete account. Please contact support.' });
  }
});

// ── GET /api/users/recurring-rides — list recurring rides ─────────────────────
userRouter.get('/recurring-rides', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('preferences')
      .eq('id', uid)
      .maybeSingle();
    if (error) throw error;
    const prefs = ((data as Record<string,unknown>)?.preferences ?? {}) as { recurring_rides?: unknown[] };
    return res.json({ rides: prefs.recurring_rides ?? [] });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load recurring rides.' });
  }
});

// ── POST /api/users/recurring-rides — create a recurring ride ─────────────────
userRouter.post('/recurring-rides', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const ride = { id: randomUUID(), active: true, ...req.body, createdAt: new Date().toISOString() };
    const { data: existing } = await supabaseAdmin.from('profiles').select('preferences').eq('id', uid).maybeSingle();
    const prefs = ((existing as Record<string,unknown>)?.preferences ?? {}) as Record<string, unknown> & { recurring_rides?: unknown[] };
    const rides = [...(prefs.recurring_rides ?? []), ride];
    await supabaseAdmin.from('profiles').update({ preferences: { ...prefs, recurring_rides: rides } }).eq('id', uid);
    return res.json({ ride });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save recurring ride.' });
  }
});

// ── PATCH /api/users/recurring-rides/:id — toggle or update recurring ride ────
userRouter.patch('/recurring-rides/:id', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  const { id } = req.params;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const { data: existing } = await supabaseAdmin.from('profiles').select('preferences').eq('id', uid).maybeSingle();
    const prefs = ((existing as Record<string,unknown>)?.preferences ?? {}) as Record<string, unknown> & { recurring_rides?: Record<string, unknown>[] };
    const rides = (prefs.recurring_rides ?? []).map((r: Record<string,unknown>) => r.id === id ? { ...r, ...req.body } : r);
    await supabaseAdmin.from('profiles').update({ preferences: { ...prefs, recurring_rides: rides } }).eq('id', uid);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update recurring ride.' });
  }
});

// ── DELETE /api/users/recurring-rides/:id — remove a recurring ride ───────────
userRouter.delete('/recurring-rides/:id', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  const { id } = req.params;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const { data: existing } = await supabaseAdmin.from('profiles').select('preferences').eq('id', uid).maybeSingle();
    const prefs = ((existing as Record<string,unknown>)?.preferences ?? {}) as Record<string, unknown> & { recurring_rides?: Record<string, unknown>[] };
    const rides = (prefs.recurring_rides ?? []).filter((r: Record<string,unknown>) => r.id !== id);
    await supabaseAdmin.from('profiles').update({ preferences: { ...prefs, recurring_rides: rides } }).eq('id', uid);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete recurring ride.' });
  }
});

// ── GET /api/users/saved-places — list user's saved places ───────────────────
userRouter.get('/saved-places', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const { data, error } = await supabaseAdmin
      .from('saved_places')
      .select('id, label, address, lat, lng, icon, sort_order')
      .eq('user_id', uid)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    return res.json(data ?? []);
  } catch (err) {
    log.error(`[saved-places get]: ${err}`);
    return res.status(500).json({ error: 'Failed to fetch saved places.' });
  }
});

// ── POST /api/users/saved-places — add a saved place ─────────────────────────
userRouter.post('/saved-places', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  const { label, address, lat, lng, icon, sort_order } = req.body as {
    label: string; address: string; lat?: number; lng?: number; icon?: string; sort_order?: number;
  };
  if (!label || !address) return res.status(400).json({ error: 'label and address are required.' });
  try {
    const { data, error } = await supabaseAdmin
      .from('saved_places')
      .insert({
        user_id: uid,
        label: label.trim(),
        address: address.trim(),
        lat: lat ?? null,
        lng: lng ?? null,
        icon: icon ?? 'map-pin',
        sort_order: sort_order ?? 0,
      })
      .select('id, label, address, lat, lng, icon, sort_order')
      .single();
    if (error) throw error;
    return res.status(201).json(data);
  } catch (err) {
    log.error(`[saved-places post]: ${err}`);
    return res.status(500).json({ error: 'Failed to save place.' });
  }
});

// ── PATCH /api/users/saved-places/:id — update a saved place ─────────────────
userRouter.patch('/saved-places/:id', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  const { id } = req.params;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  const { label, address, lat, lng, icon, sort_order } = req.body as {
    label?: string; address?: string; lat?: number; lng?: number; icon?: string; sort_order?: number;
  };
  try {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (label     !== undefined) update.label      = label.trim();
    if (address   !== undefined) update.address    = address.trim();
    if (lat       !== undefined) update.lat        = lat;
    if (lng       !== undefined) update.lng        = lng;
    if (icon      !== undefined) update.icon       = icon;
    if (sort_order!== undefined) update.sort_order = sort_order;
    const { data, error } = await supabaseAdmin
      .from('saved_places')
      .update(update)
      .eq('id', id)
      .eq('user_id', uid)
      .select('id, label, address, lat, lng, icon, sort_order')
      .single();
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    log.error(`[saved-places patch]: ${err}`);
    return res.status(500).json({ error: 'Failed to update place.' });
  }
});

// ── DELETE /api/users/saved-places/:id — remove a saved place ────────────────
userRouter.delete('/saved-places/:id', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  const { id } = req.params;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const { error } = await supabaseAdmin
      .from('saved_places')
      .delete()
      .eq('id', id)
      .eq('user_id', uid);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    log.error(`[saved-places delete]: ${err}`);
    return res.status(500).json({ error: 'Failed to delete place.' });
  }
});
