import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin, supabasePublic, KNOWN_SUPABASE_URL, KNOWN_ANON_KEY } from '../../db/client';
import { startSession } from '../../services/singleSession';
import { pool } from '../../db/pool';
import { requireSupabaseAuth, sanitizeBody } from '../../middleware';
import { createContextLogger } from '../../lib/logger';
import { esEmailDuplicado } from '../../lib/authErrors';
import { catalogoCompleto } from '../../services/docCatalogStore';
import { normalizarEstadoDoc } from '../../services/docCatalog';
import { accesoValet } from '../../services/valetAccess';
import { perfilEnBlanco } from '../../services/blankProfile';
import { ACUERDO_HASH, ACUERDO_TEXTO, ACUERDO_VERSION, aceptacionValida, copiaFirmada } from '../../services/valetAgreement';
import { columnasCompania, companiaCompleta, faltantesCompania, type CompaniaValet } from '../../services/valetCompany';
import { documentacionDe } from '../../services/valetDocumentation';
import { enviarCopiaAcuerdoValet } from '../../services/accountEmails';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
const log = createContextLogger('VALET');

export const valetAuthRouter = Router();

/**
 * El alta desde la app crea el perfil en `pending`; esta fila es lo que el panel
 * lista en Valets para aprobarlo. Si falla no se tumba el registro: el perfil
 * pendiente ya basta para que el panel lo muestre.
 */
/**
 * Documentos que el valet pendiente tiene que (re)subir: los que faltan o que el
 * panel rechazó o pidió de nuevo. Sin esto, un valet en revisión no tendría cómo
 * corregir un documento: el login lo rechaza y la app no tiene otra pantalla.
 */
async function documentosPorSubir(userId: string) {
  const catalogo = (await catalogoCompleto('valet')).filter(d => d.active);
  const { data } = await supabaseAdmin.from('driver_documents')
    .select('doc_key, status, rejection_reason').eq('driver_id', userId);
  const filas = new Map(((data ?? []) as Array<Record<string, any>>).map(d => [String(d.doc_key), d]));
  return catalogo
    .filter(d => {
      const f = filas.get(d.key);
      return !f || normalizarEstadoDoc(f.status) === 'rechazado' || (f.status === 'pending' && !!f.rejection_reason);
    })
    .map(d => ({ key: d.key, label: d.label, hint: d.hint, reason: filas.get(d.key)?.rejection_reason ?? null }));
}

function companiaDelBody(body: Record<string, unknown>): CompaniaValet {
  return {
    legalName: typeof body.legalName === 'string' ? body.legalName : null,
    tradeName: typeof body.tradeName === 'string' ? body.tradeName : (typeof body.businessName === 'string' ? body.businessName : null),
    entityType: typeof body.entityType === 'string' ? body.entityType : null,
    address: typeof body.companyAddress === 'string' ? body.companyAddress : (typeof body.businessLocation === 'string' ? body.businessLocation : null),
    phone: typeof body.companyPhone === 'string' ? body.companyPhone : null,
    email: typeof body.companyEmail === 'string' ? body.companyEmail : null,
    authorizedRep: typeof body.authorizedRep === 'string' ? body.authorizedRep : null,
  };
}

function columnasSolicitud(c: CompaniaValet): Record<string, string | null> {
  const cols = columnasCompania(c);
  return {
    legal_name: cols.company_legal_name,
    trade_name: cols.business_name,
    entity_type: cols.company_entity_type,
    company_address: cols.company_address,
    company_phone: cols.company_phone,
    company_email: cols.company_email,
    authorized_rep: cols.company_rep_name,
  };
}

async function registrarSolicitudValet(d: {
  email: string; firstName?: string; lastName?: string; phone?: string; city?: string; company?: CompaniaValet;
}) {
  if (!d.email) return;
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from('valet_applications').upsert({
    email: d.email, first_name: d.firstName || null, last_name: d.lastName || null,
    phone: d.phone || null, city: d.city || null, status: 'pending', created_at: now, updated_at: now,
    // Si ya hay una solicitud (p. ej. la de la web, ya aprobada) no se pisa: un registro
    // nunca debe devolver a «pendiente» lo que el panel ya decidió.
  }, { onConflict: 'email', ignoreDuplicates: true });
  if (error) log.warn(`[Valet] no se pudo guardar la solicitud de ${d.email}: ${error.message}`);
  if (!d.company || !companiaCompleta(d.company)) return;
  const { error: compErr } = await supabaseAdmin.from('valet_applications')
    .update({ ...columnasSolicitud(d.company), updated_at: now })
    .ilike('email', d.email);
  if (compErr) log.warn(`[Valet] no se pudo guardar la compañía de ${d.email}: ${compErr.message}`);
}

/** Cuenta en revisión: el token solo sirve para terminar la documentación, no para entrar. */
async function respuestaPendiente(userId: string, phone: string, email: string, role: string) {
  const porSubir = await documentosPorSubir(userId);
  const documentation = await documentacionDe(userId).catch(() => null);
  const incompleto = !documentation || documentation.accountDocumentation === 'pending_documentation' || porSubir.length > 0;
  return {
    error: "Your account is under review. We'll email you as soon as it's approved.",
    errorCode: 'ACCOUNT_PENDING' as const,
    ...(documentation ? { documentation } : {}),
    ...(incompleto ? {
      documentsRequested: porSubir,
      uploadToken: await startSession({ id: userId, phone: phone || email, role }),
    } : {}),
  };
}

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
        const token = await startSession({ id: demoResult.userId, phone: (demoResult.profile?.phone as string) || email, role: demoResult.role });
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
      .select('id, phone, role, first_name, last_name, account_status')
      .eq('id', userId)
      .maybeSingle();
    const role = (profile?.role as string) || '';

    // Cruza el estado del perfil con el de la solicitud: ver services/valetAccess.ts.
    const acceso = await accesoValet(profile?.account_status as string | null, data.user.email);
    if (acceso === 'suspended' || acceso === 'rejected') {
      return res.status(403).json({
        error: acceso === 'rejected' ? "Your application wasn't approved. Contact Urbont support." : 'This account is suspended. Contact Urbont support.',
        errorCode: 'ACCOUNT_SUSPENDED',
      });
    }
    if (acceso === 'pending') {
      return res.status(403).json(await respuestaPendiente(userId, (profile?.phone as string) || '', email, role));
    }

    if (!['valet', 'frontdesk', 'concierge', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'This account is not registered as a Valet or Frontdesk partner.', errorCode: 'ACCESS_DENIED', field: 'email' });
    }

    clearFail(email);
    const token = await startSession({ id: userId, phone: (profile?.phone as string) || email, role });
    return res.json({ success: true, session: { access_token: token, refresh_token: token }, user: { id: userId, email: data.user.email, firstName: profile?.first_name || '', lastName: profile?.last_name || '', role } });
  } catch (err) {
    log.error(`[Valet] Login error: ${errMsg(err)}`);
    return res.status(500).json({
      error: 'Something went wrong on our side while signing you in. Your account is fine — please try again.',
      errorCode: 'LOGIN_FAILED',
      action: 'retry',
    });
  }
});

/* ── POST /api/valet/register ── */
valetAuthRouter.post('/register', sanitizeBody, ipRateLimit, async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const email = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const firstName = typeof body.firstName === 'string' ? body.firstName : '';
  const lastName = typeof body.lastName === 'string' ? body.lastName : '';
  const phone = typeof body.phone === 'string' ? body.phone : '';
  const city = typeof body.city === 'string' ? body.city : '';
  const businessLocation = typeof body.businessLocation === 'string' ? body.businessLocation : '';
  const reqRole = typeof body.role === 'string' ? body.role : '';
  const company = companiaDelBody(body);

  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.', errorCode: 'MISSING_FIELDS' });

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email))
    return res.status(400).json({ error: 'Please enter a valid email address.', errorCode: 'INVALID_EMAIL', field: 'email' });

  const pwError = validatePw(password);
  if (pwError) return res.status(400).json({ ...pwError, field: 'password' });

  const allowedRoles = ['valet', 'frontdesk', 'concierge'];
  const assignedRole = allowedRoles.includes(reqRole || '') ? reqRole! : 'valet';

  const faltaCompania = faltantesCompania(company);
  if (faltaCompania.length > 0) {
    return res.status(400).json({
      error: 'Company information is required before the account can be activated.',
      errorCode: 'COMPANY_INCOMPLETE',
      fields: faltaCompania,
    });
  }

  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true,
    });

    if (authError) {
      // Mismo arreglo que en el alta de conductor: el duplicado se decide por
      // `code`/`status`. Comparar contra 'already registered' no casaba con el
      // mensaje real de Supabase —«already been registered»— y este 409 nunca
      // se alcanzaba: salía un 500 genérico.
      if (esEmailDuplicado(authError)) {
        return res.status(409).json({
          error: 'An account with this email already exists. Sign in instead.',
          errorCode: 'EMAIL_IN_USE',
          field: 'email',
          action: 'login',
        });
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
      ...columnasCompania(company),
      operating_city: city || businessLocation || null,
      role: assignedRole,
      status_val: 'active',
      // Entra en revisión: no puede iniciar sesión ni despachar hasta que el panel lo apruebe.
      account_status: 'pending',
      avatar_url: '/default-avatar.svg',
      created_at: now,
      updated_at: now,
    }, { onConflict: 'id', ignoreDuplicates: false });

    if (upsertErr) {
      log.error(`[Valet] Register profile upsert failed for ${email}: ${upsertErr.message}`);
      // La cuenta quedó creada; sólo falló el perfil. Reintentar el alta daría
      // «email en uso», así que se le dirige a iniciar sesión.
      return res.status(500).json({
        error: 'Your account was created, but we could not save your profile. Sign in with this email to finish setting it up.',
        errorCode: 'PROFILE_SAVE_FAILED',
        action: 'login',
        accountCreated: true,
      });
    }

    await registrarSolicitudValet({ email, firstName, lastName, phone, city: city || businessLocation, company });

    const token = await startSession({ id: userId, phone: phone || email, role: assignedRole });
    return res.status(201).json({
      success: true,
      pending: true,
      session: { access_token: token, refresh_token: token },
      user: { id: userId, email, firstName: firstName || '', lastName: lastName || '', role: assignedRole },
    });
  } catch (err) {
    const e = err as { message?: string; code?: string; status?: number };
    if (esEmailDuplicado(e)) {
      return res.status(409).json({
        error: 'An account with this email already exists. Sign in instead.',
        errorCode: 'EMAIL_IN_USE',
        field: 'email',
        action: 'login',
      });
    }
    log.error(`[Valet] Register error (unclassified): ${errMsg(err)} · code=${e.code ?? '-'} status=${e.status ?? '-'}`);
    return res.status(500).json({
      error: 'Something went wrong on our side while creating your account. Please try again, or contact support@urbont.com if it keeps failing.',
      errorCode: 'REGISTRATION_FAILED',
      action: 'contact_support',
    });
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
      .select('id, phone, role, first_name, last_name, account_status')
      .eq('id', userId)
      .maybeSingle();

    if (!profile2 || await perfilEnBlanco(profile2)) {
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

    const accesoG = await accesoValet(profile2.account_status as string | null, email);
    if (accesoG === 'suspended' || accesoG === 'rejected') {
      return res.status(403).json({
        error: accesoG === 'rejected' ? "Your application wasn't approved. Contact Urbont support." : 'This account is suspended. Contact Urbont support.',
        errorCode: 'ACCOUNT_SUSPENDED',
      });
    }
    if (accesoG === 'pending') {
      return res.status(403).json(await respuestaPendiente(
        userId, (profile2.phone as string) || '', email || '', role,
      ));
    }

    const token = await startSession({ id: userId, phone: (profile2.phone as string) || email || userId, role });

    return res.json({
      success: true,
      session: { access_token: token, refresh_token: token },
      user: { id: userId, email, firstName: profile2.first_name || '', lastName: profile2.last_name || '', role },
    });
  } catch (err) {
    log.error(`[Valet] OAuth login error: ${errMsg(err)}`);
    return res.status(500).json({
      error: 'Something went wrong while signing you in with Google. Please try again, or use your email and password instead.',
      errorCode: 'OAUTH_LOGIN_FAILED',
      action: 'retry',
    });
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

  const body = req.body as Record<string, unknown>;
  const firstName = typeof body.firstName === 'string' ? body.firstName : '';
  const lastName = typeof body.lastName === 'string' ? body.lastName : '';
  const phone = typeof body.phone === 'string' ? body.phone : '';
  const city = typeof body.city === 'string' ? body.city : '';
  const businessLocation = typeof body.businessLocation === 'string' ? body.businessLocation : '';
  const reqRole = typeof body.role === 'string' ? body.role : '';
  const company = companiaDelBody(body);

  const allowedRoles = ['valet', 'frontdesk', 'concierge'];
  const assignedRole = allowedRoles.includes(reqRole || '') ? reqRole! : 'valet';

  const faltaCompaniaPerfil = faltantesCompania(company);
  if (faltaCompaniaPerfil.length > 0) {
    return res.status(400).json({
      error: 'Company information is required before the account can be activated.',
      errorCode: 'COMPANY_INCOMPLETE',
      fields: faltaCompaniaPerfil,
    });
  }

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
      .select('id, role, account_status, first_name, last_name, phone')
      .eq('id', userId)
      .maybeSingle();

    // El perfil vacío que crea el trigger al entrar con Google cuenta como alta nueva.
    const nuevo = !existing || await perfilEnBlanco(existing);

    if (existing && !nuevo && existing.role === 'passenger') {
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
      ...columnasCompania(company),
      operating_city: city || businessLocation || null,
      role: assignedRole,
      status_val: 'active',
      avatar_url: '/default-avatar.svg',
      // Solo el alta nueva entra en revisión; completar el perfil de un valet ya
      // aprobado no debe devolverlo a pendiente.
      ...(nuevo ? { created_at: now, account_status: 'pending' } : {}),
      updated_at: now,
    }, { onConflict: 'id', ignoreDuplicates: false });

    if (upsertErr) {
      log.error(`[Valet] complete-profile upsert failed for ${email}: ${upsertErr.message}`);
      return res.status(500).json({
        error: 'We could not save your profile. Your sign-in is fine — please try again, and contact support@urbont.com if it keeps failing.',
        errorCode: 'PROFILE_SAVE_FAILED',
        action: 'retry',
      });
    }

    const pending = nuevo || existing?.account_status === 'pending';
    if (nuevo) {
      await registrarSolicitudValet({ email: email || '', firstName, lastName, phone, city: city || businessLocation, company });
    } else if (email) {
      await supabaseAdmin.from('valet_applications')
        .update({ ...columnasSolicitud(company), updated_at: now })
        .ilike('email', email);
    }

    const token = await startSession({ id: userId, phone: phone || email || userId, role: assignedRole });

    log.info(`[Valet] complete-profile succeeded for ${email} (userId: ${userId})`);
    return res.status(200).json({
      success: true,
      pending,
      session: { access_token: token, refresh_token: token },
      user: { id: userId, email: email || '', firstName: firstName || '', lastName: lastName || '', role: assignedRole },
    });
  } catch (err) {
    log.error(`[Valet] complete-profile error: ${errMsg(err)}`);
    return res.status(500).json({
      error: 'Something went wrong while saving your profile. Please try again, or contact support@urbont.com if it keeps failing.',
      errorCode: 'PROFILE_SAVE_FAILED',
      action: 'retry',
    });
  }
});

function ipDe(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  const primero = Array.isArray(fwd) ? fwd[0] : fwd;
  const limpio = primero?.split(',')[0]?.trim();
  return limpio || req.ip || null;
}

/* ── GET /api/valet/agreement — texto vigente, sin sesión ── */
valetAuthRouter.get('/agreement', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  return res.json({
    version: ACUERDO_VERSION,
    title: 'Independent Valet Participation Agreement',
    text: ACUERDO_TEXTO,
    sha256: ACUERDO_HASH,
  });
});

/* ── POST /api/valet/agreement/accept — la pulsación de I AGREE ── */
valetAuthRouter.post('/agreement/accept', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.', errorCode: 'UNAUTHORIZED' });
  if (!aceptacionValida(req.body as { version?: string; checkbox?: boolean; action?: string })) {
    return res.status(400).json({
      error: 'Check the box and press I AGREE on the current agreement.',
      errorCode: 'AGREEMENT_REQUIRED',
    });
  }

  const { data: profile } = await supabaseAdmin.from('profiles')
    .select('first_name, last_name, email, role').eq('id', uid).maybeSingle();
  const role = String(profile?.role || req.supabaseRole || '');
  if (!profile || !['valet', 'frontdesk', 'concierge'].includes(role)) {
    return res.status(403).json({ error: 'Valet account required.', errorCode: 'ACCESS_DENIED' });
  }

  const name = [profile.first_name, profile.last_name].filter(Boolean).join(' ');
  const email = String(profile.email || '');
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from('valet_agreement_acceptances').insert({
    user_id: uid,
    valet_name: name || null,
    email: email || null,
    agreement_version: ACUERDO_VERSION,
    agreement_sha256: ACUERDO_HASH,
    accepted_at: now,
    checkbox_confirmed: true,
    action: 'i_agree',
    ip: ipDe(req),
    user_agent: req.get('user-agent') || null,
  });
  if (error) {
    log.error(`[Valet] agreement accept failed for ${uid}: ${error.message}`);
    return res.status(500).json({ error: 'Could not record your acceptance. Please try again.', errorCode: 'AGREEMENT_SAVE_FAILED' });
  }

  const copia = copiaFirmada({ name, email, acceptedAt: now, version: ACUERDO_VERSION, sha256: ACUERDO_HASH });
  enviarCopiaAcuerdoValet({ email, name }, copia).catch(() => {});
  return res.json({ success: true, version: ACUERDO_VERSION, acceptedAt: now });
});

/* ── GET /api/valet/agreement/copy — el acuerdo más el registro de la firma ── */
valetAuthRouter.get('/agreement/copy', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.', errorCode: 'UNAUTHORIZED' });
  const { data } = await supabaseAdmin.from('valet_agreement_acceptances')
    .select('valet_name, email, agreement_version, agreement_sha256, accepted_at')
    .eq('user_id', uid)
    .eq('agreement_version', ACUERDO_VERSION)
    .order('accepted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return res.status(404).json({ error: 'You have not signed this agreement yet.', errorCode: 'AGREEMENT_MISSING' });
  const texto = copiaFirmada({
    name: String(data.valet_name || ''),
    email: String(data.email || ''),
    acceptedAt: String(data.accepted_at),
    version: String(data.agreement_version),
    sha256: String(data.agreement_sha256),
  });
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="urbont-valet-agreement.txt"');
  return res.send(texto);
});

/* ── POST /api/valet/company — completar la compañía con la sesión de revisión ── */
valetAuthRouter.post('/company', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid;
  if (!uid) return res.status(401).json({ error: 'Unauthorized.', errorCode: 'UNAUTHORIZED' });
  const company = companiaDelBody(req.body as Record<string, unknown>);
  const falta = faltantesCompania(company);
  if (falta.length > 0) {
    return res.status(400).json({ error: 'Company information is required.', errorCode: 'COMPANY_INCOMPLETE', fields: falta });
  }
  const { data: profile } = await supabaseAdmin.from('profiles').select('email, role').eq('id', uid).maybeSingle();
  if (!profile || !['valet', 'frontdesk', 'concierge'].includes(String(profile.role))) {
    return res.status(403).json({ error: 'Valet account required.', errorCode: 'ACCESS_DENIED' });
  }
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from('profiles')
    .update({ ...columnasCompania(company), updated_at: now }).eq('id', uid);
  if (error) return res.status(500).json({ error: 'Could not save company information.', errorCode: 'COMPANY_SAVE_FAILED' });
  if (profile.email) {
    await supabaseAdmin.from('valet_applications')
      .update({ ...columnasSolicitud(company), updated_at: now })
      .ilike('email', String(profile.email));
  }
  return res.json({ success: true });
});
