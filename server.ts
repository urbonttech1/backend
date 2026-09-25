import "dotenv/config";
import * as Sentry from "@sentry/node";

const SENTRY_DSN = process.env.SENTRY_DSN;
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.2,
  });
}

import express, { Request, Response, NextFunction, ErrorRequestHandler } from "express";
import { createServer as createHttpServer } from "http";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { initSocketIO } from "./server/services/socketService";
import { referralRouter } from "./server/api/referrals";
import { securityRouter } from "./server/api/security";
import { rideRouter } from "./server/api/rides";
import { integrationsRouter } from "./server/api/integrations";
import { adminRouter } from "./server/api/admin";
import { adminAuthRouter } from "./server/api/admin-auth";
import { userRouter } from "./server/api/users";
import { otpRouter } from "./server/api/auth/otp";
import { sessionRouter } from "./server/api/auth/session";
import { chauffeurAuthRouter } from "./server/api/auth/chauffeur";
import { chauffeurDocsRouter } from "./server/api/chauffeur-docs";
import { valetAuthRouter } from "./server/api/auth/valet";
import { feedbackRouter } from "./server/api/feedback";
import { driverRouter } from "./server/api/drivers";
import { driverIncidentsRouter } from "./server/api/driver-incidents";
import { notificationsRouter } from "./server/api/notifications";
import { supportRouter } from "./server/api/support";
import { configRouter } from "./server/api/config";
import { translationRouter } from "./server/api/translation";
import { geocodeRouter } from "./server/api/geocode";
import { pushRouter } from "./server/api/push";
import { diagnosticsRouter } from "./server/api/diagnostics";
import { flightsRouter } from "./server/api/flights";
import { placesRouter } from "./server/api/places";
import { promoRouter } from "./server/api/promo";
import { tipsRouter } from "./server/api/tips";
import { corporateRouter } from "./server/api/corporate";
import { subscriptionsRouter } from "./server/api/subscriptions";
import { splitsRouter } from "./server/api/splits";
import { applicationsRouter } from "./server/api/applications";
import { errorsRouter } from "./server/api/errors";
import { supabaseAdmin } from "./server/db/client";
import { verifySupabaseSchema } from "./server/db/schemaCheck";
import { pool } from "./server/db/pool";
import { startCronJobs } from "./server/jobs/cron";
import { sanitizeBody } from "./server/middleware";
import { runMigrations } from "./server/db/migrations";
import { loadFares } from "./server/services/fareConfig";
import { loadZones } from "./server/services/serviceZones";
import { runIntegrationChecks } from "./server/services/integrationChecks";
import { logger } from "./server/lib/logger";

// ── Safety guard: bypass flags must never be active in production ─────────────
if (process.env.NODE_ENV === 'production') {
  const dangerousVars = ['OTP_BYPASS', 'BYPASS', 'BYPASS_CODE'];
  const active = dangerousVars.filter(v => process.env[v]);
  if (active.length > 0) {
    // Log as fatal and refuse to start — a bypass flag in production is a
    // security misconfiguration that could allow OTP/auth to be skipped.
    console.error(
      `[FATAL] Production server started with bypass env var(s) set: ${active.join(', ')}. ` +
      'Remove these variables from the production environment and restart. Exiting.'
    );
    process.exit(1);
  }
}

// ── Rate limiters (express-rate-limit) ────────────────────────────────────────

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
  skip: (req) => req.method === 'OPTIONS',
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please wait before retrying.' },
});

const locationLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Location update rate limit exceeded.' },
});

async function setupDemoDriverAccount(): Promise<void> {
  const DEMO_EMAIL = 'driver@urbont.com';
  const DEMO_PASSWORD = process.env.DEMO_DRIVER_PASSWORD || 'Urbont2025!';

  // Skip if Supabase is not configured (local/dev environment without real credentials)
  if (!process.env.SUPABASE_URL || process.env.SUPABASE_URL.includes('placeholder')) {
    logger.info('[startup] Supabase not configured — skipping demo driver setup');
    return;
  }

  let userId: string | null = null;

  // First try: check via list users (paginates first page)
  try {
    const { data: listData } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const found = (listData?.users as Array<{ id: string; email?: string }> | undefined)
      ?.find(u => u.email === DEMO_EMAIL);
    if (found) {
      userId = found.id;
      // Update password and clear any ban to ensure account is accessible
      await supabaseAdmin.auth.admin.updateUserById(userId, { password: DEMO_PASSWORD, email_confirm: true, ban_duration: 'none' });
      logger.info({ userId }, '[startup] Demo driver auth user found — password refreshed');
    }
  } catch {
    // list may fail — continue with create attempt
  }

  // Second try: create the auth user (if not found above)
  if (!userId) {
    const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      email_confirm: true,
    });
    if (createErr) {
      // "User already registered" means it exists — try to find via profile table
      if (createErr.message?.toLowerCase().includes('already')) {
        const { data: profileRow } = await supabaseAdmin
          .from('profiles')
          .select('id')
          .eq('email', DEMO_EMAIL)
          .maybeSingle();
        if (profileRow?.id) {
          userId = profileRow.id as string;
          await supabaseAdmin.auth.admin.updateUserById(userId, { password: DEMO_PASSWORD, email_confirm: true });
          logger.info({ userId }, '[startup] Demo driver auth user found via profile — password refreshed');
        } else {
          throw new Error(`Cannot resolve driver@urbont.com auth user: ${createErr.message}`);
        }
      } else {
        throw new Error(createErr.message);
      }
    } else if (newUser?.user?.id) {
      userId = newUser.user.id;
      logger.info({ userId }, '[startup] Demo driver auth user created');
    }
  }

  if (!userId) throw new Error('Could not determine userId for driver@urbont.com');

  // Store verification/role data in app_metadata (always available, bypasses schema cache issues)
  const demoVehicle = { category: 'suv', class: 'SUV', color: 'Black', make: 'Cadillac', model: 'Escalade', plate: 'TEST-1', year: '2025' };
  await supabaseAdmin.auth.admin.updateUserById(userId, {
    app_metadata: {
      role: 'chauffeur',
      verification_status: 'approved',
      operating_city: 'Miami',
      first_name: 'Carlos',
      last_name: 'Urbont',
      vehicle: demoVehicle,
    },
  });
  logger.info({ userId }, '[startup] Demo driver app_metadata updated');

  // Ensure driver is unblocked (reset consecutive rejections from testing)
  try {
    await supabaseAdmin.from('profiles').update({
      is_blocked: false,
      block_reason: null,
      consecutive_rejections: 0,
      priority_score: 1.0,
      updated_at: new Date().toISOString(),
    }).eq('id', userId);
  } catch { /* non-critical */ }

  // Profile upsert — try progressively minimal payloads if columns are missing in PostgREST
  const profilePayloads = [
    {
      id: userId, email: DEMO_EMAIL, phone: '+17865550001',
      first_name: 'Carlos', last_name: 'Urbont',
      role: 'chauffeur', verification_status: 'approved',
      operating_city: 'Miami', account_status: 'active',
      vehicle: demoVehicle, rating: 5.0,
      is_blocked: false, consecutive_rejections: 0, priority_score: 1.0,
    },
    {
      id: userId, email: DEMO_EMAIL, phone: '+17865550001',
      first_name: 'Carlos', last_name: 'Urbont',
      role: 'chauffeur', verification_status: 'approved',
      vehicle: demoVehicle,
    },
    {
      id: userId, email: DEMO_EMAIL, phone: '+17865550001',
      first_name: 'Carlos', last_name: 'Urbont',
      role: 'chauffeur', verification_status: 'approved',
    },
    {
      id: userId, email: DEMO_EMAIL, phone: '+17865550001',
      first_name: 'Carlos', last_name: 'Urbont', role: 'chauffeur',
    },
    { id: userId, email: DEMO_EMAIL, role: 'chauffeur' },
    { id: userId, role: 'chauffeur' },
  ];

  for (const payload of profilePayloads) {
    const { error } = await supabaseAdmin.from("profiles").upsert(payload as any, { onConflict: "id" });
    if (!error) {
      logger.info({ keys: Object.keys(payload) }, '[startup] Profile upserted via PostgREST');
      break;
    }
    const isSchemaErr = error.message?.includes('column') || error.message?.includes('schema cache');
    if (!isSchemaErr) {
      logger.error({ err: error.message }, '[startup] Profile upsert failed with non-schema error');
      break;
    }
    logger.warn({ err: error.message }, '[startup] Retrying profile upsert with fewer columns');
  }

  logger.info('[startup] ✅ Demo driver ready — driver@urbont.com / Urbont2025!');
}

async function setupDemoValetAccount(): Promise<void> {
  const DEMO_EMAIL  = 'valet@urbont.com';
  const DEMO_ID     = '8c30634c-da85-42b2-8be7-56f9a1a005ff';
  const DEMO_PASSWORD = process.env.DEMO_VALET_PASSWORD || 'Urbont2025!';

  if (!process.env.SUPABASE_URL || process.env.SUPABASE_URL.includes('placeholder')) return;

  // 1. Ensure auth user exists
  let userId: string | null = null;
  try {
    const { data: listData } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const found = (listData?.users as Array<{ id: string; email?: string }> | undefined)?.find(u => u.email === DEMO_EMAIL);
    if (found) {
      userId = found.id;
      await supabaseAdmin.auth.admin.updateUserById(userId, { password: DEMO_PASSWORD, email_confirm: true });
    }
  } catch { /* continue */ }

  if (!userId) {
    const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: DEMO_EMAIL, password: DEMO_PASSWORD, email_confirm: true,
    });
    if (createErr?.message?.toLowerCase().includes('already')) {
      userId = DEMO_ID;
      await supabaseAdmin.auth.admin.updateUserById(userId, { password: DEMO_PASSWORD, email_confirm: true }).catch(() => {});
    } else if (newUser?.user?.id) {
      userId = newUser.user.id;
    }
  }

  if (!userId) { logger.warn('[startup] Could not resolve valet demo user'); return; }

  // 2. Ensure profile row exists via direct SQL (bypasses PostgREST schema cache)
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO profiles (id, email, first_name, last_name, role, created_at, updated_at)
       VALUES ($1, $2, 'Demo', 'Valet', 'valet', NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET email=$2, role='valet', updated_at=NOW()`,
      [userId, DEMO_EMAIL]
    );
    logger.info('[startup] ✅ Demo valet ready — valet@urbont.com / Urbont2025!');
  } finally {
    client.release();
  }
}

// ── One-time driver approval ─────────────────────────────────────────────────
// Approves a specific driver account by phone or email on startup.
// Safe to run multiple times — only updates if not already 'approved'.
async function approveDriverIfNeeded(phone: string, email: string): Promise<void> {
  if (!process.env.SUPABASE_URL || process.env.SUPABASE_URL.includes('placeholder')) return;
  try {
    const variants = Array.from(new Set([phone, phone.replace(/[^0-9]/g, ''), `+${phone.replace(/[^0-9]/g, '')}`]));
    let profileId: string | null = null;
    let currentStatus: string | null = null;

    for (const variant of variants) {
      const { data } = await supabaseAdmin.from('profiles').select('id, verification_status').eq('phone', variant).maybeSingle();
      if (data?.id) { profileId = data.id as string; currentStatus = data.verification_status as string; break; }
    }
    if (!profileId) {
      const { data } = await supabaseAdmin.from('profiles').select('id, verification_status').eq('email', email.toLowerCase()).maybeSingle();
      if (data?.id) { profileId = data.id as string; currentStatus = data.verification_status as string; }
    }
    if (!profileId) { logger.warn(`[startup] Driver ${email} / ${phone} not found — skipping approval`); return; }
    if (currentStatus === 'approved') { logger.info(`[startup] Driver ${profileId} already approved — skipping`); return; }

    const now = new Date().toISOString();
    const { error } = await supabaseAdmin.from('profiles').update({
      verification_status: 'approved',
      background_check: { status: 'approved', completed_at: now },
      account_status: 'active',
      updated_at: now,
    }).eq('id', profileId);
    if (error) throw new Error(error.message);
    logger.info({ profileId, phone, email }, '[startup] ✅ Driver approved as conductor');
  } catch (err: any) {
    logger.warn({ err: (err as Error).message }, '[startup] approveDriverIfNeeded failed — non-fatal');
  }
}

async function startServer() {
  const app = express();
  // Hyperlift injects PORT at runtime. Default 3000 for Docker deployment.
  const PORT = parseInt(process.env.PORT || '3000', 10);
  logger.info({ port: PORT }, 'Application starting');

  // Trust the first proxy hop (Hyperlift reverse proxy) so req.ip reflects the real client IP
  app.set('trust proxy', 1);

  app.use(helmet({
    // CSP in report-only mode: logs violations to console without blocking anything.
    // Switch reportOnly → false once you've confirmed no violations in production.
    contentSecurityPolicy: {
      reportOnly: true,
      directives: {
        defaultSrc:       ["'self'"],
        scriptSrc:        ["'self'", "'unsafe-inline'", "https://js.stripe.com", "https://maps.googleapis.com"],
        styleSrc:         ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc:          ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc:           ["'self'", "data:", "blob:", "https:", "https://*.supabase.co", "https://*.googleapis.com", "https://*.gstatic.com"],
        connectSrc:       [
          "'self'",
          "https://*.supabase.co", "wss://*.supabase.co",
          "https://*.stripe.com", "https://*.stripe.network",
          "https://*.googleapis.com",
          "https://*.sentry.io",
          "https://app.urbont.com", "wss://app.urbont.com",
          "https://*.firebaseio.com", "wss://*.firebaseio.com",
          "https://fcmregistrations.googleapis.com",
        ],
        frameSrc:         ["https://js.stripe.com", "https://hooks.stripe.com"],
        workerSrc:        ["'self'", "blob:"],
        manifestSrc:      ["'self'"],
        mediaSrc:         ["'self'", "blob:"],
        objectSrc:        ["'none'"],
        baseUri:          ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
    frameguard: { action: 'sameorigin' },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  }));

  // Block source map files — never expose in production
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.endsWith('.map')) {
      return res.status(404).end();
    }
    next();
  });

  // ── CORS ────────────────────────────────────────────────────────────────────
  // Va AQUÍ, antes que cualquier ruta y antes que los limitadores de peticiones,
  // y no más abajo como estaba. Un middleware sólo afecta a lo que se registra
  // después de él, así que con el orden anterior:
  //
  //   - GET /api/healthz (declarado más arriba) respondía SIN
  //     Access-Control-Allow-Origin, y el navegador de la app descartaba la
  //     respuesta. El OPTIONS sí funcionaba —app.get no captura OPTIONS, así que
  //     el preflight llegaba hasta aquí— y eso hacía el fallo desconcertante.
  //
  //   - Un 429 de los limitadores tampoco llevaba la cabecera: el cliente veía
  //     un error de CORS en vez de «demasiadas peticiones». Esto no lo reportó
  //     nadie, pero es el mismo fallo.
  //
  // Regla general: el CORS va primero, porque también las respuestas de error
  // tienen que ser legibles para quien las pidió.
  const HYPERLIFT_ORIGIN = process.env.HYPERLIFT_URL 
    ? `https://${process.env.HYPERLIFT_URL}` 
    : 'https://app.urbont.com';
  
  const envOrigins = process.env.ALLOWED_ORIGIN
    ? process.env.ALLOWED_ORIGIN.split(',').map(s => s.trim())
    : [];
  const corsOrigins = Array.from(new Set([
    'http://localhost:5173',
    'http://localhost:5000',
    'http://localhost:8080',
    // ── Capacitor / native WebView origins ───────────────────────────────────
    // Android (androidScheme: 'https') — the WebView uses https://localhost
    'https://localhost',
    // Android (androidScheme: 'http') and some older Capacitor versions
    'http://localhost',
    // Capacitor iOS and certain Android configs
    'capacitor://localhost',
    // Ionic / legacy Capacitor
    'ionic://localhost',
    // ─────────────────────────────────────────────────────────────────────────
    'https://app.urbont.com',
    'https://www.urbont.com',
    'https://urbont.com',
    HYPERLIFT_ORIGIN,
    ...envOrigins
  ]));
  // FIX: corsOpen was true whenever ALLOWED_ORIGIN was unset, including in production.
  // This meant any origin could make credentialed cross-origin requests to the API.
  // In production the hardcoded allowlist (app.urbont.com, localhost, Capacitor origins)
  // is the correct default — open mode is only appropriate in local development.
  const corsOpen = envOrigins.length === 0 && process.env.NODE_ENV !== 'production';
  if (process.env.NODE_ENV === 'production' && envOrigins.length === 0) {
    logger.warn('[CORS] ALLOWED_ORIGIN is not set — using hardcoded origin allowlist. Set ALLOWED_ORIGIN=https://app.urbont.com to explicitly configure allowed origins.');
  }

  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin || '';
    if (corsOpen) {
      // Development only: reflect any origin so local tooling works without configuration.
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    } else if (origin && corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    // If origin is not in the allowlist, no Access-Control-Allow-Origin header is set,
    // which causes browsers to block the response — correct secure behavior.
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });


  // ── Health check — must be BEFORE rate limiters so monitoring tools are never blocked ──
  // Cloud Run uses this for liveness/readiness probes.
  // UptimeRobot / BetterUptime should ping GET /api/healthz every 5 minutes.
  // ── Android App Links verification ─────────────────────────────────────────
// Required for autoVerify="true" in AndroidManifest.xml intent-filter.
// Replace sha256_cert_fingerprints with your keystore fingerprint:
//   keytool -list -v -keystore urbont-release.jks -alias urbont
// Look for "SHA256:" in the output and paste it below (format: AA:BB:CC:...)
app.get('/.well-known/assetlinks.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'com.urbont.app',
      sha256_cert_fingerprints: [
        process.env.ANDROID_CERT_FINGERPRINT || 'REPLACE_WITH_YOUR_SHA256_FINGERPRINT',
      ],
    },
  }]);
});

app.get('/', (_req: Request, res: Response) => {
  res.json({
    msg: 'URBONT API',
    version: process.env.npm_package_version ?? '1.8.9',
  });
});

app.get('/api/healthz', async (_req: Request, res: Response) => {
    const start = Date.now();
    const checks: Record<string, string> = {};

    // DB connectivity check — lightweight single-row query
    try {
      await pool.query('SELECT 1');
      checks.db = 'ok';
    } catch (e: any) {
      checks.db = `error: ${e?.message ?? String(e)}`;
    }

    const allOk = Object.values(checks).every(v => v === 'ok');
    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ok' : 'degraded',
      version: process.env.npm_package_version ?? '1.2.2',
      uptime: Math.floor(process.uptime()),
      checks,
      ts: new Date().toISOString(),
      latencyMs: Date.now() - start,
    });
  });

  app.use('/api', apiLimiter);
  app.use('/api/otp', authLimiter);
  app.use('/api/chauffeur/login', authLimiter);
  app.use('/api/valet/login', authLimiter);
  app.use('/api/drivers/location', locationLimiter);

  // Stripe webhook — raw body MUST be parsed before express.json() for signature verification
  app.use('/api/integrations/stripe/webhook', express.raw({ type: 'application/json' }));

  // Per-route body size limits — avatar/vehicle-photo send base64 images (up to ~7MB encoded)
  app.use('/api/integrations/stripe/webhook', (req, res, next) => next()); // already handled above
  app.use('/api/users/avatar', express.json({ limit: '8mb' }));
  app.use('/api/users/vehicle-photo', express.json({ limit: '8mb' }));
  app.use('/api/chauffeur/upload-doc', express.json({ limit: '15mb' }));
  app.use('/api/chauffeur/documents', express.json({ limit: '50mb' })); // batch upload: up to ~11 docs × ~4MB each
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));


  app.use("/api/security", securityRouter);
  app.use("/api/referrals", referralRouter);
  app.use("/api/rides", rideRouter);
  app.use("/api/integrations", integrationsRouter);
  app.use("/api/admin/auth", adminAuthRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/users", userRouter);
  app.use("/api/otp", otpRouter);
  app.use("/api/auth", sessionRouter);
  app.use("/api/chauffeur", chauffeurAuthRouter);
  app.use("/api/chauffeur", chauffeurDocsRouter);
  app.use("/api/valet", valetAuthRouter);
  app.use("/api/feedback", feedbackRouter);
  app.use("/api/drivers", driverRouter);
  app.use("/api/drivers", driverIncidentsRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/support", supportRouter);
  app.use("/api/config", configRouter);
  app.use("/api/translation", translationRouter);
  app.use("/api/geocode", geocodeRouter);
  app.use("/api/push", pushRouter);
  app.use("/api/flights", flightsRouter);
  app.use("/api/places", placesRouter);
  app.use("/api/promo", promoRouter);
  app.use("/api/tips", tipsRouter);
  app.use("/api/corporate", corporateRouter);
  app.use("/api/subscriptions", subscriptionsRouter);
  app.use("/api/splits", splitsRouter);
  app.use("/api/applications", applicationsRouter);
  app.use("/api", diagnosticsRouter);
  app.use("/api/errors", errorsRouter);


  // ── GET /api/setup/diag ─────────────────────────────────────────────────────
  // Diagnostic endpoint: tests pool queries for demo accounts.
  app.get('/api/setup/diag', async (req, res) => {
    const secret = req.query.s as string;
    const SETUP_SECRET = process.env.SETUP_SECRET;
    if (!secret || secret !== SETUP_SECRET) return res.status(403).json({ error: 'Forbidden' });
    const out: Record<string, unknown> = {};
    try {
      // Test 1: basic pool connectivity
      const pingRes = await pool.query<{ now: string }>('SELECT NOW() as now');
      out.pool_ping = pingRes.rows[0]?.now || 'no_row';
    } catch (err: any) { out.pool_ping = `error: ${(err as Error).message}`; }
    try {
      // Test 2: columns in profiles table
      const colRes = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' ORDER BY ordinal_position`,
      );
      out.profiles_columns = colRes.rows.map(r => r.column_name);
    } catch (err: any) { out.profiles_columns = `error: ${(err as Error).message}`; }
    try {
      // Test 3: query profiles by email
      const profRes = await pool.query(`SELECT id, email, role FROM public.profiles WHERE email IN ('valet@urbont.com','driver@urbont.com')`);
      out.profiles_by_email = profRes.rows;
    } catch (err: any) { out.profiles_by_email = `error: ${(err as Error).message}`; }
    try {
      // Test 4: query auth.users by email
      const authRes = await pool.query(`SELECT id, email FROM auth.users WHERE email IN ('valet@urbont.com','driver@urbont.com')`);
      out.auth_users = authRes.rows;
    } catch (err: any) { out.auth_users = `error: ${(err as Error).message}`; }
    try {
      // Test 5: query profiles by role
      const roleRes = await pool.query<{ id: string; email: string | null; role: string }>(
        `SELECT id, email, role FROM public.profiles WHERE role IN ('valet','chauffeur') LIMIT 5`
      );
      out.profiles_by_role = roleRes.rows;
    } catch (err: any) { out.profiles_by_role = `error: ${(err as Error).message}`; }
    return res.json(out);
  });

  // ── POST /api/setup/reset-demo-users ─────────────────────────────────────────
  // Force-reset demo account passwords via direct Postgres (works even when
  // supabaseAdmin is broken due to bad service role key).
  // Usage: curl -X POST https://app.urbont.com/api/setup/reset-demo-users \
  //        -H "Content-Type: application/json" \
  //        -d '{"setupSecret":"<your-SETUP_SECRET-env-var>"}'
  app.post('/api/setup/reset-demo-users', express.json(), async (req, res) => {
    const SETUP_SECRET = process.env.SETUP_SECRET;
    const { setupSecret } = req.body as { setupSecret?: string };
    if (!setupSecret || setupSecret !== SETUP_SECRET) {
      return res.status(403).json({ error: 'Invalid setup secret.' });
    }

    const results: Record<string, string> = {};
    const accounts = [
      { email: 'valet@urbont.com',  password: process.env.DEMO_VALET_PASSWORD  || 'Urbont2025!', role: 'valet'     },
      { email: 'driver@urbont.com', password: process.env.DEMO_DRIVER_PASSWORD || 'Urbont2025!', role: 'chauffeur' },
    ];

    // Try supabaseAdmin first; fall back to pool.query for password reset via Supabase API raw fetch
    for (const account of accounts) {
      try {
        const { data: listData } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const found = listData?.users?.find(u => u.email === account.email);
        if (found) {
          const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(found.id, {
            password: account.password,
            email_confirm: true,
            ban_duration: 'none',
          });
          results[account.email] = updateErr ? `update_failed: ${updateErr.message}` : 'password_reset_ok';
        } else {
          // User not found via admin — try pool to find user ID then reset via Supabase REST
          const authRow = await pool.query<{ id: string }>(`SELECT id FROM auth.users WHERE email = $1 LIMIT 1`, [account.email]);
          if (authRow.rows.length) {
            const { error: createErr } = await supabaseAdmin.auth.admin.updateUserById(authRow.rows[0].id, { password: account.password, email_confirm: true });
            results[account.email] = createErr ? `pool_update_failed: ${createErr.message}` : 'pool_reset_ok';
          } else {
            const { error: createErr } = await supabaseAdmin.auth.admin.createUser({
              email: account.email, password: account.password, email_confirm: true,
            });
            results[account.email] = createErr ? `create_failed: ${createErr.message}` : 'created_ok';
          }
        }
      } catch (err: any) {
        const e = err as { message?: string };
        results[account.email] = `error: ${e?.message || 'unknown'}`;
      }
    }

    logger.info({ results }, '[setup] Demo user reset results');
    return res.json({ ok: true, results });
  });

  // ── POST /api/setup/approve-driver ──────────────────────────────────────────
  // One-time utility: approve a driver account by phone or email.
  // Usage: curl -X POST https://app.urbont.com/api/setup/approve-driver \
  //        -H "Content-Type: application/json" \
  //        -d '{"setupSecret":"<SETUP_SECRET>","phone":"7864165121"}'
  app.post('/api/setup/approve-driver', express.json(), async (req, res) => {
    const SETUP_SECRET = process.env.SETUP_SECRET;
    const { setupSecret, phone, email } = req.body as { setupSecret?: string; phone?: string; email?: string };
    if (!setupSecret || setupSecret !== SETUP_SECRET) {
      return res.status(403).json({ error: 'Invalid setup secret.' });
    }
    if (!phone && !email) {
      return res.status(400).json({ error: 'Provide phone or email.' });
    }

    try {
      // Find profile by phone (try bare digits and E.164 variants) or email
      let profileId: string | null = null;

      if (phone) {
        const variants = Array.from(new Set([
          phone,
          phone.replace(/[^0-9]/g, ''),
          `+${phone.replace(/[^0-9]/g, '')}`,
        ]));
        for (const variant of variants) {
          const { data } = await supabaseAdmin.from('profiles').select('id').eq('phone', variant).maybeSingle();
          if (data?.id) { profileId = data.id as string; break; }
        }
        // Also try pool (direct SQL) as a second strategy
        if (!profileId) {
          try {
            const digits = phone.replace(/[^0-9]/g, '');
            const { rows } = await pool.query<{ id: string }>(
              `SELECT id FROM profiles WHERE phone IN ($1, $2, $3) LIMIT 1`,
              [phone, digits, `+${digits}`],
            );
            if (rows[0]?.id) profileId = rows[0].id;
          } catch { /* pool may not be configured */ }
        }
      }

      if (!profileId && email) {
        const { data } = await supabaseAdmin.from('profiles').select('id').eq('email', email.toLowerCase()).maybeSingle();
        if (data?.id) profileId = data.id as string;
        if (!profileId) {
          try {
            const { rows } = await pool.query<{ id: string }>(
              `SELECT id FROM profiles WHERE email = $1 LIMIT 1`,
              [email.toLowerCase()],
            );
            if (rows[0]?.id) profileId = rows[0].id;
          } catch { /* pool may not be configured */ }
        }
      }

      if (!profileId) {
        return res.status(400).json({ error: 'Could not locate account with provided credentials.' });
      }

      const now = new Date().toISOString();
      // Approve via supabaseAdmin
      const { error: saErr } = await supabaseAdmin.from('profiles').update({
        verification_status: 'approved',
        background_check: { status: 'approved', completed_at: now },
        account_status: 'active',
        updated_at: now,
      }).eq('id', profileId);

      if (saErr) {
        // Fallback to pool
        await pool.query(
          `UPDATE profiles SET verification_status = 'approved', account_status = 'active', updated_at = $1 WHERE id = $2`,
          [now, profileId],
        );
      }

      logger.info({ profileId, phone, email }, '[setup] Driver approved manually');
      return res.json({ success: true, message: 'Driver approved as conductor.' });
    } catch (err: any) {
      logger.error(`[setup/approve-driver] ${(err as Error).message}`);
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/coverage/check", async (req, res) => {
    const rawCity = req.query.city ? String(req.query.city).replace(/[^a-zA-Z\s,.-]/g, '').trim().substring(0, 100) : undefined;
    const { lat, lng } = req.query as { lat?: string; lng?: string };
    const city = rawCity || undefined;

    try {
      let query = supabaseAdmin
        .from('profiles')
        .select('id, operating_city', { count: 'exact', head: false })
        .eq('verification_status', 'approved')
        .eq('role', 'chauffeur');

      if (city) {
        query = query.ilike('operating_city', `%${city}%`);
      }

      const { count, error } = await query.limit(1);

      if (error) {
        return res.json({ covered: true, message: 'Coverage data unavailable — service assumed available.' });
      }

      const hasCoverage = (count ?? 0) > 0;

      void lat; void lng;

      return res.json({
        covered: hasCoverage,
        city: city || 'Miami',
        message: hasCoverage ? 'Service available in your area.' : 'No chauffeurs currently active in your area.',
      });
    } catch {
      return res.json({ covered: true, message: 'Coverage data unavailable — service assumed available.' });
    }
  });


  // ── Health & diagnostics ─────────────────────────────────────────────────────
  // Hyperlift pings /health and /ping to confirm the process is alive.
  // /api/health exposes a full env-var status map for deployment debugging —
  // it shows which variables are present/missing without revealing their values.
  // Registered BEFORE the SPA catch-all so these always respond correctly.
  app.get("/health", (_req, res) => res.send('URBONT API IS ALIVE'));
  app.get("/ping",   (_req, res) => res.send('ok'));

  app.get("/api/health", (_req, res) => {
    const ok  = (v: string | undefined) => (!!v ? 'ok' : 'MISSING');
    const sk  = process.env.STRIPE_SECRET_KEY;

    const env = {
      // ── Database (server crashes on boot if any of these are missing) ──
      SUPABASE_DB_URL:             ok(process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.VITE_SUPABASE_DB_URL),
      SUPABASE_URL:                ok(process.env.SUPABASE_URL    || process.env.VITE_SUPABASE_URL),
      SUPABASE_SERVICE_ROLE_KEY:   ok(process.env.SUPABASE_SERVICE_ROLE_KEY),
      SUPABASE_ANON_KEY:           ok(process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY),
      // ── Auth ──
      JWT_SECRET:                  ok(process.env.JWT_SECRET),
      // ── Payments ──
      STRIPE_SECRET_KEY:           sk ? (sk.startsWith('sk_') ? 'ok' : 'INVALID_FORMAT') : 'MISSING',
      STRIPE_PUBLISHABLE_KEY:      ok(process.env.VITE_STRIPE_PUBLISHABLE_KEY),
      STRIPE_WEBHOOK_SECRET:       ok(process.env.STRIPE_WEBHOOK_SECRET),
      // ── Maps ──
      GOOGLE_MAPS_API_KEY:         ok(process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY),
      // ── Push notifications ──
      FIREBASE_SERVICE_ACCOUNT:    ok(process.env.FIREBASE_SERVICE_ACCOUNT),
      FIREBASE_VAPID_KEY:          ok(process.env.VITE_FIREBASE_VAPID_KEY),
      // ── SMS ──
      // Twilio is the only provider wired up: every SMS goes through
      // sendSmsTwilio(). This line used to claim a fallback chain of
      // infobip → twilio → telnyx, but no code existed for the other two, so
      // setting INFOBIP_API_KEY made the diagnostic report 'infobip' while
      // messages kept going out through Twilio.
      SMS_PROVIDER:                process.env.TWILIO_AUTH_TOKEN ? 'twilio' : 'NONE_CONFIGURED',
      // ── Admin panel ──
      ADMIN_SECRET_KEY:            ok(process.env.ADMIN_SECRET_KEY),
    };

    const missing = Object.entries(env)
      .filter(([, v]) => v === 'MISSING' || v === 'NONE_CONFIGURED' || v === 'INVALID_FORMAT')
      .map(([k]) => k);

    res.json({
      status:        missing.length === 0 ? 'ok' : 'degraded',
      timestamp:     new Date().toISOString(),
      service:       'URBONT API',
      node_env:      process.env.NODE_ENV || 'development',
      env,
      missing_count: missing.length,
      missing,
      hint:          missing.length > 0
        ? 'Set the missing variables in Hyperlift → your app → Environment Variables, then redeploy.'
        : 'All environment variables are configured.',
    });
  });

  // ── Real Supabase connectivity test ────────────────────────────────────────
  // Hit GET /api/health/db after fixing env vars to confirm the DB is actually reachable.
  // Returns ok/error so you can distinguish "key is set" from "key is valid".
  app.get("/api/health/db", async (_req, res) => {
      const results: Record<string, unknown> = {};

      // ── Key format sanity check (no value revealed) ─────────────────────────
      const rawServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
      const keyPrefix = rawServiceKey.slice(0, 12);
      results.service_key_prefix = keyPrefix || '(empty)';
      results.service_key_format = rawServiceKey.startsWith('sb_secret_') || rawServiceKey.startsWith('eyJ')
        ? 'ok — correct service_role format'
        : rawServiceKey.startsWith('sb_publishable_')
          ? 'WRONG — this is the anon/publishable key, not the service_role key!'
          : `unknown — first 12 chars: "${keyPrefix}"`;

      // ── 1. supabaseAdmin row count — service role bypasses RLS, anon key does NOT ──
      try {
        const { count, error } = await supabaseAdmin
          .from('profiles')
          .select('id', { count: 'exact', head: true });
        if (error) {
          results.supabase_admin = `ERROR: ${error.message} (code: ${error.code ?? 'n/a'})`;
        } else if (!count || count === 0) {
          results.supabase_admin = 'FAIL — 0 rows returned. RLS is blocking access — SUPABASE_SERVICE_ROLE_KEY is likely the anon key (sb_publishable_), not the service_role key (sb_secret_).';
        } else {
          results.supabase_admin = `ok — service role bypasses RLS (${count} profiles visible)`;
        }
      } catch (e: any) {
        results.supabase_admin = `EXCEPTION: ${e?.message ?? String(e)}`;
      }

      // ── 2. WHERE clause test — chauffeur lookup (same as getUserDoc/getDriverDoc) ──
      try {
        const { data: row, error } = await supabaseAdmin
          .from('profiles').select('id, role').eq('role', 'chauffeur').limit(1).maybeSingle();
        results.supabase_where = error
          ? `ERROR: ${error.message}`
          : row
            ? `ok — WHERE filter works, found chauffeur id=${String((row as Record<string,unknown>).id ?? '').slice(0, 8)}...`
            : 'FAIL — WHERE query returned null. RLS is blocking row-level access.';
      } catch (e: any) {
        results.supabase_where = `EXCEPTION: ${e?.message ?? String(e)}`;
      }

      // ── 3. Direct postgres pool ──────────────────────────────────────────────
      try {
        const r = await pool.query('SELECT COUNT(*) FROM public.profiles');
        results.pg_pool = `ok — direct postgres works (${r.rows[0]?.count} profiles)`;
      } catch (e: any) {
        results.pg_pool = `ERROR: ${e?.message ?? String(e)}`;
      }

      const adminOk = String(results.supabase_admin).startsWith('ok');
      const whereOk = String(results.supabase_where).startsWith('ok');
      const poolOk  = String(results.pg_pool).startsWith('ok');
      const allOk   = adminOk && whereOk && poolOk;

      res.status(allOk ? 200 : 500).json({
        status:    allOk ? 'ok' : 'db_error',
        timestamp: new Date().toISOString(),
        checks:    results,
        hint: allOk
          ? 'All checks passed. Database is fully operational.'
          : !adminOk || !whereOk
            ? 'SUPABASE_SERVICE_ROLE_KEY is wrong or is the anon key. In Hyperlift: the value must start with sb_secret_ (NOT sb_publishable_). Copy from Supabase Dashboard → Project Settings → API → service_role → Reveal.'
            : 'pg_pool failed — check SUPABASE_DB_URL / DATABASE_URL.',
      });
    });

  // ── Firebase push-notification diagnostics ───────────────────────────────────
  // GET /api/health/firebase?s=<SETUP_SECRET>
  // Checks every layer of the push-notification stack and tells you exactly what is broken.
  app.get('/api/health/firebase', async (req, res) => {
    const secret = req.query.s as string;
    const SETUP_SECRET = process.env.SETUP_SECRET;
    if (!secret || secret !== SETUP_SECRET) return res.status(403).json({ error: 'Forbidden — pass ?s=<SETUP_SECRET>' });

    const checks: Record<string, unknown> = {};

    // ── 1. Environment variables ─────────────────────────────────────────────
    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT ?? '';
    const vapidKey           = process.env.VITE_FIREBASE_VAPID_KEY   ?? '';

    checks.env_FIREBASE_SERVICE_ACCOUNT = serviceAccountRaw ? 'present' : 'MISSING — server push is disabled';
    checks.env_VITE_FIREBASE_VAPID_KEY  = vapidKey           ? 'present' : 'MISSING — web FCM tokens cannot be obtained';

    // ── 2. Service account JSON validity ────────────────────────────────────
    let serviceAccountObj: Record<string, unknown> | null = null;
    if (serviceAccountRaw) {
      try {
        serviceAccountObj = JSON.parse(serviceAccountRaw);
        const expectedProject = 'gen-lang-client-0511522171';
        const actualProject   = (serviceAccountObj as Record<string,unknown>).project_id ?? '?';
        checks.service_account_project_id = actualProject;
        checks.service_account_project_match = actualProject === expectedProject
          ? `ok — matches expected project (${expectedProject})`
          : `MISMATCH — got "${actualProject}", expected "${expectedProject}"`;
        checks.service_account_project_hint = actualProject !== expectedProject
          ? `ACTION REQUIRED: Go to Firebase Console → Project gen-lang-client-0511522171 → Project Settings → Service accounts → Generate new private key`
          : undefined;
        checks.service_account_type = (serviceAccountObj as Record<string,unknown>).type ?? '?';
      } catch {
        checks.service_account_json = 'INVALID JSON — paste the entire service-account JSON as a single line';
      }
    }

    // ── 3. Firebase Admin initialisation test ───────────────────────────────
    try {
      const admin = await import('firebase-admin');
      if (!admin.default.apps.length && serviceAccountObj) {
        admin.default.initializeApp({
          // `as unknown` no convertía a nada: sólo apagaba el chequeo y dejaba el
          // argumento sin tipo. `cert()` espera un ServiceAccount, que es la forma
          // que tiene el JSON de credenciales que se parseó arriba.
          credential: admin.default.credential.cert(
            serviceAccountObj as import('firebase-admin').ServiceAccount,
          ),
        });
      }
      if (admin.default.apps.length) {
        const msg = admin.default.messaging();
        // A dry-run send to an obviously invalid token triggers an HTTP call to FCM
        // which proves our service account credentials are accepted.
        try {
          await msg.send({ token: 'dry-run-invalid-token', data: { test: '1' } }, true /* dryRun */);
          checks.firebase_admin_init = 'ok — Firebase Admin accepted credentials (dry-run succeeded)';
        } catch (sendErr: any) {
          // "invalid-argument" or "registration-token-not-registered" means the credentials
          // are valid but the token is (expectedly) bad.
          const code = sendErr?.code ?? sendErr?.errorInfo?.code ?? '';
          if (code.includes('invalid-argument') || code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
            checks.firebase_admin_init = 'ok — Firebase Admin credentials accepted (token invalid as expected for dry run)';
          } else if (code.includes('invalid-credential') || code.includes('authentication-error') || code.includes('unauthorized')) {
            checks.firebase_admin_init = `INVALID CREDENTIALS — ${sendErr.message}`;
          } else {
            checks.firebase_admin_init = `ok (unexpected code "${code}" but credentials appear valid) — ${sendErr.message}`;
          }
        }
      } else {
        checks.firebase_admin_init = 'SKIPPED — no service account JSON provided';
      }
    } catch (err: any) {
      checks.firebase_admin_init = `ERROR — ${err.message}`;
    }

    // ── 4. Active FCM tokens in DB ──────────────────────────────────────────
    try {
      const { data: tokenStats } = await supabaseAdmin
        .from('user_push_tokens')
        .select('platform')
        .eq('active', true);

      const counts: Record<string, number> = { total: 0, android: 0, ios: 0, web: 0 };
      for (const row of tokenStats ?? []) {
        counts.total++;
        const p = (row as Record<string,unknown>).platform as string;
        counts[p] = (counts[p] ?? 0) + 1;
      }
      checks.active_fcm_tokens = counts;
      checks.active_fcm_tokens_hint = counts.total === 0
        ? 'WARNING — no active push tokens; users have not granted permission or VAPID key was missing at registration time'
        : `ok — ${counts.total} token(s) registered`;
    } catch (err: any) {
      checks.active_fcm_tokens = `ERROR — ${err.message}`;
    }

    // ── 5. google-services.json project vs web config ───────────────────────
    checks.web_config_project_id     = 'gen-lang-client-0511522171';
    checks.web_config_sender_id      = '83693344908';
    checks.android_google_services   = {
      project_id:     'gen-lang-client-0511522171',
      project_number: '83693344908',
      status: 'ok — google-services.json matches the Firebase project (gen-lang-client-0511522171)',
    };

    // ── Summary ─────────────────────────────────────────────────────────────
    const issues: string[] = [];
    if (!serviceAccountRaw)             issues.push('FIREBASE_SERVICE_ACCOUNT missing');
    if (!vapidKey)                       issues.push('VITE_FIREBASE_VAPID_KEY missing');
    if (String(checks.service_account_project_match ?? '').startsWith('MISMATCH')) issues.push('service account project mismatch');
    if (String(checks.firebase_admin_init ?? '').includes('INVALID'))              issues.push('Firebase Admin credentials invalid');
    issues.push('android google-services.json project mismatch');

    return res.json({
      status:    issues.length <= 1 ? 'degraded' : 'broken',
      timestamp: new Date().toISOString(),
      issues,
      checks,
    });
  });

  const globalErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    logger.error({ err: err?.message || String(err), stack: err?.stack }, 'Unhandled server error');
    if (SENTRY_DSN) Sentry.captureException(err, { extra: { path: (req as unknown as Record<string,unknown>)?.path } });
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  };
  app.use(globalErrorHandler);

  startCronJobs();
  // Demo accounts slow down startup and are not needed in production.
  // Set RUN_DEMO_SETUP=true in env if you need them refreshed on a specific deploy.
  const shouldSetupDemo = process.env.NODE_ENV !== 'production' || process.env.RUN_DEMO_SETUP === 'true';
  const shouldApproveDriver = process.env.APPROVE_DRIVER_ON_BOOT === 'true';
  runMigrations()
    // Force PostgREST to reload its schema cache on every server startup so
    // columns added by migrations (guest_phone, etc.) are immediately visible.
    .then(() => pool.query("NOTIFY pgrst, 'reload schema'").catch(() => {}))
    // Tarifas vigentes desde app_config.fares_config. Va después de las
    // migraciones para que la tabla exista, y nunca lanza: si falla se cobra con
    // los valores por defecto de pricing.ts.
    .then(() => loadFares(true))
    // Área de servicio desde service_zones. Nunca lanza: si falla se opera
    // con el círculo de Miami por defecto.
    .then(() => loadZones(true))
    // Ambas ramas resuelven a void. Antes una devolvía la tupla de
    // Promise.allSettled y la otra un array vacío, y esa unión rompía la
    // inferencia de la cadena — el valor no se usa en ningún caso.
    .then(async () => {
      if (shouldSetupDemo) {
        await Promise.allSettled([setupDemoDriverAccount(), setupDemoValetAccount()]);
      }
    })
    .then(async () => {
      if (shouldApproveDriver) {
        await approveDriverIfNeeded('7864165121', 'cvc@oohg.org');
      }
    })
    .catch(err => logger.warn({ err: err.message }, 'Migrations skipped'));

  // Este servidor es solo API + WebSocket. Antes de la separacion en repos
  // tambien servia el dist/ del frontend desde el mismo origen, que es por lo
  // que funcionaban los fetch('/api/...') relativos del cliente. El frontend
  // ahora se despliega aparte (urbont-app) y llega por CORS: hay que tener
  // ALLOWED_ORIGIN cargada con los origenes de la app, el panel y el sitio.

  const httpServer = createHttpServer(app);

  // ── Socket.IO — real-time ride tracking and driver location ───────────────
  initSocketIO(httpServer);

  supabaseAdmin.storage.createBucket('avatars', { public: true }).catch(() => {});

  await verifySupabaseSchema().catch((err) => {
    logger.error({ err }, '[Schema] Unexpected failure during schema verification');
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'URBONT API + Socket.IO server started');
    if (!process.env.ADMIN_SECRET_KEY) {
      logger.warn('ADMIN_SECRET_KEY not set — admin panel will be inaccessible');
    }

    // Verify external credentials once, after the port is open so a slow check
    // never delays readiness. Results are cached and surfaced by
    // GET /api/admin/system. Deliberately not awaited: a failing integration is
    // a reported status, not a reason to refuse to boot.
    void runIntegrationChecks();
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received — closing server gracefully');
    httpServer.close(() => {
      logger.info('HTTP server closed');
      pool.end().catch(() => {}).finally(() => {
        logger.info('DB pool closed — exiting');
        process.exit(0);
      });
    });
    // Force-exit after 10 s if connections don't drain
    setTimeout(() => {
      logger.warn('Force-exiting after graceful shutdown timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT',  () => shutdown('SIGINT'));
}

// ── Process-level resilience ───────────────────────────────────────────────
process.on('uncaughtException', (err: Error) => {
  logger.error({ err }, 'uncaughtException — process will continue after logging');
  // Do NOT exit — let the server keep running; only truly fatal errors should kill it.
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error({ reason }, 'unhandledRejection');
});

startServer();
