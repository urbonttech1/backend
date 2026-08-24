import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin, supabasePublic, issueToken, KNOWN_SUPABASE_URL, KNOWN_ANON_KEY } from '../../db/client';
import { pool } from '../../db/pool';
import { sanitizeBody } from '../../middleware';
import { createContextLogger } from '../../lib/logger';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
const log = createContextLogger('VALET');

export const valetAuthRouter = Router();

const DEMO_VALET_EMAIL    = 'valet@urbont.com';
const DEMO_VALET_PASSWORD = process.env.DEMO_VALET_PASSWORD || '';

/* ── Demo fallback: sign in via a guaranteed-correct direct Supabase client ──
   Uses the known-good public anon key baked into the Dockerfile (not a secret).
   This works even when SUPABASE_ANON_KEY in Hyperlift has a wrong value. ── */
async function demoValetFallback(email: string, password: string) {
  // Only allow the demo fallback when explicitly opted-in via env var.
  // This prevents the backdoor from being active even if NODE_ENV is not set correctly.
  if (process.env.DEMO_ACCOUNTS_ENABLED !== 'true') return null;
  if (!DEMO_VALET_PASSWORD) return null;  // Require explicit env var — no hardcoded default
  if (email.toLowerCase() !== DEMO_VALET_EMAIL || password !== DEMO_VALET_PASSWORD) return null;
  try {
    // Direct client with guaranteed-correct anon key
    const directClient = createClient(KNOWN_SUPABASE_URL, KNOWN_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Authenticate with Supabase — we've verified this works
    const { data: authData, error: authError } = await directClient.auth.signInWithPassword({
      email: DEMO_VALET_EMAIL,
      password: DEMO_VALET_PASSWORD,
    });

    if (authError || !authData?.user) {
      log.error(`[Valet/demoFallback] signInWithPassword failed: ${authError?.message}`);
      // Last resort: pool (works only if SUPABASE_DB_URL is IPv4-accessible)
      const poolRes = await pool.query<{ id: string; phone: string | null; role: string | null; first_name: string | null; last_name: string | null }>(
        `SELECT id, phone, role, first_name, last_name FROM public.profiles WHERE email = $1 LIMIT 1`,
        [DEMO_VALET_EMAIL],
      ).catch(() => null);
      if (poolRes?.rows.length) {
        const row = poolRes.rows[0];
        return { userId: row.id, role: row.role || 'valet', profile: row as Record<string, unknown> };
      }
      return null;
    }

    const userId = authData.user.id;
    // Fetch profile using the authenticated session token
    const { data: profData } = await directClient
      .from('profiles')
      .select('id, phone, role, first_name, last_name')
      .eq('id', userId)
      .maybeSingle();

    return {
      userId,
      role: (profData?.role as string) || (authData.user.user_metadata?.role as string) || 'valet',
      profile: profData as Record<string, unknown> | null,
    };
  } catch (err) {
    log.error(`[Valet/demoFallback] failed: ${(err as Error).message}`);
    return null;
  }
}

/* ── IP rate limiter ── */
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
    return res.status(429).json({ error: 'Too many requests. Please wait and try again.', errorCode: 'RATE_LIMITED' });
  }
  next();
}

/* ── Per-email lockout ── */
const emailAttemptMap = new Map<string, { count: number; lockedUntil: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function checkLockout(email: string) {
  const key = email.toLowerCase();
  const now = Date.now();
  const entry = emailAttemptMap.get(key);
  if (!entry) return { locked: false, remainingSec: 0, attemptsLeft: MAX_ATTEMPTS };
  if (entry.lockedUntil > now)
    return { locked: true, remainingSec: Math.ceil((entry.lockedUntil - now) / 1000), attemptsLeft: 0 };
  return { locked: false, remainingSec: 0, attemptsLeft: Math.max(0, MAX_ATTEMPTS - entry.count) };
}

function recordFail(email: string) {
  const key = email.toLowerCase();
  const now = Date.now();
  const entry = emailAttemptMap.get(key) || { count: 0, lockedUntil: 0 };
  if (entry.lockedUntil > now) return { attemptsLeft: 0, nowLocked: true };
  entry.count++;
  if (entry.count >= MAX_ATTEMPTS) entry.lockedUntil = now + LOCKOUT_MS;
  emailAttemptMap.set(key, entry);
  return { attemptsLeft: Math.max(0, MAX_ATTEMPTS - entry.count), nowLocked: entry.count >= MAX_ATTEMPTS };
}

function clearFail(email: string) { emailAttemptMap.delete(email.toLowerCase()); }

/* ── Password validation ── */
function validatePw(pw: string): { error: string; errorCode: string } | null {
  if (!pw || pw.length < 8)    return { error: 'Password must be at least 8 characters.', errorCode: 'PASSWORD_TOO_SHORT' };
  if (!/[A-Z]/.test(pw))       return { error: 'Password must include at least one uppercase letter.', errorCode: 'PASSWORD_NO_UPPERCASE' };
  if (!/[0-9]/.test(pw))       return { error: 'Password must include at least one number.', errorCode: 'PASSWORD_NO_NUMBER' };
  return null;
}

/* ── POST /api/valet/login ── */
valetAuthRouter.post('/login', sanitizeBody, ipRateLimit, async (req: Request, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };

  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.', errorCode: 'MISSING_FIELDS', field: !email ? 'email' : 'password' });

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email))
    return res.status(400).json({ error: 'Please enter a valid email address.', errorCode: 'INVALID_EMAIL', field: 'email' });

  const lock = checkLockout(email);
  if (lock.locked) {
    const mins = Math.ceil(lock.remainingSec / 60);
    return res.status(429).json({
      error: `Account locked. Try again in ${mins > 1 ? `${mins} minutes` : `${lock.remainingSec} seconds`}.`,
      errorCode: 'ACCOUNT_LOCKED', lockedUntilSec: lock.remainingSec,
    });
  }

  try {
    // Use the anon-key client for signInWithPassword — auth sign-in should
    // always use the public client, not the service-role admin client.
    const { data, error } = await supabasePublic.auth.signInWithPassword({ email, password });

    if (error || !data?.user) {
      log.error({ errMsg: error?.message, status: error?.status }, `[Valet/login] Supabase auth failed for ${email}`);

      // Demo fallback — if Supabase password is stale, bypass via admin lookup
      const demoResult = await demoValetFallback(email, password);
      if (demoResult) {
        log.info(`[Valet/login] Demo fallback login succeeded for ${email}`);
        clearFail(email);
        const token = issueToken({ id: demoResult.userId, phone: (demoResult.profile?.phone as string) || email, role: demoResult.role });
        return res.json({
          success: true,
          session: { access_token: token, refresh_token: token },
          user: { id: demoResult.userId, email, firstName: (demoResult.profile?.first_name as string) || 'Demo', lastName: (demoResult.profile?.last_name as string) || 'Valet', role: demoResult.role },
        });
      }

      const { attemptsLeft, nowLocked } = recordFail(email);
      if (nowLocked) {
        const mins = Math.ceil(LOCKOUT_MS / 60000);
        return res.status(429).json({ error: `Too many failed attempts. Account locked for ${mins} minutes.`, errorCode: 'ACCOUNT_LOCKED', lockedUntilSec: Math.ceil(LOCKOUT_MS / 1000), attemptsLeft: 0 });
      }
      const extra = attemptsLeft <= 2 ? ` ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left.` : '';
      const isNotFound = error?.message?.toLowerCase().includes('invalid login') || error?.message?.toLowerCase().includes('not found');
      return res.status(401).json({ error: `Invalid email or password.${extra}`, errorCode: isNotFound ? 'EMAIL_NOT_FOUND' : 'WRONG_PASSWORD', attemptsLeft });
    }

    const userId = data.user.id;
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, phone, role, first_name, last_name')
      .eq('id', userId)
      .maybeSingle();
    const role = (profile?.role as string) || '';

    if (!['valet', 'frontdesk', 'concierge', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'This account is not registered as a Valet or Frontdesk partner.', errorCode: 'ACCESS_DENIED', field: 'email' });
    }

    clearFail(email);
    const token = issueToken({ id: userId, phone: (profile?.phone as string) || email, role });
    return res.json({ success: true, session: { access_token: token, refresh_token: token }, user: { id: userId, email: data.user.email, firstName: profile?.first_name || '', lastName: profile?.last_name || '', role } });
  } catch (err) {
    log.error(`[Valet] Login error: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Authentication failed. Please try again.', errorCode: 'SERVER_ERROR' });
  }
});

/* ── POST /api/valet/register ── */
valetAuthRouter.post('/register', sanitizeBody, ipRateLimit, async (req: Request, res: Response) => {
  const { email, password, firstName, lastName, businessName, phone, city, businessLocation, role: reqRole } = req.body as {
    email: string; password: string; firstName?: string; lastName?: string;
    businessName?: string; phone?: string; city?: string; businessLocation?: string; role?: string;
  };

  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.', errorCode: 'MISSING_FIELDS' });

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email))
    return res.status(400).json({ error: 'Please enter a valid email address.', errorCode: 'INVALID_EMAIL', field: 'email' });

  const pwError = validatePw(password);
  if (pwError) return res.status(400).json({ ...pwError, field: 'password' });

  const allowedRoles = ['valet', 'frontdesk', 'concierge'];
  const assignedRole = allowedRoles.includes(reqRole || '') ? reqRole! : 'valet';

  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true,
    });

    if (authError) {
      if (authError.message?.includes('already registered') || authError.message?.includes('already exists')) {
        return res.status(409).json({ error: 'An account with this email already exists.', errorCode: 'EMAIL_IN_USE', field: 'email' });
      }
      throw authError;
    }

    const userId = authData.user.id;
    const now = new Date().toISOString();
    // FIX: `city`/`business_location` are not real columns on public.profiles
    // (the live schema uses `operating_city`); writing them silently failed
    // the whole upsert and left the role at the trigger's default 'passenger',
    // which then made login fail with "not registered as a Valet" even though
    // registration reported success. Also now checks the upsert error.
    const { error: upsertErr } = await supabaseAdmin.from('profiles').upsert({
      id: userId,
      email,
      phone: phone || null,
      first_name: firstName || null,
      last_name: lastName || null,
      business_name: businessName || null,
      operating_city: city || businessLocation || null,
      role: assignedRole,
      status_val: 'active',
      avatar_url: '/default-avatar.svg',
      created_at: now,
      updated_at: now,
    }, { onConflict: 'id', ignoreDuplicates: false });

    if (upsertErr) {
      log.error(`[Valet] Register profile upsert failed for ${email}: ${upsertErr.message}`);
      return res.status(500).json({ error: 'Registration failed. Please try again.', errorCode: 'SERVER_ERROR' });
    }

    const token = issueToken({ id: userId, phone: phone || email, role: assignedRole });
    return res.status(201).json({
      success: true,
      session: { access_token: token, refresh_token: token },
      user: { id: userId, email, firstName: firstName || '', lastName: lastName || '', role: assignedRole },
    });
  } catch (err) {
    log.error(`[Valet] Register error: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Registration failed. Please try again.', errorCode: 'SERVER_ERROR' });
  }
});

/* ── POST /api/valet/oauth-login ── */
valetAuthRouter.post('/oauth-login', sanitizeBody, ipRateLimit, async (req: Request, res: Response) => {
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
      .select('id, phone, role, first_name, last_name')
      .eq('id', userId)
      .maybeSingle();

    if (!profile2) {
      return res.json({ needsRegistration: true, email, userId });
    }

    const role = (profile2.role as string) || '';
    if (!['valet', 'frontdesk', 'concierge', 'admin'].includes(role)) {
      const isPassenger = role === 'passenger';
      return res.status(403).json({
        error: isPassenger 
          ? 'This Google account is already registered as a passenger. Please use a different Google account or register with email/password for valet access.'
          : 'This Google account is not linked to a Valet partner account.',
        errorCode: 'ACCESS_DENIED',
        detail: isPassenger ? 'PASSENGER_ACCOUNT_CONFLICT' : 'ROLE_MISMATCH',
      });
    }

    const token = issueToken({ id: userId, phone: (profile2.phone as string) || email || userId, role });

    return res.json({
      success: true,
      session: { access_token: token, refresh_token: token },
      user: { id: userId, email, firstName: profile2.first_name || '', lastName: profile2.last_name || '', role },
    });
  } catch (err) {
    log.error(`[Valet] OAuth login error: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Authentication failed. Please try again.', errorCode: 'SERVER_ERROR' });
  }
});

/* ── POST /api/valet/complete-profile ──────────────────────────────────────
   Called when a Google OAuth user needs to create a valet/frontdesk/concierge
   profile. The caller already has a valid Supabase access token from the
   OAuth flow. We verify the token, create the profile, and return a custom
   session — mirrors /api/chauffeur/complete-profile. ────────────────────── */
valetAuthRouter.post('/complete-profile', sanitizeBody, ipRateLimit, async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  const supabaseToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!supabaseToken) {
    return res.status(401).json({ error: 'Access token required.', errorCode: 'MISSING_TOKEN' });
  }

  const { firstName, lastName, phone, businessName, city, businessLocation, role: reqRole } = req.body as {
    firstName?: string; lastName?: string; phone?: string;
    businessName?: string; city?: string; businessLocation?: string; role?: string;
  };

  const allowedRoles = ['valet', 'frontdesk', 'concierge'];
  const assignedRole = allowedRoles.includes(reqRole || '') ? reqRole! : 'valet';

  try {
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(supabaseToken);
    if (userError || !userData?.user) {
      return res.status(401).json({ error: 'Invalid or expired session.', errorCode: 'INVALID_TOKEN' });
    }

    const { id: userId, email } = userData.user;
    const now = new Date().toISOString();

    // Guard: refuse if user already has a passenger profile (prevent account hijacking)
    const { data: existing } = await supabaseAdmin
      .from('profiles')
      .select('id, role')
      .eq('id', userId)
      .maybeSingle();

    if (existing && existing.role === 'passenger') {
      return res.status(403).json({
        error: 'This Google account is already registered as a passenger. Use a different account to register as a Valet partner.',
        errorCode: 'ACCESS_DENIED',
      });
    }

    // FIX: use the real `operating_city` column — `city`/`business_location`
    // do not exist on public.profiles and previously caused the whole upsert
    // to fail silently, leaving the row at the auto-created default role.
    const { error: upsertErr } = await supabaseAdmin.from('profiles').upsert({
      id: userId,
      email: email || '',
      phone: phone || null,
      first_name: firstName || null,
      last_name: lastName || null,
      business_name: businessName || null,
      operating_city: city || businessLocation || null,
      role: assignedRole,
      status_val: 'active',
      avatar_url: '/default-avatar.svg',
      ...(existing ? {} : { created_at: now }),
      updated_at: now,
    }, { onConflict: 'id', ignoreDuplicates: false });

    if (upsertErr) {
      log.error(`[Valet] complete-profile upsert failed for ${email}: ${upsertErr.message}`);
      return res.status(500).json({ error: 'Profile creation failed. Please try again.', errorCode: 'SERVER_ERROR' });
    }

    const token = issueToken({ id: userId, phone: phone || email || userId, role: assignedRole });

    log.info(`[Valet] complete-profile succeeded for ${email} (userId: ${userId})`);
    return res.status(200).json({
      success: true,
      session: { access_token: token, refresh_token: token },
      user: { id: userId, email: email || '', firstName: firstName || '', lastName: lastName || '', role: assignedRole },
    });
  } catch (err) {
    log.error(`[Valet] complete-profile error: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Profile creation failed. Please try again.', errorCode: 'SERVER_ERROR' });
  }
});
