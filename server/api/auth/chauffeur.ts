import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin, supabasePublic, issueToken, verifySupabaseToken, KNOWN_SUPABASE_URL, KNOWN_ANON_KEY } from '../../db/client';
import { pool } from '../../db/pool';
import { sanitizeBody } from '../../middleware';
import { createContextLogger } from '../../lib/logger';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
const log = createContextLogger('CHAUFFEUR');

export const chauffeurAuthRouter = Router();

const DEMO_DRIVER_EMAIL    = 'driver@urbont.com';
const DEMO_DRIVER_PASSWORD = process.env.DEMO_DRIVER_PASSWORD || '';

/* ── Demo fallback: sign in via a guaranteed-correct direct Supabase client ──
   Uses the known-good public anon key baked into the Dockerfile (not a secret).
   This works even when SUPABASE_ANON_KEY in Hyperlift has a wrong value. ── */
async function demoChauffeurFallback(email: string, password: string) {
  // Never allow the hardcoded demo fallback in production — it would be a security backdoor.
  if (process.env.NODE_ENV === 'production') return null;
  if (!DEMO_DRIVER_PASSWORD) return null;  // Require explicit env var — no hardcoded default
  if (email.toLowerCase() !== DEMO_DRIVER_EMAIL || password !== DEMO_DRIVER_PASSWORD) return null;
  try {
    // Direct client with guaranteed-correct anon key
    const directClient = createClient(KNOWN_SUPABASE_URL, KNOWN_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Authenticate with Supabase — verified to work with these credentials
    const { data: authData, error: authError } = await directClient.auth.signInWithPassword({
      email: DEMO_DRIVER_EMAIL,
      password: DEMO_DRIVER_PASSWORD,
    });

    if (authError || !authData?.user) {
      log.error(`[Chauffeur/demoFallback] signInWithPassword failed: ${authError?.message}`);
      // Last resort: pool
      const poolRes = await pool.query<{
        id: string; phone: string | null; role: string | null; first_name: string | null; last_name: string | null;
        verification_status: string | null; operating_city: string | null; rejection_reason: string | null;
        vehicle: unknown; rating: number | null; avatar_url: string | null; membership: string | null; title: string | null;
      }>(
        `SELECT id, phone, role, first_name, last_name, verification_status, operating_city,
                rejection_reason, vehicle, rating, avatar_url, membership, title
         FROM public.profiles WHERE email = $1 LIMIT 1`,
        [DEMO_DRIVER_EMAIL],
      ).catch(() => null);
      if (poolRes?.rows.length) {
        const row = poolRes.rows[0];
        return { userId: row.id, role: row.role || 'chauffeur', profile: row as Record<string, unknown>, appMeta: {} as Record<string, unknown> };
      }
      return null;
    }

    const userId = authData.user.id;
    const appMeta = (authData.user.app_metadata || {}) as Record<string, unknown>;

    // Fetch full profile using the authenticated session
    const { data: profData } = await directClient
      .from('profiles')
      .select('id, phone, role, first_name, last_name, verification_status, operating_city, rejection_reason, vehicle, rating, avatar_url, membership, title, date_of_birth')
      .eq('id', userId)
      .maybeSingle();

    const role = (profData?.role as string) || (appMeta.role as string) || 'chauffeur';
    return { userId, role, profile: profData as Record<string, unknown> | null, appMeta };
  } catch (err) {
    log.error(`[Chauffeur/demoFallback] failed: ${(err as Error).message}`);
    return null;
  }
}

/* ── Per-IP rate limiter (max 20 req/min) ── */
const ipRateLimitMap = new Map<string, { count: number; resetAt: number }>();
function ipRateLimit(req: Request, res: Response, next: () => void) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = ipRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    ipRateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  entry.count++;
  if (entry.count > 20) {
    return res.status(429).json({
      error: 'Too many requests. Please wait a minute and try again.',
      errorCode: 'RATE_LIMITED',
      retryAfter: Math.ceil((entry.resetAt - now) / 1000),
    });
  }
  next();
}

/* ── Per-email login attempt tracker (5 max → 15 min lockout) ── */
const emailAttemptMap = new Map<string, { count: number; lockedUntil: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function checkEmailLockout(email: string): { locked: boolean; remainingSec: number; attemptsLeft: number } {
  const key = email.toLowerCase();
  const now = Date.now();
  const entry = emailAttemptMap.get(key);
  if (!entry) return { locked: false, remainingSec: 0, attemptsLeft: MAX_LOGIN_ATTEMPTS };
  if (entry.lockedUntil > now) {
    return { locked: true, remainingSec: Math.ceil((entry.lockedUntil - now) / 1000), attemptsLeft: 0 };
  }
  return { locked: false, remainingSec: 0, attemptsLeft: Math.max(0, MAX_LOGIN_ATTEMPTS - entry.count) };
}

function recordFailedAttempt(email: string): { attemptsLeft: number; nowLocked: boolean } {
  const key = email.toLowerCase();
  const now = Date.now();
  const entry = emailAttemptMap.get(key) || { count: 0, lockedUntil: 0 };
  if (entry.lockedUntil > now) return { attemptsLeft: 0, nowLocked: true };
  entry.count++;
  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
  emailAttemptMap.set(key, entry);
  const attemptsLeft = Math.max(0, MAX_LOGIN_ATTEMPTS - entry.count);
  return { attemptsLeft, nowLocked: entry.count >= MAX_LOGIN_ATTEMPTS };
}

function clearFailedAttempts(email: string) {
  emailAttemptMap.delete(email.toLowerCase());
}

/* ── Password strength validator ── */
function validatePasswordStrength(password: string): { error: string; errorCode: string } | null {
  if (!password || password.length < 8)
    return { error: 'Password must be at least 8 characters.', errorCode: 'PASSWORD_TOO_SHORT' };
  if (!/[A-Z]/.test(password))
    return { error: 'Password must include at least one uppercase letter.', errorCode: 'PASSWORD_NO_UPPERCASE' };
  if (!/[0-9]/.test(password))
    return { error: 'Password must include at least one number.', errorCode: 'PASSWORD_NO_NUMBER' };
  return null;
}

/* ── POST /api/chauffeur/login ── */
chauffeurAuthRouter.post('/login', sanitizeBody, ipRateLimit, async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };

  if (!email || !password) {
    return res.status(400).json({
      error: 'Email and password are required.',
      errorCode: 'MISSING_FIELDS',
      field: !email ? 'email' : 'password',
    });
  }

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return res.status(400).json({
      error: 'Please enter a valid email address.',
      errorCode: 'INVALID_EMAIL',
      field: 'email',
    });
  }

  const lock = checkEmailLockout(email);
  if (lock.locked) {
    const mins = Math.ceil(lock.remainingSec / 60);
    return res.status(429).json({
      error: `Account locked. Try again in ${mins > 1 ? `${mins} minutes` : `${lock.remainingSec} seconds`}.`,
      errorCode: 'ACCOUNT_LOCKED',
      lockedUntilSec: lock.remainingSec,
    });
  }

  try {
    // Use the anon-key client for signInWithPassword — auth sign-in should
    // always use the public client, not the service-role admin client.
    const { data, error } = await supabasePublic.auth.signInWithPassword({ email, password });

    if (error || !data?.user) {
      log.error({ errMsg: error?.message, status: error?.status }, `[Chauffeur/login] Supabase auth failed for ${email}`);

      // Demo fallback — if Supabase password is stale, bypass via admin lookup
      const demoResult = await demoChauffeurFallback(email, password);
      if (demoResult) {
        log.info(`[Chauffeur/login] Demo fallback login succeeded for ${email}`);
        clearFailedAttempts(email);
        const token = issueToken({ id: demoResult.userId, phone: (demoResult.profile?.phone as string) || email, role: demoResult.role });
        const verificationStatus = (demoResult.profile?.verification_status as string) || (demoResult.appMeta.verification_status as string) || 'approved';
        return res.json({
          success: true,
          session: { access_token: token, refresh_token: token },
          verificationStatus,
          rejectionReason: null,
          operatingCity: (demoResult.profile?.operating_city as string) || (demoResult.appMeta.operating_city as string) || 'Miami',
          user: {
            id: demoResult.userId,
            email,
            phone: (demoResult.profile?.phone as string) || '',
            firstName: (demoResult.profile?.first_name as string) || (demoResult.appMeta.first_name as string) || 'Carlos',
            lastName: (demoResult.profile?.last_name as string) || (demoResult.appMeta.last_name as string) || 'Urbont',
            role: demoResult.role,
            vehicle: (demoResult.profile?.vehicle as Record<string, unknown>) || (demoResult.appMeta.vehicle as Record<string, unknown>) || null,
            rating: (demoResult.profile?.rating as number) || 5.0,
            avatar_url: (demoResult.profile?.avatar_url as string) || null,
            membership: (demoResult.profile?.membership as string) || 'free',
            date_of_birth: (demoResult.profile?.date_of_birth as string) || null,
            title: (demoResult.profile?.title as string) || null,
          },
        });
      }

      const { attemptsLeft, nowLocked } = recordFailedAttempt(email);

      if (nowLocked) {
        const mins = Math.ceil(LOCKOUT_MS / 60000);
        return res.status(429).json({
          error: `Too many failed attempts. Account locked for ${mins} minutes.`,
          errorCode: 'ACCOUNT_LOCKED',
          lockedUntilSec: Math.ceil(LOCKOUT_MS / 1000),
          attemptsLeft: 0,
        });
      }

      const attemptsMsg = attemptsLeft <= 2
        ? ` ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} remaining before lockout.`
        : '';

      const isNotFound = error?.message?.toLowerCase().includes('invalid login') || error?.message?.toLowerCase().includes('not found');
      return res.status(401).json({
        error: `Invalid email or password.${attemptsMsg}`,
        errorCode: isNotFound ? 'EMAIL_NOT_FOUND' : 'WRONG_PASSWORD',
        attemptsLeft,
      });
    }

    const userId = data.user.id;

    // Fetch full user via admin API to get app_metadata (signInWithPassword may omit it)
    const { data: adminUser } = await supabaseAdmin.auth.admin.getUserById(userId);
    const appMeta = (adminUser?.user?.app_metadata || {}) as Record<string, unknown>;
    const userMeta = (adminUser?.user?.user_metadata || {}) as Record<string, unknown>;

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, phone, role, first_name, last_name, verification_status, operating_city, rejection_reason, vehicle, rating, avatar_url, membership, title, date_of_birth')
      .eq('id', userId)
      .maybeSingle();
    const role = (profile?.role as string) || (appMeta.role as string) || 'chauffeur';

    if (role !== 'chauffeur' && role !== 'admin') {
      return res.status(403).json({
        error: 'This account is not registered as a chauffeur. Please use the passenger app.',
        errorCode: 'ACCESS_DENIED',
        field: 'email',
      });
    }

    clearFailedAttempts(email);
    const token = issueToken({ id: userId, phone: (profile?.phone as string) || email, role });
    // Prefer profile column; fall back to app_metadata (set by admin for accounts created before schema migration)
    const verificationStatus = (profile?.verification_status as string)
      || (appMeta.verification_status as string)
      || 'pending_documents';
    const operatingCity = (profile?.operating_city as string) || (appMeta.operating_city as string) || null;
    const rejectionReason = (profile?.rejection_reason as string) || null;

    return res.json({
      success: true,
      session: { access_token: token, refresh_token: token },
      verificationStatus,
      rejectionReason,
      operatingCity,
      user: {
        id: userId,
        email: data.user.email,
        phone: (profile?.phone as string) || '',
        firstName: (profile?.first_name as string) || (appMeta.first_name as string) || '',
        lastName: (profile?.last_name as string) || (appMeta.last_name as string) || '',
        role,
        vehicle: (profile?.vehicle as Record<string, unknown>) || (userMeta.vehicle as Record<string, unknown>) || (appMeta.vehicle as Record<string, unknown>) || null,
        rating: (profile?.rating as number) || 5.0,
        avatar_url: (profile?.avatar_url as string) || null,
        membership: (profile?.membership as string) || 'free',
        title: (profile?.title as string) || null,
        date_of_birth: (profile?.date_of_birth as string) || null,
      },
    });
  } catch (err) {
    log.error(`[Chauffeur] Login error: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Authentication failed. Please try again.', errorCode: 'SERVER_ERROR' });
  }
});

/* ── POST /api/chauffeur/register ── */
chauffeurAuthRouter.post('/register', sanitizeBody, ipRateLimit, async (req: Request, res: Response) => {
  const { email, password, firstName, lastName, phone, dob, city, businessName } = req.body as {
    email: string; password: string; firstName?: string; lastName?: string;
    phone?: string; dob?: string; city?: string; businessName?: string;
  };

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.', errorCode: 'MISSING_FIELDS' });
  }

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.', errorCode: 'INVALID_EMAIL', field: 'email' });
  }

  const pwError = validatePasswordStrength(password);
  if (pwError) return res.status(400).json({ ...pwError, field: 'password' });

  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError) {
      if (authError.message?.includes('already registered') || authError.message?.includes('already exists')) {
        return res.status(409).json({
          error: 'An account with this email already exists.',
          errorCode: 'EMAIL_IN_USE',
          field: 'email',
        });
      }
      throw authError;
    }

    const userId = authData.user.id;
    const now = new Date().toISOString();

    const { error: upsertErr } = await supabaseAdmin.from('profiles').upsert({
      id: userId,
      email,
      phone: phone || null,
      first_name: firstName || null,
      last_name: lastName || null,
      role: 'chauffeur',
      membership: 'free',
      status_val: 'offline',
      rating: 5.0,
      total_rides: 0,
      background_check: { status: 'not_submitted' },
      avatar_url: '/default-avatar.svg',
      ...(dob ? { date_of_birth: dob } : {}),
      ...(city ? { operating_city: city } : {}),
      ...(businessName ? { business_name: businessName } : {}),
      created_at: now,
      updated_at: now,
    }, { onConflict: 'id', ignoreDuplicates: false });

    if (upsertErr) {
      log.error(`[Chauffeur] Profile upsert failed for ${email}: ${upsertErr.message}`);
      return res.status(500).json({ error: 'Registration failed. Please try again.', errorCode: 'SERVER_ERROR' });
    }

    const token = issueToken({ id: userId, phone: phone || email, role: 'chauffeur' });

    return res.status(201).json({
      success: true,
      session: { access_token: token, refresh_token: token },
      verificationStatus: 'pending_documents',
      user: { id: userId, email, firstName: firstName || '', lastName: lastName || '', role: 'chauffeur' },
    });
  } catch (err) {
    log.error(`[Chauffeur] Register error: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Registration failed. Please try again.', errorCode: 'SERVER_ERROR' });
  }
});

/* ── POST /api/chauffeur/oauth-login ── */
chauffeurAuthRouter.post('/oauth-login', sanitizeBody, ipRateLimit, async (req: Request, res: Response) => {
  const { accessToken } = req.body as { accessToken?: string };

  if (!accessToken) {
    return res.status(400).json({ error: 'Access token required.', errorCode: 'MISSING_TOKEN' });
  }

  try {
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
    if (userError || !userData?.user) {
      return res.status(401).json({ error: 'Invalid or expired Google session.', errorCode: 'INVALID_TOKEN' });
    }

    const { id: userId, email } = userData.user;

    const { data: profile2 } = await supabaseAdmin
      .from('profiles')
      .select('id, phone, role, first_name, last_name, verification_status, operating_city, rejection_reason')
      .eq('id', userId)
      .maybeSingle();

    if (!profile2) {
      return res.json({ needsRegistration: true, email, userId });
    }

    const role = (profile2.role as string) || 'chauffeur';
    if (role !== 'chauffeur' && role !== 'admin') {
      return res.status(403).json({
        error: 'This Google account is linked to a passenger profile, not a chauffeur account.',
        errorCode: 'ACCESS_DENIED',
      });
    }

    const token = issueToken({ id: userId, phone: (profile2.phone as string) || email || userId, role });
    const verificationStatus2 = (profile2.verification_status as string) || 'pending_documents';
    const operatingCity2 = (profile2.operating_city as string) || null;
    const rejectionReason2 = (profile2.rejection_reason as string) || null;

    return res.json({
      success: true,
      session: { access_token: token, refresh_token: token },
      verificationStatus: verificationStatus2,
      rejectionReason: rejectionReason2,
      operatingCity: operatingCity2,
      user: { id: userId, email, firstName: profile2.first_name || '', lastName: profile2.last_name || '', role },
    });
  } catch (err) {
    log.error(`[Chauffeur] OAuth login error: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Authentication failed. Please try again.', errorCode: 'SERVER_ERROR' });
  }
});

/* ── POST /api/chauffeur/complete-profile ─────────────────────────────────────
   Called to create or update a chauffeur profile. Accepts both custom JWTs
   (email/password users) and Supabase OAuth tokens (Google login).
   verifySupabaseToken handles both automatically. ─────────────────────────── */
chauffeurAuthRouter.post('/complete-profile', sanitizeBody, ipRateLimit, async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  const supabaseToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!supabaseToken) {
    return res.status(401).json({ error: 'Access token required.', errorCode: 'MISSING_TOKEN' });
  }

  const { firstName, lastName, phone, dob, city, businessName } = req.body as {
    firstName?: string; lastName?: string; phone?: string; dob?: string;
    city?: string; businessName?: string;
  };

  try {
    // Accept both custom JWTs (email/password) and Supabase OAuth tokens (Google)
    const verifiedUser = await verifySupabaseToken(supabaseToken);
    if (!verifiedUser) {
      return res.status(401).json({ error: 'Invalid or expired session.', errorCode: 'INVALID_TOKEN' });
    }

    const userId = verifiedUser.id;
    const now = new Date().toISOString();

    // Get existing profile to check role, email, and current verification status.
    // We return the real verification_status so returning Google OAuth drivers
    // don't get reset to 'pending_documents' on every sign-in.
    const { data: existing } = await supabaseAdmin
      .from('profiles')
      .select('id, role, email, verification_status')
      .eq('id', userId)
      .maybeSingle();

    if (existing && existing.role === 'passenger') {
      return res.status(403).json({
        error: 'This account is already registered as a passenger. Use a different account to register as a chauffeur.',
        errorCode: 'ACCESS_DENIED',
      });
    }

    // El correo salía solo del perfil existente, así que un alta por Google
    // —donde todavía no hay perfil— guardaba la cadena vacía y dejaba al
    // conductor sin ninguna forma de contacto, pese a venir verificado por el
    // proveedor. Se toma del token cuando el perfil aún no lo tiene.
    const email = existing?.email || verifiedUser.email || '';

    // Split new vs returning user to avoid resetting meaningful fields
    // (rating, total_rides, background_check, etc.) for existing drivers.
    let upsertErr: { message: string } | null = null;
    if (!existing) {
      // Brand-new chauffeur — insert with all defaults
      const { error } = await supabaseAdmin.from('profiles').insert({
        id: userId,
        email: email || '',
        phone: phone || null,
        first_name: firstName || null,
        last_name: lastName || null,
        role: 'chauffeur',
        membership: 'free',
        status_val: 'offline',
        rating: 5.0,
        total_rides: 0,
        background_check: { status: 'not_submitted' },
        verification_status: 'pending_documents',
        avatar_url: '/default-avatar.svg',
        ...(dob         ? { date_of_birth:  dob }         : {}),
        ...(city        ? { operating_city: city }        : {}),
        ...(businessName? { business_name: businessName } : {}),
        created_at: now,
        updated_at: now,
      });
      upsertErr = error;
    } else {
      // Returning user — only update mutable name/contact fields; never touch
      // rating, total_rides, background_check, or verification_status.
      const { error } = await supabaseAdmin.from('profiles').update({
        email: email || existing.email || '',
        ...(firstName   ? { first_name:     firstName }   : {}),
        ...(lastName    ? { last_name:      lastName }    : {}),
        ...(phone       ? { phone }                       : {}),
        ...(dob         ? { date_of_birth:  dob }         : {}),
        ...(city        ? { operating_city: city }        : {}),
        ...(businessName? { business_name: businessName } : {}),
        updated_at: now,
      }).eq('id', userId);
      upsertErr = error;
    }

    if (upsertErr) {
      log.error(`[Chauffeur] complete-profile upsert failed for userId=${userId}: ${upsertErr.message}`);
      return res.status(500).json({ error: 'Profile creation failed. Please try again.', errorCode: 'SERVER_ERROR' });
    }

    // Save city in profile if provided (belt-and-suspenders with the upsert above)
    if (city) {
      try {
        await supabaseAdmin
          .from('profiles')
          .update({ operating_city: city, updated_at: now })
          .eq('id', userId);
      } catch { /* non-critical, profile already saved above */ }
    }

    const customToken = issueToken({ id: userId, phone: phone || email || userId, role: 'chauffeur' });

    log.info(`[Chauffeur] complete-profile succeeded for userId=${userId}`);
    // Return the real verification_status so existing drivers (e.g. returning
    // Google OAuth users) see their actual status instead of being reset to
    // 'pending_documents' on every sign-in.
    const existingVerifStatus = (existing?.verification_status as string) || 'pending_documents';
    return res.status(200).json({
      success: true,
      session: { access_token: customToken, refresh_token: customToken },
      verificationStatus: existingVerifStatus,
      user: { id: userId, email: email || '', firstName: firstName || '', lastName: lastName || '', role: 'chauffeur' },
    });
  } catch (err) {
    log.error(`[Chauffeur] complete-profile error: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Profile creation failed. Please try again.', errorCode: 'SERVER_ERROR' });
  }
});
