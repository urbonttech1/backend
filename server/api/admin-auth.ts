import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { supabaseAdmin } from '../db/client';
import { createContextLogger } from '../lib/logger';

  /* ── Admin login rate limiter (in-memory per IP) ── */
  const adminLoginAttempts = new Map<string, { count: number; lockedUntil: number }>();
  const MAX_ADMIN_ATTEMPTS = 5;
  const ADMIN_LOCKOUT_MS = 15 * 60 * 1000;

  function checkAdminRateLimit(req: Request, res: Response, next: () => void) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = adminLoginAttempts.get(ip);
    if (entry && entry.lockedUntil > now) {
      const mins = Math.ceil((entry.lockedUntil - now) / 60000);
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minute(s).` });
    }
    (req as Request & { _adminIp: string })._adminIp = ip;
    next();
  }
  function recordAdminFail(ip: string) {
    const now = Date.now();
    const entry = adminLoginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
    if (entry.lockedUntil > now) return;
    entry.count++;
    if (entry.count >= MAX_ADMIN_ATTEMPTS) entry.lockedUntil = now + ADMIN_LOCKOUT_MS;
    adminLoginAttempts.set(ip, entry);
  }
  function clearAdminFail(ip: string) { adminLoginAttempts.delete(ip); }

  // Periodically purge all stale entries: both expired lockouts AND entries that never
  // reached the lockout threshold (count > 0, lockedUntil = 0). Without this second
  // case, every unique IP that fails once but never gets locked will stay in the Map
  // indefinitely, causing unbounded memory growth.
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of adminLoginAttempts) {
      if (entry.lockedUntil < now) adminLoginAttempts.delete(ip);
    }
  }, 15 * 60 * 1000);

  
function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

const log = createContextLogger('ADMIN-AUTH');
const scryptAsync = promisify(scrypt);

const ADMIN_JWT_SECRET = (() => {
    const secret = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;
    if (!secret) {
      // No secret configured: generate an ephemeral random key so the server boots,
      // but all admin tokens are invalidated on every restart (forcing re-login).
      log.error({}, 'ADMIN_JWT_SECRET not set — generating ephemeral key; admin sessions will not survive restarts');
      return randomBytes(32).toString('hex');
    }
    return secret;
  })();

const TOKEN_EXPIRY = '8h';

export type AdminRole = 'owner' | 'developer' | 'support' | 'operations' | 'analyst';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  active: boolean;
}

declare global {
  namespace Express {
    interface Request {
      adminUser?: AdminUser;
    }
  }
}

// ── Password helpers ──────────────────────────────────────────────────────────

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  const keyBuf = Buffer.from(key, 'hex');
  return timingSafeEqual(derived, keyBuf);
}

// ── JWT helpers ───────────────────────────────────────────────────────────────

export function signAdminToken(user: AdminUser): string {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    ADMIN_JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

function verifyAdminToken(token: string): AdminUser | null {
  try {
    return jwt.verify(token, ADMIN_JWT_SECRET) as AdminUser;
  } catch {
    return null;
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────

export function requireAdminJWT(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Admin authentication required.' });
  const user = verifyAdminToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired admin session.' });
  req.adminUser = user;
  return next();
}

export function requireAdminRole(...roles: AdminRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.adminUser) return res.status(401).json({ error: 'Admin authentication required.' });
    if (!roles.includes(req.adminUser.role)) {
      return res.status(403).json({ error: `Access denied for role '${req.adminUser.role}'.` });
    }
    return next();
  };
}

const requireOwner = requireAdminRole('owner');

// ── Router ────────────────────────────────────────────────────────────────────

export const adminAuthRouter = Router();

// POST /api/admin/auth/login
adminAuthRouter.post('/login', checkAdminRateLimit, async (req: Request, res: Response) => {
  const clientIp = (req as Request & { _adminIp?: string })._adminIp || req.ip || 'unknown';
  const { email, password } = req.body as { email?: string; password?: string };
  log.info({ email, ip: clientIp }, '[admin-login] intento recibido');
  if (!email || !password) {
    log.warn({ email, ip: clientIp }, '[admin-login] rechazado: falta email o password en el body');
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  // ── Bypass de desarrollo ──────────────────────────────────────────────────
  // Solo para diagnosticar el panel local sin acceso a la DB de producción.
  // Nunca consulta admin_users — emite un JWT real, firmado con el mismo
  // ADMIN_JWT_SECRET/JWT_SECRET que usa requireAdminJWT, así que el resto del
  // panel lo acepta igual que a un login real. Doble candado, igual que el
  // bypass de OTP: NODE_ENV != production Y una variable explícita, ninguna
  // de las dos sola alcanza.
  if (process.env.NODE_ENV !== 'production' && process.env.ADMIN_DEV_BYPASS === 'true') {
    const devEmail    = process.env.ADMIN_DEV_EMAIL    || 'dev@urbont.local';
    const devPassword = process.env.ADMIN_DEV_PASSWORD || 'devbypass123';
    if (email.toLowerCase().trim() === devEmail && password === devPassword) {
      const user: AdminUser = {
        id: '00000000-0000-0000-0000-000000000000',
        email: devEmail, name: 'Dev Bypass', role: 'owner', active: true,
      };
      const token = signAdminToken(user);
      log.warn({ email: devEmail, ip: clientIp }, '[admin-login] DEV BYPASS usado — no se consultó admin_users');
      return res.json({ token, user });
    }
  }

  try {
    // Vía REST API (supabaseAdmin) en vez de pool.query directo — el pool
    // requiere SUPABASE_DB_URL (connection string de Postgres, no disponible
    // en este entorno). supabaseAdmin ya usa SUPABASE_SERVICE_ROLE_KEY, que sí
    // tenemos. Solo el login se movió; el resto de las rutas de este archivo
    // (CRUD de admin_users) sigue en pool.query — ver comentario 2026-08-28.
    const { data: row, error: selectErr } = await supabaseAdmin
      .from('admin_users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .eq('active', true)
      .maybeSingle();
    if (selectErr) throw selectErr;
    if (!row) {
        // Diagnóstico: distinguir "no existe ningún admin con ese email" de
        // "existe pero está inactivo" — la query de arriba no lo diferencia
        // a propósito (no filtrar por active en la respuesta al cliente),
        // pero acá sí nos sirve para saber qué está pasando.
        const { data: anyRow } = await supabaseAdmin
          .from('admin_users')
          .select('active')
          .eq('email', email.toLowerCase().trim())
          .maybeSingle();
        if (!anyRow) {
          log.warn({ email, ip: clientIp }, '[admin-login] FALLO: no existe ninguna fila en admin_users con ese email');
        } else {
          log.warn({ email, ip: clientIp, active: anyRow.active }, '[admin-login] FALLO: la fila existe pero active=false');
        }
        recordAdminFail(clientIp);
        return res.status(401).json({ error: 'Invalid credentials.' });
      }
      const valid = await verifyPassword(password, row.password_hash);
      if (!valid) {
        log.warn({ email, ip: clientIp, userId: row.id }, '[admin-login] FALLO: password no matchea el hash guardado');
        recordAdminFail(clientIp);
        return res.status(401).json({ error: 'Invalid credentials.' });
      }
      log.info({ email, ip: clientIp, userId: row.id }, '[admin-login] password OK, emitiendo token');
    clearAdminFail(clientIp);
    await supabaseAdmin.from('admin_users').update({ last_login: new Date().toISOString() }).eq('id', row.id);
    const user: AdminUser = { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active };
    const token = signAdminToken(user);
    log.info({ email, role: user.role }, 'Admin login success');
    return res.json({ token, user });
  } catch (err: any) {
    log.error({ err: err.message, email, ip: clientIp }, '[admin-login] EXCEPCIÓN: probable falla de conexión a la DB, no un problema de credenciales');
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// GET /api/admin/auth/me
adminAuthRouter.get('/me', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  const user = verifyAdminToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired session.' });
  return res.json({ user });
});

// GET /api/admin/auth/users — owner only
adminAuthRouter.get('/users', requireAdminJWT, requireOwner, async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('admin_users')
      .select('id, email, name, role, active, created_at, last_login')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return res.json({ users: data });
  } catch (err: any) {
    log.error({ err: err.message }, 'List admin users error');
    return res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// POST /api/admin/auth/users — owner only
adminAuthRouter.post('/users', requireAdminJWT, requireOwner, async (req: Request, res: Response) => {
  const { email, name, role, password } = req.body as {
    email?: string; name?: string; role?: AdminRole; password?: string;
  };
  if (!email || !name || !role || !password) {
    return res.status(400).json({ error: 'email, name, role, and password are required.' });
  }
  const validRoles: AdminRole[] = ['owner', 'developer', 'support', 'operations', 'analyst'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}.` });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  try {
    const hash = await hashPassword(password);
    const { data, error } = await supabaseAdmin
      .from('admin_users')
      .insert({ email: email.toLowerCase().trim(), name: name.trim(), role, password_hash: hash })
      .select('id, email, name, role, active, created_at')
      .single();
    if (error) throw error;
    log.info({ email, role }, 'Admin user created');
    return res.status(201).json({ user: data });
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use.' });
    log.error({ err: err.message }, 'Create admin user error');
    return res.status(500).json({ error: 'Failed to create user.' });
  }
});

/**
 * Cuenta los owners activos, excluyendo opcionalmente a uno.
 *
 * Sirve para no quedarse sin ningún owner: si eso ocurre, nadie puede volver a
 * crear ni editar usuarios del panel y hay que arreglarlo a mano en la base.
 */
async function ownersActivosRestantes(excluyendoId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('admin_users')
    .select('id')
    .eq('role', 'owner')
    .eq('active', true)
    .neq('id', excluyendoId);
  if (error) throw error;
  return (data ?? []).length;
}

// PATCH /api/admin/auth/users/:id — owner only
adminAuthRouter.patch('/users/:id', requireAdminJWT, requireOwner, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { role, active, password, name } = req.body as {
    role?: AdminRole; active?: boolean; password?: string; name?: string;
  };

  const esUnoMismo = req.adminUser?.id === id;

  // El DELETE ya impedía borrarse a uno mismo, pero el PATCH no tenía ninguna
  // protección equivalente: un owner podía degradarse el rol o desactivarse y
  // perder el acceso a la gestión de usuarios sin forma de recuperarlo desde el
  // panel. Cambiarse el nombre o la contraseña sí sigue permitido.
  if (esUnoMismo && role !== undefined && role !== 'owner') {
    return res.status(400).json({
      error: 'No puedes cambiar tu propio rol. Pídeselo a otro owner.',
      errorCode: 'CANNOT_DEMOTE_SELF',
    });
  }
  if (esUnoMismo && active === false) {
    return res.status(400).json({
      error: 'No puedes desactivar tu propia cuenta.',
      errorCode: 'CANNOT_DEACTIVATE_SELF',
    });
  }

  try {
    const validRoles: AdminRole[] = ['owner', 'developer', 'support', 'operations', 'analyst'];
    if (role !== undefined && !validRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}.` });
    }

    // Degradar o desactivar al último owner activo deja el panel sin nadie que
    // pueda administrarlo.
    const dejaDeSerOwnerActivo = (role !== undefined && role !== 'owner') || active === false;
    if (dejaDeSerOwnerActivo) {
      const { data: objetivo } = await supabaseAdmin
        .from('admin_users')
        .select('role, active')
        .eq('id', id)
        .maybeSingle();

      if (objetivo?.role === 'owner' && objetivo?.active === true) {
        if (await ownersActivosRestantes(id) === 0) {
          return res.status(409).json({
            error: 'Es el último owner activo. Asigna otro owner antes de cambiarlo.',
            errorCode: 'LAST_OWNER',
          });
        }
      }
    }

    const updates: Record<string, unknown> = {};
    if (password !== undefined) {
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      updates.password_hash = await hashPassword(password);
    }
    if (name !== undefined) updates.name = name.trim();
    if (role !== undefined) updates.role = role;
    if (active !== undefined) updates.active = active;
    if (Object.keys(updates).length > 0) {
      const { error: updateErr } = await supabaseAdmin.from('admin_users').update(updates).eq('id', id);
      if (updateErr) throw updateErr;
    }
    const { data, error } = await supabaseAdmin
      .from('admin_users')
      .select('id, email, name, role, active, created_at, last_login')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'User not found.' });
    log.info({ id, role, active }, 'Admin user updated');
    return res.json({ user: data });
  } catch (err: any) {
    log.error({ err: err.message }, 'Update admin user error');
    return res.status(500).json({ error: 'Failed to update user.' });
  }
});

// DELETE /api/admin/auth/users/:id — owner only
adminAuthRouter.delete('/users/:id', requireAdminJWT, requireOwner, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (req.adminUser?.id === id) {
    return res.status(400).json({
      error: 'No puedes borrar tu propia cuenta.',
      errorCode: 'CANNOT_DELETE_SELF',
    });
  }
  try {
    const { data: objetivo } = await supabaseAdmin
      .from('admin_users')
      .select('email, role, active')
      .eq('id', id)
      .maybeSingle();
    if (!objetivo) return res.status(404).json({ error: 'User not found.' });

    // Mismo criterio que el PATCH: borrar al último owner activo deja el panel
    // sin quien lo administre.
    if (objetivo.role === 'owner' && objetivo.active === true) {
      if (await ownersActivosRestantes(id) === 0) {
        return res.status(409).json({
          error: 'Es el último owner activo. Asigna otro owner antes de borrarlo.',
          errorCode: 'LAST_OWNER',
        });
      }
    }

    const { error } = await supabaseAdmin.from('admin_users').delete().eq('id', id);
    if (error) throw error;
    log.info({ id, email: objetivo.email, role: objetivo.role, by: req.adminUser?.id }, 'Admin user deleted');
    return res.json({ success: true });
  } catch (err: any) {
    log.error({ err: err.message }, 'Delete admin user error');
    return res.status(500).json({ error: 'Failed to delete user.' });
  }
});


  // POST /api/admin/auth/logout
  adminAuthRouter.post('/logout', (_req: Request, res: Response) => {
    // Tokens are stateless JWTs — client simply discards the token
    return res.json({ success: true });
  });
  
// POST /api/admin/auth/reset-password — owner resets own password
adminAuthRouter.post('/reset-password', requireAdminJWT, async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  try {
    const { data: row, error: selectErr } = await supabaseAdmin
      .from('admin_users')
      .select('password_hash')
      .eq('id', req.adminUser!.id)
      .maybeSingle();
    if (selectErr) throw selectErr;
    if (!row) return res.status(404).json({ error: 'User not found.' });
    const valid = await verifyPassword(currentPassword, row.password_hash);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect.' });
    const hash = await hashPassword(newPassword);
    const { error: updateErr } = await supabaseAdmin
      .from('admin_users')
      .update({ password_hash: hash })
      .eq('id', req.adminUser!.id);
    if (updateErr) throw updateErr;
    log.info({ id: req.adminUser!.id }, 'Admin password reset');
    return res.json({ success: true });
  } catch (err: any) {
    log.error({ err: err.message }, 'Reset password error');
    return res.status(500).json({ error: 'Failed to reset password.' });
  }
});
