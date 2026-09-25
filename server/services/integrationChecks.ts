// ── Startup verification of external credentials ──────────────────────────────
// Some integrations cannot be checked on every dashboard poll: the admin panel
// refreshes every 15 s, and a Google Maps call is billed per request — verifying
// there would cost more than the entire infrastructure.
//
// So they are verified once, when the server boots, and the result is cached
// with its timestamp. That is the moment a broken credential actually matters:
// it catches the problem at deploy instead of weeks later.
//
// The alternative — reporting "configured" because the environment variable has
// a value — is what let a corrupted Firebase key look healthy for days while
// Google rejected every request made with it.
//
// Each check returns enough structured detail for the panel to show what was
// actually validated on hover, not just a green dot.
//
// Cheap, local checks (database, Supabase, Redis) stay live in the endpoint.

import crypto from 'crypto';
import { createContextLogger } from '../lib/logger';
import { claveDeServidor } from './mapsKeys';

const log = createContextLogger('CHECKS');

export type CheckStatus = 'connected' | 'disconnected' | 'not_configured' | 'pending';

/** One labelled row of the hover detail. */
export interface DetailRow {
  label: string;
  value: string;
}

export interface CheckResult {
  status: CheckStatus;
  /** ISO timestamp of the verification, or null if never run. */
  verifiedAt: string | null;
  /** One line for the card itself. */
  summary?: string;
  /** Which call was made, so the panel can say how it was verified. */
  probe?: string;
  /** Round trip of the verification, in milliseconds. */
  latencyMs?: number;
  /** Rows for the hover panel. */
  details?: DetailRow[];
}

export type Integration = 'stripe' | 'google_maps' | 'firebase' | 'twilio' | 'email';

const results: Record<Integration, CheckResult> = {
  stripe:      { status: 'pending', verifiedAt: null },
  google_maps: { status: 'pending', verifiedAt: null },
  firebase:    { status: 'pending', verifiedAt: null },
  twilio:      { status: 'pending', verifiedAt: null },
  email:       { status: 'pending', verifiedAt: null },
};

const TIMEOUT_MS = 8000;
const now = () => new Date().toISOString();
const si = (b: unknown) => (b ? 'Sí' : 'No');

function notConfigured(probe: string): CheckResult {
  return { status: 'not_configured', verifiedAt: now(), probe, summary: 'Sin credencial' };
}

// ── Individual checks ─────────────────────────────────────────────────────────

/**
 * Reads the account. Free and read-only, and richer than the balance endpoint:
 * `charges_enabled` reveals an account whose credentials work but that cannot
 * actually take a payment — a failure no credential check would surface.
 */
async function checkStripe(): Promise<CheckResult> {
  const probe = 'GET https://api.stripe.com/v1/account';
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return notConfigured(probe);

  const t0 = Date.now();
  try {
    const r = await fetch('https://api.stripe.com/v1/account', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const latencyMs = Date.now() - t0;
    const b = await r.json() as {
      id?: string; country?: string; default_currency?: string;
      charges_enabled?: boolean; payouts_enabled?: boolean;
      business_profile?: { name?: string };
      error?: { message?: string; type?: string };
    };

    if (!r.ok) {
      return {
        status: 'disconnected', verifiedAt: now(), probe, latencyMs,
        summary: b.error?.message?.slice(0, 90) ?? `HTTP ${r.status}`,
        details: [
          { label: 'Respuesta', value: `HTTP ${r.status}` },
          { label: 'Error', value: b.error?.message ?? 'sin mensaje' },
          { label: 'Tipo', value: b.error?.type ?? '—' },
        ],
      };
    }

    const live = key.startsWith('sk_live_');
    const details: DetailRow[] = [
      { label: 'Cuenta',   value: b.business_profile?.name || b.id || '—' },
      { label: 'ID',       value: b.id ?? '—' },
      { label: 'Modo',     value: live ? 'Producción (live)' : 'Pruebas (test)' },
      { label: 'País',     value: (b.country ?? '—').toUpperCase() },
      { label: 'Moneda',   value: (b.default_currency ?? '—').toUpperCase() },
      { label: 'Cobros habilitados', value: si(b.charges_enabled) },
      { label: 'Pagos habilitados',  value: si(b.payouts_enabled) },
      { label: 'Respuesta', value: `HTTP 200 · ${latencyMs} ms` },
    ];

    // Credentials fine but the account cannot charge: payments are down.
    if (!b.charges_enabled) {
      return {
        status: 'disconnected', verifiedAt: now(), probe, latencyMs, details,
        summary: 'Credenciales válidas pero la cuenta NO puede cobrar',
      };
    }

    return {
      status: 'connected', verifiedAt: now(), probe, latencyMs, details,
      summary: live ? 'Cobros habilitados · producción' : 'Cobros habilitados · pruebas',
    };
  } catch (err) {
    return {
      status: 'disconnected', verifiedAt: now(), probe, latencyMs: Date.now() - t0,
      summary: err instanceof Error ? err.message.slice(0, 90) : String(err),
    };
  }
}

/**
 * One geocoding request. Billed (~$0.005), which is why this runs at startup
 * only. Only Geocoding is exercised; Directions and Places share the same key
 * but are not called here to avoid multiplying the cost.
 */
async function checkGoogleMaps(): Promise<CheckResult> {
  const probe = 'GET https://maps.googleapis.com/maps/api/geocode/json';
  const key = claveDeServidor(process.env);
  if (!key) return notConfigured(probe);

  const t0 = Date.now();
  try {
    const r = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=Miami&key=${key}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const latencyMs = Date.now() - t0;
    const b = await r.json() as {
      status?: string; error_message?: string;
      results?: Array<{ formatted_address?: string }>;
    };

    const base: DetailRow[] = [
      { label: 'API probada', value: 'Geocoding' },
      { label: 'Consulta',    value: 'address=Miami' },
      { label: 'Estado',      value: b.status ?? '—' },
      { label: 'Respuesta',   value: `HTTP ${r.status} · ${latencyMs} ms` },
    ];

    if (b.status !== 'OK') {
      return {
        status: 'disconnected', verifiedAt: now(), probe, latencyMs,
        summary: b.error_message?.slice(0, 90) ?? b.status ?? 'respuesta inesperada',
        details: [...base, { label: 'Mensaje', value: b.error_message ?? 'sin mensaje' }],
      };
    }

    return {
      status: 'connected', verifiedAt: now(), probe, latencyMs,
      summary: 'Geocoding responde correctamente',
      details: [
        ...base,
        { label: 'Resultado', value: b.results?.[0]?.formatted_address ?? '—' },
        { label: 'Nota', value: 'Directions y Places usan la misma clave, no se prueban aparte' },
      ],
    };
  } catch (err) {
    return {
      status: 'disconnected', verifiedAt: now(), probe, latencyMs: Date.now() - t0,
      summary: err instanceof Error ? err.message.slice(0, 90) : String(err),
    };
  }
}

/**
 * Signs a JWT with the service account key and exchanges it for an access
 * token. This is the check that distinguishes a well-formed JSON from a working
 * credential — a key can parse perfectly and still be rejected by Google.
 */
async function checkFirebase(): Promise<CheckResult> {
  const probe = 'POST https://oauth2.googleapis.com/token (JWT bearer)';
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return notConfigured(probe);

  let sa: { client_email?: string; private_key?: string; project_id?: string; private_key_id?: string };
  try {
    sa = JSON.parse(raw);
  } catch {
    return {
      status: 'disconnected', verifiedAt: now(), probe,
      summary: 'FIREBASE_SERVICE_ACCOUNT no es JSON válido',
      details: [{ label: 'Error', value: 'El contenido de la variable no se puede interpretar como JSON' }],
    };
  }

  const ident: DetailRow[] = [
    { label: 'Proyecto',          value: sa.project_id ?? '—' },
    { label: 'Cuenta de servicio', value: sa.client_email ?? '—' },
    { label: 'ID de clave',       value: sa.private_key_id?.slice(0, 12) + '…' },
  ];

  if (!sa.client_email || !sa.private_key) {
    return {
      status: 'disconnected', verifiedAt: now(), probe, details: ident,
      summary: 'Falta client_email o private_key en el JSON',
    };
  }

  const t0 = Date.now();
  try {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const iat = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'RS256', typ: 'JWT' });
    const payload = b64({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat, exp: iat + 3600,
    });
    const signature = crypto
      .sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), sa.private_key)
      .toString('base64url');

    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${payload}.${signature}`,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const latencyMs = Date.now() - t0;
    const b = await r.json() as {
      access_token?: string; expires_in?: number; error?: string; error_description?: string;
    };

    if (!b.access_token) {
      return {
        status: 'disconnected', verifiedAt: now(), probe, latencyMs,
        summary: `${b.error ?? 'rechazado'}: ${b.error_description ?? ''}`.trim().slice(0, 90),
        details: [
          ...ident,
          { label: 'Respuesta', value: `HTTP ${r.status} · ${latencyMs} ms` },
          { label: 'Error',     value: b.error ?? '—' },
          { label: 'Detalle',   value: b.error_description ?? 'sin descripción' },
        ],
      };
    }

    return {
      status: 'connected', verifiedAt: now(), probe, latencyMs,
      summary: `Credencial aceptada · proyecto ${sa.project_id ?? '—'}`,
      details: [
        ...ident,
        { label: 'Token',     value: `emitido, vence en ${Math.round((b.expires_in ?? 0) / 60)} min` },
        { label: 'Alcance',   value: 'firebase.messaging' },
        { label: 'Respuesta', value: `HTTP 200 · ${latencyMs} ms` },
      ],
    };
  } catch (err) {
    return {
      status: 'disconnected', verifiedAt: now(), probe, latencyMs: Date.now() - t0, details: ident,
      summary: err instanceof Error ? err.message.slice(0, 90) : String(err),
    };
  }
}

/**
 * Two read-only calls, both free: the account itself, then whether the number in
 * TWILIO_PHONE_NUMBER is actually owned by that account and can send SMS.
 *
 * The second call catches a class of failure that checking credentials alone
 * never would — a valid account paired with a number it does not own, or one
 * without SMS enabled. Both fail only when someone needs a verification code.
 */
async function checkTwilio(): Promise<CheckResult> {
  const probe = 'GET /2010-04-01/Accounts/{sid} + /IncomingPhoneNumbers';
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token) return notConfigured(probe);

  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
  const t0 = Date.now();

  try {
    const acc = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const a = await acc.json() as {
      status?: string; type?: string; friendly_name?: string; message?: string;
    };

    if (!acc.ok) {
      return {
        status: 'disconnected', verifiedAt: now(), probe, latencyMs: Date.now() - t0,
        summary: a.message?.slice(0, 90) ?? `HTTP ${acc.status}`,
        details: [
          { label: 'Respuesta', value: `HTTP ${acc.status}` },
          { label: 'Error',     value: a.message ?? 'credenciales rechazadas' },
        ],
      };
    }

    // A trial account passes every credential check and still cannot message
    // anyone who has not been verified in the Twilio console.
    const esTrial = a.type === 'Trial';
    const base: DetailRow[] = [
      { label: 'Cuenta', value: a.friendly_name ?? '—' },
      { label: 'SID',    value: sid.slice(0, 10) + '…' },
      { label: 'Estado', value: a.status ?? '—' },
      { label: 'Tipo',   value: esTrial ? 'Trial — solo envía a números verificados' : 'Full' },
    ];

    if (a.status !== 'active') {
      return {
        status: 'disconnected', verifiedAt: now(), probe, latencyMs: Date.now() - t0,
        summary: `Cuenta ${a.status}`, details: base,
      };
    }

    if (!from) {
      return {
        status: 'disconnected', verifiedAt: now(), probe, latencyMs: Date.now() - t0,
        summary: 'TWILIO_PHONE_NUMBER sin definir',
        details: [...base, { label: 'Número', value: 'no configurado' }],
      };
    }

    const nums = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(from)}`,
      { headers: { Authorization: auth }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const latencyMs = Date.now() - t0;
    const n = await nums.json() as {
      incoming_phone_numbers?: Array<{
        phone_number?: string; friendly_name?: string;
        capabilities?: { sms?: boolean; voice?: boolean; mms?: boolean };
      }>;
    };
    const match = n.incoming_phone_numbers?.[0];

    if (!match) {
      return {
        status: 'disconnected', verifiedAt: now(), probe, latencyMs,
        summary: `${from} no pertenece a esta cuenta`,
        details: [...base, { label: 'Número', value: `${from} — no encontrado en la cuenta` }],
      };
    }

    const details: DetailRow[] = [
      ...base,
      { label: 'Número',    value: match.phone_number ?? from },
      { label: 'SMS',       value: si(match.capabilities?.sms) },
      { label: 'Voz',       value: si(match.capabilities?.voice) },
      { label: 'Respuesta', value: `HTTP 200 · ${latencyMs} ms` },
    ];

    if (!match.capabilities?.sms) {
      return {
        status: 'disconnected', verifiedAt: now(), probe, latencyMs, details,
        summary: `${from} no tiene SMS habilitado`,
      };
    }

    return {
      status: 'connected', verifiedAt: now(), probe, latencyMs, details,
      summary: esTrial
        ? `Trial · ${match.phone_number} — solo a números verificados`
        : `Cuenta activa · ${match.phone_number}`,
    };
  } catch (err) {
    return {
      status: 'disconnected', verifiedAt: now(), probe, latencyMs: Date.now() - t0,
      summary: err instanceof Error ? err.message.slice(0, 90) : String(err),
    };
  }
}

/**
 * Verifies whichever email provider is active, without sending anything.
 *
 * Knowing which provider would handle the next send is not the same as knowing
 * it can send: a revoked SendGrid key, or one issued without the `mail.send`
 * permission, looks identical from the environment variable alone.
 */
async function checkEmail(): Promise<CheckResult> {
  const from = process.env.EMAIL_FROM || '(sin remitente)';
  const t0 = Date.now();

  // ── SendGrid ──
  const sg = process.env.SENDGRID_API_KEY;
  if (sg) {
    const probe = 'GET https://api.sendgrid.com/v3/scopes';
    try {
      const r = await fetch('https://api.sendgrid.com/v3/scopes', {
        headers: { Authorization: `Bearer ${sg}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const latencyMs = Date.now() - t0;
      const b = await r.json() as { scopes?: string[]; errors?: Array<{ message?: string }> };

      if (!r.ok) {
        return {
          status: 'disconnected', verifiedAt: now(), probe, latencyMs,
          summary: b.errors?.[0]?.message?.slice(0, 90) ?? `HTTP ${r.status}`,
          details: [
            { label: 'Proveedor', value: 'SendGrid' },
            { label: 'Respuesta', value: `HTTP ${r.status}` },
            { label: 'Error',     value: b.errors?.[0]?.message ?? 'clave rechazada' },
          ],
        };
      }

      const scopes = b.scopes ?? [];
      const puedeEnviar = scopes.includes('mail.send');
      const details: DetailRow[] = [
        { label: 'Proveedor',       value: 'SendGrid' },
        { label: 'Remitente',       value: from },
        { label: 'Permiso de envío', value: si(puedeEnviar) },
        { label: 'Permisos',        value: scopes.join(', ') || '—' },
        { label: 'Respuesta',       value: `HTTP 200 · ${latencyMs} ms` },
      ];

      // A valid key without mail.send authenticates fine and cannot send.
      if (!puedeEnviar) {
        return {
          status: 'disconnected', verifiedAt: now(), probe, latencyMs, details,
          summary: 'La clave es válida pero NO tiene permiso de envío',
        };
      }

      return {
        status: 'connected', verifiedAt: now(), probe, latencyMs, details,
        summary: `SendGrid · envía desde ${from}`,
      };
    } catch (err) {
      return {
        status: 'disconnected', verifiedAt: now(), probe, latencyMs: Date.now() - t0,
        summary: err instanceof Error ? err.message.slice(0, 90) : String(err),
        details: [{ label: 'Proveedor', value: 'SendGrid' }],
      };
    }
  }

  // ── Resend ──
  const resend = process.env.RESEND_API_KEY;
  if (resend) {
    const probe = 'GET https://api.resend.com/domains';
    try {
      const r = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${resend}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const latencyMs = Date.now() - t0;
      const details: DetailRow[] = [
        { label: 'Proveedor', value: 'Resend' },
        { label: 'Remitente', value: from },
        { label: 'Respuesta', value: `HTTP ${r.status} · ${latencyMs} ms` },
      ];
      return r.ok
        ? { status: 'connected', verifiedAt: now(), probe, latencyMs, details,
            summary: `Resend · envía desde ${from}` }
        : { status: 'disconnected', verifiedAt: now(), probe, latencyMs, details,
            summary: `Clave rechazada (HTTP ${r.status})` };
    } catch (err) {
      return {
        status: 'disconnected', verifiedAt: now(), probe, latencyMs: Date.now() - t0,
        summary: err instanceof Error ? err.message.slice(0, 90) : String(err),
      };
    }
  }

  // ── SMTP ──
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (host && user && pass) {
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const probe = `SMTP verify ${host}:${port}`;
    try {
      const nodemailer = await import('nodemailer');
      const tx = nodemailer.default.createTransport({
        host, port, secure: port === 465, auth: { user, pass },
        connectionTimeout: TIMEOUT_MS,
      });
      await tx.verify();       // opens the connection and authenticates, sends nothing
      const latencyMs = Date.now() - t0;
      return {
        status: 'connected', verifiedAt: now(), probe, latencyMs,
        summary: `SMTP · envía desde ${from}`,
        details: [
          { label: 'Proveedor', value: `SMTP (${host})` },
          { label: 'Puerto',    value: String(port) },
          { label: 'Usuario',   value: user },
          { label: 'Remitente', value: from },
          { label: 'Conexión',  value: `autenticada · ${latencyMs} ms` },
        ],
      };
    } catch (err) {
      return {
        status: 'disconnected', verifiedAt: now(), probe, latencyMs: Date.now() - t0,
        summary: err instanceof Error ? err.message.slice(0, 90) : String(err),
        details: [
          { label: 'Proveedor', value: `SMTP (${host})` },
          { label: 'Puerto',    value: String(port) },
        ],
      };
    }
  }

  return notConfigured('SendGrid / Resend / SMTP');
}

// ── Live checks ───────────────────────────────────────────────────────────────
// These run on every request: they are local, free and their state is current
// by definition, so nothing is cached. They return the same shape as the
// startup checks so the panel can render every card with one component.

/** Postgres server version. Read once — it does not change while we run. */
let pgVersion: string | null = null;

/**
 * Direct Postgres connection, through the pooler. Distinct from the Supabase
 * REST check below: both reach the same database by different roads and can
 * fail independently.
 */
export async function checkDatabase(): Promise<CheckResult> {
  const probe = 'SELECT 1 · conexión Postgres directa';
  const t0 = Date.now();
  try {
    const { pool } = await import('../db/pool');
    await pool.query('SELECT 1');

    if (!pgVersion) {
      try {
        const v = await pool.query<{ version: string }>('SELECT version()');
        pgVersion = v.rows[0]?.version?.split(' ').slice(0, 2).join(' ') ?? null;
      } catch { /* version is a nicety, not worth failing over */ }
    }

    const latencyMs = Date.now() - t0;
    const host = process.env.SUPABASE_DB_URL
      ? new URL(process.env.SUPABASE_DB_URL).hostname
      : '—';

    const details: DetailRow[] = [
      { label: 'Proveedor',  value: 'Supabase' },
      { label: 'Acceso',     value: 'Conexión Postgres directa (pooler)' },
      { label: 'Servidor',   value: host },
      { label: 'Motor',      value: pgVersion ?? '—' },
      { label: 'Conexiones', value: `${pool.totalCount} abiertas · ${pool.idleCount} libres` },
      { label: 'En cola',    value: String(pool.waitingCount) },
      { label: 'Respuesta',  value: `${latencyMs} ms` },
    ];

    // The pool is capped at 5. Anything queued means requests are already
    // waiting for a free connection.
    if (pool.waitingCount > 0) {
      return {
        status: 'connected', verifiedAt: now(), probe, latencyMs, details,
        summary: `Responde, pero hay ${pool.waitingCount} consultas en cola`,
      };
    }

    return {
      status: 'connected', verifiedAt: now(), probe, latencyMs, details,
      summary: 'Conexión directa activa',
    };
  } catch (err) {
    return {
      status: 'disconnected', verifiedAt: now(), probe, latencyMs: Date.now() - t0,
      summary: err instanceof Error ? err.message.slice(0, 90) : String(err),
      details: [
        { label: 'Proveedor', value: 'Supabase' },
        { label: 'Acceso',    value: 'Conexión Postgres directa (pooler)' },
        { label: 'Error',     value: err instanceof Error ? err.message : String(err) },
      ],
    };
  }
}

/** Supabase REST API (PostgREST). The path two thirds of the queries take. */
export async function checkSupabase(): Promise<CheckResult> {
  const probe = 'GET /rest/v1/profiles?select=id&limit=1';
  const t0 = Date.now();
  const url = process.env.SUPABASE_URL;
  const ref = url ? new URL(url).hostname.split('.')[0] : '—';

  try {
    const { supabaseAdmin } = await import('../db/client');
    const r = await supabaseAdmin.from('profiles').select('id').limit(1);
    const latencyMs = Date.now() - t0;

    const details: DetailRow[] = [
      { label: 'Proveedor', value: 'Supabase' },
      { label: 'Acceso',    value: 'API REST (PostgREST)' },
      { label: 'Proyecto',  value: ref },
      { label: 'Consulta',  value: 'profiles · 1 fila' },
      { label: 'Respuesta', value: `${latencyMs} ms` },
    ];

    if (r.error) {
      return {
        status: 'disconnected', verifiedAt: now(), probe, latencyMs,
        summary: r.error.message.slice(0, 90),
        details: [...details, { label: 'Error', value: r.error.message }],
      };
    }

    return {
      status: 'connected', verifiedAt: now(), probe, latencyMs, details,
      summary: 'API de datos activa',
    };
  } catch (err) {
    return {
      status: 'disconnected', verifiedAt: now(), probe, latencyMs: Date.now() - t0,
      summary: err instanceof Error ? err.message.slice(0, 90) : String(err),
    };
  }
}

/** Socket.IO Redis adapter — only meaningful once more than one container runs. */
export async function checkRedis(): Promise<CheckResult> {
  const probe = 'Adaptador Redis de Socket.IO';
  const url = process.env.REDIS_URL;

  if (!url) {
    return {
      status: 'not_configured', verifiedAt: now(), probe,
      summary: 'Sin configurar — no hace falta con un solo contenedor',
      details: [
        { label: 'Estado',    value: 'REDIS_URL sin definir' },
        { label: 'Adaptador', value: 'En memoria (una sola instancia)' },
        { label: 'Cuándo hace falta', value: 'Al correr dos o más contenedores' },
      ],
    };
  }

  const { isRedisAdapterReady } = await import('./socketService');
  const listo = isRedisAdapterReady();
  const host = (() => { try { return new URL(url).hostname; } catch { return '—'; } })();

  const details: DetailRow[] = [
    { label: 'Servidor',  value: host },
    { label: 'Adaptador', value: listo ? 'Activo — instancias sincronizadas' : 'No conectado, usando memoria' },
  ];

  return listo
    ? { status: 'connected', verifiedAt: now(), probe, details, summary: 'Adaptador activo' }
    : { status: 'disconnected', verifiedAt: now(), probe, details,
        summary: 'REDIS_URL definida pero el adaptador no conectó' };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Verifies every integration and caches the outcome.
 * Never throws: a failing check is a reported status, not a startup error.
 */
export async function runIntegrationChecks(): Promise<void> {
  const fallback = (e: unknown): CheckResult => ({
    status: 'disconnected', verifiedAt: now(), summary: String(e).slice(0, 90),
  });

  const [stripe, maps, firebase, twilio, email] = await Promise.all([
    checkStripe().catch(fallback),
    checkGoogleMaps().catch(fallback),
    checkFirebase().catch(fallback),
    checkTwilio().catch(fallback),
    checkEmail().catch(fallback),
  ]);

  results.stripe = stripe;
  results.google_maps = maps;
  results.firebase = firebase;
  results.twilio = twilio;
  results.email = email;

  for (const [name, r] of Object.entries(results)) {
    const line = { integration: name, status: r.status, summary: r.summary, latencyMs: r.latencyMs };
    if (r.status === 'disconnected') log.error(line, 'Integration check FAILED');
    else if (r.status === 'connected') log.info(line, 'Integration verified');
    else log.warn(line, 'Integration not configured');
  }
}

export function getIntegrationChecks(): Record<Integration, CheckResult> {
  return { ...results };
}
