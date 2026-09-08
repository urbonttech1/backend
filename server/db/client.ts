import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { pool } from './pool';
import { logger } from '../lib/logger';

// The anon key below is the project's public key — already baked into the Dockerfile
// and the frontend bundle, so embedding it here is not a secret exposure.
const KNOWN_SUPABASE_URL  = 'https://rvlafaebvlrtrfdtcbut.supabase.co';
const KNOWN_ANON_KEY      = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ2bGFmYWVidmxydHJmZHRjYnV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2NTkxNTEsImV4cCI6MjA4ODIzNTE1MX0.-0qOUQdeGkz775xUujQm1wyrKIULjbQL2pLLXm98QmE';

const supabaseUrl        = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || KNOWN_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAnonKey    = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || KNOWN_ANON_KEY;

// Export for modules that need a guaranteed-correct direct client (e.g. demo fallbacks)
export { KNOWN_SUPABASE_URL, KNOWN_ANON_KEY };
export const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-in-production';

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  logger.error('[SECURITY] CRITICAL: JWT_SECRET is not set in production. All tokens are signed with the insecure default key. Set JWT_SECRET immediately.');
}

// Supabase is the ONLY database. Required in every environment (dev + prod).
// No silent SQLite fallback: if credentials are missing the server refuses to boot.
if (!supabaseUrl || !supabaseServiceKey) {
  const missing = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!supabaseServiceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  logger.error({ error: 'Missing env vars: ' + missing.join(', ') }, 'startup');
  // logger.fatal box:══════════════════════════════════════════════════════════════════╗');
    logger.error('║                 URBONT — STARTUP FATAL ERROR                     ║');
    logger.error('╠══════════════════════════════════════════════════════════════════╣');
    logger.error('║  Missing required env var(s): ' + missing.join(', '));
    logger.error('║                                                                  ║');
    logger.error('║  Where to get them → Supabase → Settings → API:                 ║');
    logger.error('║    SUPABASE_URL              = Project URL                       ║');
    logger.error('║    SUPABASE_SERVICE_ROLE_KEY = service_role secret key           ║');
    logger.error('║                                                                  ║');
    logger.error('║  Where to set them → Hyperlift → your app → Environment Vars    ║');
    logger.error('╚══════════════════════════════════════════════════════════════════╝');
  logger.error({ error: 'Missing env vars: ' + missing.join(', ') }, 'startup');
  throw new Error('[FATAL] Missing: ' + missing.join(', ') + '. Set them in Hyperlift env vars. Get from: Supabase → Settings → API.');
}

const safeUrl = supabaseUrl || 'https://placeholder.supabase.co';
const safeServiceKey = supabaseServiceKey || 'placeholder-key';
const safeAnonKey = supabaseAnonKey || 'placeholder-key';

// Real Supabase clients — mandatory. Supabase is the ONLY data store.
// No SQLite, no in-memory mocks, no local fallback.
export const supabaseAdmin = createClient(safeUrl, safeServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export const supabasePublic = createClient(safeUrl, safeAnonKey || safeServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export interface UrbontSession {
  user_id: string;
  phone: string;
  role: string;
}

// ─── Get or create user by phone ──────────────────────────────────────────────
// FIX: checks insert errors, retries lookup on conflict, never throws
export async function getOrCreateSupabaseUser(phone: string): Promise<{ id: string; phone: string; role: string }> {
  // 1. Try to find existing profile by phone — check both "+E.164" and bare-digits variants
  const phoneVariants = Array.from(new Set([phone, phone.replace(/^\+/, ''), `+${phone.replace(/^\+/, '')}`]));
  let existing: { id: string; phone: string; role: string } | null = null;
  for (const variant of phoneVariants) {
    const { data, error: selectErr } = await supabaseAdmin
      .from('profiles')
      .select('id, phone, role')
      .eq('phone', variant)
      .maybeSingle();
    if (selectErr) {
      logger.error(`[DB] getOrCreateSupabaseUser select error for ${variant}: ${selectErr.message}`);
    }
    if (data) { existing = data as { id: string; phone: string; role: string }; break; }
  }

  if (existing) {
    return { id: existing.id as string, phone: existing.phone as string, role: (existing.role as string) || 'passenger' };
  }

  // 2. Ensure auth user exists — try createUser first; if phone is already registered in
  //    Supabase Auth, createUser returns a 422 error. In that case we MUST find the existing
  //    auth user so the JWT sub matches the profile.id FK.
  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    phone,
    phone_confirm: true,
  });

  let userId: string | null = null;

  if (authData?.user?.id) {
    userId = authData.user.id;
    logger.info(`[DB] Auth user created/found for ${phone}: ${userId}`);
  } else {
    // createUser failed — phone is likely already registered in auth.users.
    // The SDK's listUsers doesn't return the `phone` field reliably, so we hit
    // the GoTrue admin REST endpoint directly with a phone query param.
    logger.warn(`[DB] createUser failed for ${phone} (${authErr?.message}), querying GoTrue admin for existing auth user…`);

    try {
      // Strategy 1: query by phone directly (GoTrue >=2.x supports this param)
      const byPhoneUrl = `${safeUrl}/auth/v1/admin/users?page=1&per_page=100&phone=${encodeURIComponent(phone)}`;
      const byPhoneResp = await fetch(byPhoneUrl, {
        headers: { Authorization: `Bearer ${safeServiceKey}`, apikey: safeServiceKey },
      });
      const byPhoneBody = await byPhoneResp.json() as { users?: Array<{ id: string; phone?: string }> };
      const phoneMatch = byPhoneBody.users?.find(u => u.phone === phone || u.phone === phone.replace(/^\+/, ''));
      if (phoneMatch?.id) {
        userId = phoneMatch.id;
        logger.info(`[DB] Found existing auth user via phone query for ${phone}: ${userId}`);
      }
    } catch (e) {
      logger.warn(`[DB] Phone query failed: ${(e as Error).message}`);
    }

    // Strategy 2: paginate all users and check phone field + app_metadata.phone
    if (!userId) {
      let page = 1;
      const PAGE_SIZE = 1000;
      outer:
      while (true) {
        const { data: listData } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
        const users = listData?.users ?? [];
        for (const u of users) {
          const uPhone: string = (u.phone as string) || (u.app_metadata?.phone as string) || '';
          const norm = (s: string) => s.replace(/\s/g, '').replace(/^\+/, '');
          if (uPhone && norm(uPhone) === norm(phone)) {
            userId = u.id;
            logger.info(`[DB] Found existing auth user via listUsers for ${phone}: ${userId}`);
            break outer;
          }
        }
        if (users.length < PAGE_SIZE) break;
        page++;
      }
    }

    if (!userId) {
        // Phone auth is not enabled in Supabase — fallback: create user with a
        // phone-derived email so we get a real auth.users row with a proper UUID.
        const phoneEmail = `${phone.replace(/[^0-9]/g, '')}@urbont.phone`;
        logger.warn(`[DB] Phone auth unavailable for ${phone} — creating via email fallback: ${phoneEmail}`);
        const { data: fallbackAuth, error: fallbackErr } = await supabaseAdmin.auth.admin.createUser({
          email: phoneEmail,
          email_confirm: true,
          user_metadata: { phone },
        });
        if (fallbackAuth?.user?.id) {
          userId = fallbackAuth.user.id;
          logger.info(`[DB] Auth user created via email fallback for ${phone}: ${userId}`);
        } else {
          // Look up by the fallback email — paginate to avoid missing user in large instances
          let foundInPages = false;
          let lookupPage = 1;
          const LOOKUP_PAGE_SIZE = 1000;
          while (!foundInPages) {
            const { data: emailLookup } = await supabaseAdmin.auth.admin.listUsers({ page: lookupPage, perPage: LOOKUP_PAGE_SIZE });
            const users = emailLookup?.users ?? [];
            const match = users.find(u => u.email === phoneEmail);
            if (match?.id) {
              userId = match.id;
              logger.info(`[DB] Found existing fallback-email user for ${phone}: ${userId}`);
              foundInPages = true;
              break;
            }
            if (users.length < LOOKUP_PAGE_SIZE) break;
            lookupPage++;
          }
          if (!userId) {
            // Last resort: use a random UUID so the session can still be issued.
            // Profile creation may fail silently but the user can log in.
            // This mirrors the same fallback in getOrCreateSupabaseUserByEmail.
            logger.error(`[DB] All strategies failed for ${phone} (phone: ${authErr?.message ?? 'unknown'}, email: ${fallbackErr?.message ?? 'unknown'}) — using random UUID as last resort`);
            userId = randomUUID();
          }
        }
      }
  }

  // 3. Upsert profile — try supabaseAdmin first (works in both local dev and production),
  //    fall back to raw pool (useful when DATABASE_URL points directly to Supabase in prod).
  const now = new Date().toISOString();
  const { error: supaUpsertErr } = await supabaseAdmin.from('profiles').upsert(
    { id: userId, phone, role: 'passenger', created_at: now, updated_at: now },
    { onConflict: 'id', ignoreDuplicates: false },
  );
  if (!supaUpsertErr) {
    logger.info(`[DB] Profile upserted for ${phone} (id: ${userId})`);
  } else {
    logger.error({ errMsg: supaUpsertErr.message, code: supaUpsertErr.code }, `[DB] supabaseAdmin profile upsert failed for ${phone}`);
    // Fallback: raw pool (when DATABASE_URL == Supabase connection string in prod)
    try {
      await pool.query(
        `INSERT INTO profiles (id, phone, role, created_at, updated_at)
         VALUES ($1, $2, 'passenger', $3, $3)
         ON CONFLICT (id) DO UPDATE SET
           phone      = EXCLUDED.phone,
           updated_at = EXCLUDED.updated_at`,
        [userId, phone, now],
      );
      logger.info(`[DB] Profile upserted via pool for ${phone} (id: ${userId})`);
    } catch (poolErr: unknown) {
      const poolErrMessage = poolErr instanceof Error ? poolErr.message : String(poolErr);
      logger.error(`[DB] Pool profile upsert also failed for ${phone}: ${poolErrMessage}`);
      // Do NOT throw — we still have a valid userId. The profile will be created
      // when onboardUser runs after login. Throwing here blocks ALL logins.
      logger.warn(`[DB] Proceeding with session for ${phone} despite profile upsert failure.`);
    }
  }

  return { id: userId, phone, role: 'passenger' };
}

export function issueToken(user: { id: string; phone: string; role: string }): string {
  return jwt.sign(
    { sub: user.id, phone: user.phone, role: user.role },
    jwtSecret,
    { expiresIn: '30d' }
  );
}

export function verifyToken(token: string): UrbontSession | null {
  try {
    const decoded = jwt.verify(token, jwtSecret) as jwt.JwtPayload;
    return {
      user_id: decoded.sub as string,
      phone: decoded.phone as string,
      role: (decoded.role as string) || 'passenger',
    };
  } catch {
    return null;
  }
}

export function verifyTokenIgnoreExpiry(token: string): UrbontSession | null {
  try {
    const decoded = jwt.verify(token, jwtSecret, { ignoreExpiration: true }) as jwt.JwtPayload;
    return {
      user_id: decoded.sub as string,
      phone: decoded.phone as string,
      role: (decoded.role as string) || 'passenger',
    };
  } catch {
    return null;
  }
}

export async function verifySupabaseToken(token: string): Promise<{ id: string; email?: string; phone?: string; role?: string } | null> {
  // 1. Try our custom JWT first (phone/OTP login)
  const session = verifyToken(token);
  if (session) return { id: session.user_id, phone: session.phone, role: session.role };

  // 2. Fallback: try Supabase's own auth (Google OAuth / Supabase session tokens)
  try {
    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      if (!error && data?.user) {
        const userId = data.user.id;
        // Role from user_metadata/app_metadata (set during registration flows)
        let role = (data.user.user_metadata?.role as string) || (data.user.app_metadata?.role as string) || '';
        // If not set, look up the profiles table (valet/chauffeur email+password login path)
        if (!role || role === 'passenger') {
          try {
            const { data: profile } = await supabaseAdmin
              .from('profiles')
              .select('role')
              .eq('id', userId)
              .maybeSingle();
            if (profile?.role) role = profile.role as string;
          } catch { /* ignore — fall back to 'passenger' */ }
        }
        return {
          id: userId,
          // El correo se descartaba aquí, y el alta por Google terminaba creando
          // perfiles con email vacío aunque Google lo hubiera verificado.
          email: data.user.email || '',
          phone: data.user.phone || '',
          role: role || 'passenger',
        };
      }
    }
  } catch { /* ignore */ }

  return null;
}

// ─── Create session token ──────────────────────────────────────────────────────
// FIX: no longer throws when profile is not yet in DB — issues JWT from available data
export async function createSupabaseSession(userId: string, fallbackPhone?: string, fallbackRole?: string): Promise<{ access_token: string; refresh_token: string }> {
  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('id, phone, role')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logger.error(`[DB] createSupabaseSession select error for ${userId}: ${error.message}`);
  }

  // FIX: if profile is missing, still issue a valid token using fallback data
  const token = issueToken({
    id: userId,
    phone: (profile?.phone as string) || fallbackPhone || '',
    role: (profile?.role as string) || fallbackRole || 'passenger',
  });

  if (!profile) {
    logger.warn(`[DB] Profile not found for ${userId} — issuing token with fallback data`);
  }

  return { access_token: token, refresh_token: token };
}

// ─── Get or create user by email ──────────────────────────────────────────────
export async function getOrCreateSupabaseUserByEmail(email: string): Promise<{ id: string; email: string; role: string }> {
  const lowerEmail = email.toLowerCase();

  const { data: existing, error: selectErr } = await supabaseAdmin
    .from('profiles')
    .select('id, email, role')
    .eq('email', lowerEmail)
    .maybeSingle();

  if (selectErr) {
    logger.error(`[DB] getOrCreateSupabaseUserByEmail select error for ${email}: ${selectErr.message}`);
  }

  if (existing) {
    return { id: existing.id as string, email: existing.email as string, role: (existing.role as string) || 'passenger' };
  }

  // Create auth user first so profiles.id FK constraint is satisfied.
  // If email is already registered, createUser fails — find the existing user by listing.
  const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email: lowerEmail,
    email_confirm: true,
  });

  let userId: string | null = null;
  if (authData?.user?.id) {
    userId = authData.user.id;
    logger.info(`[DB] Auth user created/found for ${lowerEmail}: ${userId}`);
  } else {
    logger.warn(`[DB] createUser failed for ${lowerEmail} (${authErr?.message}), querying GoTrue admin…`);
    try {
      const byEmailUrl = `${safeUrl}/auth/v1/admin/users?page=1&per_page=100&email=${encodeURIComponent(lowerEmail)}`;
      const byEmailResp = await fetch(byEmailUrl, {
        headers: { Authorization: `Bearer ${safeServiceKey}`, apikey: safeServiceKey },
      });
      const byEmailBody = await byEmailResp.json() as { users?: Array<{ id: string; email?: string }> };
      const emailMatch = byEmailBody.users?.find(u => u.email?.toLowerCase() === lowerEmail);
      if (emailMatch?.id) {
        userId = emailMatch.id;
        logger.info(`[DB] Found existing auth user via email query for ${lowerEmail}: ${userId}`);
      }
    } catch (e) {
      logger.warn(`[DB] Email query failed: ${(e as Error).message}`);
    }

    if (!userId) {
      let page = 1;
      const PAGE_SIZE = 1000;
      outer:
      while (true) {
        const { data: listData } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
        const users = listData?.users ?? [];
        for (const u of users) {
          if (u.email?.toLowerCase() === lowerEmail) {
            userId = u.id;
            logger.info(`[DB] Found existing auth user via listUsers for ${lowerEmail}: ${userId}`);
            break outer;
          }
        }
        if (users.length < PAGE_SIZE) break;
        page++;
      }
    }

    if (!userId) {
      logger.error(`[DB] Could not find auth user for ${lowerEmail} — using random UUID`);
      userId = randomUUID();
    }
  }

  const now = new Date().toISOString();
  try {
    await pool.query(
      `INSERT INTO profiles (id, email, role, created_at, updated_at)
       VALUES ($1, $2, 'passenger', $3, $3)
       ON CONFLICT (id) DO UPDATE SET
         email      = EXCLUDED.email,
         updated_at = EXCLUDED.updated_at`,
      [userId, lowerEmail, now],
    );
    logger.info(`[DB] Profile upserted for ${lowerEmail} (id: ${userId})`);
  } catch (poolErr: unknown) {
    const poolErrMessage = poolErr instanceof Error ? poolErr.message : String(poolErr);
    logger.error(`[DB] Pool profile upsert (email) failed for ${lowerEmail}: ${poolErrMessage}`);
    const { error: upsertErr } = await supabaseAdmin.from('profiles').upsert(
      { id: userId, email: lowerEmail, role: 'passenger', created_at: now, updated_at: now },
      { onConflict: 'id', ignoreDuplicates: false },
    );
    if (upsertErr) {
      logger.error({ errMsg: upsertErr.message, code: upsertErr.code }, `[DB] supabaseAdmin profile upsert (email) also failed for ${lowerEmail}`);
      logger.error(`[DB] Issuing token without confirmed profile for ${lowerEmail} (id: ${userId})`);
    }
  }

  return { id: userId, email: lowerEmail, role: 'passenger' };
}
