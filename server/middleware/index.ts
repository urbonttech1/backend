import { Request, Response, NextFunction } from "express";
import { logger } from '../lib/logger';
import crypto from "crypto";
import { verifySupabaseToken } from "../db/client";

declare global {
  namespace Express {
    interface Request {
      supabaseUid?: string;
      supabaseRole?: string;
    }
  }
}

const rateLimitStore: Map<string, number[]> = new Map();
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW = 60 * 1000;

const strictRateLimitStore: Map<string, number[]> = new Map();
const STRICT_RATE_LIMIT_MAX = 5;
const STRICT_RATE_LIMIT_WINDOW = 60 * 1000;

const otpAttemptStore: Map<string, { count: number; lockedUntil: number }> = new Map();
const OTP_MAX_ATTEMPTS = 5;
const OTP_LOCKOUT_WINDOW = 15 * 60 * 1000;

// FIX: Periodically purge expired entries from all in-memory rate-limit stores to prevent
// unbounded memory growth. Without this, each unique IP address accumulates permanently —
// a high-traffic server or DDoS burst can exhaust process memory over hours/days.
setInterval(() => {
  const now = Date.now();

  for (const [ip, timestamps] of rateLimitStore) {
    const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);
    if (recent.length === 0) rateLimitStore.delete(ip);
    else rateLimitStore.set(ip, recent);
  }

  for (const [ip, timestamps] of strictRateLimitStore) {
    const recent = timestamps.filter(t => now - t < STRICT_RATE_LIMIT_WINDOW);
    if (recent.length === 0) strictRateLimitStore.delete(ip);
    else strictRateLimitStore.set(ip, recent);
  }

  for (const [ip, entry] of otpAttemptStore) {
    if (entry.lockedUntil > 0 && now > entry.lockedUntil && entry.count === 0) {
      otpAttemptStore.delete(ip);
    }
  }
}, 5 * 60 * 1000); // Run every 5 minutes

export function rateLimiter(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const timestamps = rateLimitStore.get(ip) || [];
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW);

  if (recent.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Too many requests. Please try again later." });
  }

  recent.push(now);
  rateLimitStore.set(ip, recent);
  next();
}

export function strictRateLimiter(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const timestamps = strictRateLimitStore.get(ip) || [];
  const recent = timestamps.filter(t => now - t < STRICT_RATE_LIMIT_WINDOW);

  if (recent.length >= STRICT_RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Rate limit exceeded. Please wait before trying again.", retryAfter: 60 });
  }

  recent.push(now);
  strictRateLimitStore.set(ip, recent);
  next();
}

export function otpRateLimiter(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = otpAttemptStore.get(ip);

  if (entry) {
    if (now < entry.lockedUntil) {
      const remainingMs = entry.lockedUntil - now;
      const remainingMin = Math.ceil(remainingMs / 60000);
      return res.status(429).json({
        error: `Too many failed attempts. Account locked for ${remainingMin} more minute(s).`,
        lockedUntil: entry.lockedUntil,
      });
    }
    if (entry.count >= OTP_MAX_ATTEMPTS && now > entry.lockedUntil) {
      otpAttemptStore.set(ip, { count: 0, lockedUntil: 0 });
    }
  }

  next();
}

export function recordOtpFailure(ip: string) {
  const now = Date.now();
  const entry = otpAttemptStore.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= OTP_MAX_ATTEMPTS) {
    entry.lockedUntil = now + OTP_LOCKOUT_WINDOW;
  }
  otpAttemptStore.set(ip, entry);
}

export function validateBody(fields: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const missing = fields.filter(f => req.body[f] === undefined || req.body[f] === null || req.body[f] === '');
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    next();
  };
}

export function sanitizeBody(req: Request, _res: Response, next: NextFunction) {
  function sanitizeValue(val: unknown): unknown {
    if (typeof val === 'string') {
      return val.trim().substring(0, 10000);
    }
    if (Array.isArray(val)) {
      return val.slice(0, 100).map(sanitizeValue);
    }
    if (val !== null && typeof val === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (typeof k === 'string' && k.length <= 100) {
          sanitized[k] = sanitizeValue(v);
        }
      }
      return sanitized;
    }
    return val;
  }

  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }
  next();
}

/**
 * @deprecated Use requireSupabaseAuth instead. This only checks that a token
 * exists — it does NOT verify the JWT signature. Migrate all routes to
 * requireSupabaseAuth.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  logger.warn({ method: req.method, path: req.path }, '[AUTH] requireAuth is deprecated and does not verify tokens — migrate to requireSupabaseAuth.');
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    logger.warn({ method: req.method, path: req.path }, '[AUTH] Missing Authorization header');
    return res.status(401).json({ error: "Unauthorized: Authentication required." });
  }

  if (token.length < 10) {
    return res.status(401).json({ error: "Unauthorized: Invalid token format." });
  }

  next();
}

export async function requireSupabaseAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Unauthorized: Authentication required." });
  }

  try {
    const user = await verifySupabaseToken(token);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized: Invalid or expired session." });
    }
    req.supabaseUid = user.id;
    req.supabaseRole = user.role || 'passenger';
    return next();
  } catch (err) {
    logger.error({ err }, '[AUTH] Supabase token verification error');
    return res.status(401).json({ error: 'Unauthorized: Could not verify session.' });
  }
}

// Optional auth — attaches user if token is valid, but always continues
export async function optionalSupabaseAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token) {
    try {
      const user = await verifySupabaseToken(token);
      if (user) {
        req.supabaseUid = user.id;
        req.supabaseRole = user.role || 'passenger';
      }
    } catch { /* ignore — proceed without auth */ }
  }
  return next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const adminKey = req.headers["x-admin-key"];
  const expectedKey = process.env.ADMIN_SECRET_KEY;

  if (!expectedKey) {
    logger.error('[SECURITY] CRITICAL: ADMIN_SECRET_KEY environment variable is not set. Admin access is blocked.');
    return res.status(503).json({ error: "Admin panel is not configured. Contact the system administrator." });
  }

  if (!adminKey || adminKey !== expectedKey) {
    logger.warn({ ip: req.ip, path: req.path }, '[SECURITY] Failed admin access attempt');
    return res.status(403).json({ error: "Forbidden: Invalid or missing admin credentials." });
  }

  next();
}

export function validateContentType(req: Request, res: Response, next: NextFunction) {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const ct = req.headers['content-type'];
    if (!ct || !ct.includes('application/json')) {
      return res.status(415).json({ error: "Unsupported Media Type: Content-Type must be application/json." });
    }
  }
  next();
}

export function generateSecureToken(): string {
  return crypto.randomBytes(32).toString('hex');
}
