import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { pool } from '../db/pool';
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
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT * FROM admin_users WHERE email = $1 AND active = true',
      [email.toLowerCase().trim()]
    );
    const row = rows[0];
    if (!row) {
        log.warn({ email }, 'Admin login: unknown email');
        recordAdminFail(clientIp);
        return res.status(401).json({ error: 'Invalid credentials.' });
      }
      const valid = await verifyPassword(password, row.password_hash);
      if (!valid) {
        log.warn({ email }, 'Admin login: wrong password');
        recordAdminFail(clientIp);
        return res.status(401).json({ error: 'Invalid credentials.' });
      }
    clearAdminFail(clientIp);
    await pool.query('UPDATE admin_users SET last_login = NOW() WHERE id = $1', [row.id]);
    const user: AdminUser = { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active };
    const token = signAdminToken(user);
    log.info({ email, role: user.role }, 'Admin login success');
    return res.json({ token, user });
  } catch (err: any) {
    log.error({ err: err.message }, 'Admin login error');
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
    const { rows } = await pool.query(
      'SELECT id, email, name, role, active, created_at, last_login FROM admin_users ORDER BY created_at ASC'
    );
    return res.json({ users: rows });
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
    const { rows } = await pool.query(
      `INSERT INTO admin_users (email, name, role, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, role, active, created_at`,
      [email.toLowerCase().trim(), name.trim(), role, hash]
    );
    log.info({ email, role }, 'Admin user created');
    return res.status(201).json({ user: rows[0] });
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use.' });
    log.error({ err: err.message }, 'Create admin user error');
    return res.status(500).json({ error: 'Failed to create user.' });
  }
});

// PATCH /api/admin/auth/users/:id — owner only
adminAuthRouter.patch('/users/:id', requireAdminJWT, requireOwner, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { role, active, password, name } = req.body as {
    role?: AdminRole; active?: boolean; password?: string; name?: string;
  };
  try {
    if (password !== undefined) {
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      const hash = await hashPassword(password);
      await pool.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [hash, id]);
    }
    if (name !== undefined) await pool.query('UPDATE admin_users SET name = $1 WHERE id = $2', [name.trim(), id]);
    if (role !== undefined) await pool.query('UPDATE admin_users SET role = $1 WHERE id = $2', [role, id]);
    if (active !== undefined) await pool.query('UPDATE admin_users SET active = $1 WHERE id = $2', [active, id]);
    const { rows } = await pool.query(
      'SELECT id, email, name, role, active, created_at, last_login FROM admin_users WHERE id = $1',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    log.info({ id, role, active }, 'Admin user updated');
    return res.json({ user: rows[0] });
  } catch (err: any) {
    log.error({ err: err.message }, 'Update admin user error');
    return res.status(500).json({ error: 'Failed to update user.' });
  }
});

// DELETE /api/admin/auth/users/:id — owner only
adminAuthRouter.delete('/users/:id', requireAdminJWT, requireOwner, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (req.adminUser?.id === id) {
    return res.status(400).json({ error: 'Cannot delete your own account.' });
  }
  try {
    await pool.query('DELETE FROM admin_users WHERE id = $1', [id]);
    log.info({ id }, 'Admin user deleted');
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
    const { rows } = await pool.query('SELECT password_hash FROM admin_users WHERE id = $1', [req.adminUser!.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    const valid = await verifyPassword(currentPassword, rows[0].password_hash);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect.' });
    const hash = await hashPassword(newPassword);
    await pool.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [hash, req.adminUser!.id]);
    log.info({ id: req.adminUser!.id }, 'Admin password reset');
    return res.json({ success: true });
  } catch (err: any) {
    log.error({ err: err.message }, 'Reset password error');
    return res.status(500).json({ error: 'Failed to reset password.' });
  }
});
