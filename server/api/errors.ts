import { Router, Request, Response } from 'express';
import { sanitizeBody } from '../middleware';
import { pool } from '../db/pool';
import { logger } from '../lib/logger';

export const errorsRouter = Router();

// Per-IP rate limit: max 10 reports/min to prevent abuse
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
  if (entry.count > 10) {
    return res.status(429).json({ error: 'Rate limit exceeded.' });
  }
  next();
}

/* ──────────────────────────────────────────────
   POST /api/errors/report
   Unauthenticated — client-side crash reporter.
   Accepts error reports from ErrorBoundary and
   stores them in the client_errors table.
────────────────────────────────────────────── */
errorsRouter.post('/report', sanitizeBody, ipRateLimit, async (req: Request, res: Response) => {
  const {
    error_id,
    message,
    stack,
    component_stack,
    url,
    user_agent,
    ts,
  } = req.body as {
    error_id?: string;
    message?: string;
    stack?: string;
    component_stack?: string;
    url?: string;
    user_agent?: string;
    ts?: string;
  };

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required.' });
  }

  // Best-effort insert — any failure silently returns 200 so the client doesn't
  // crash trying to report a crash.
  try {
    await pool.query(
      `INSERT INTO client_errors
         (error_id, message, stack, component_stack, url, user_agent, reported_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [
        error_id ? String(error_id).slice(0, 64) : null,
        String(message).slice(0, 1000),
        stack ? String(stack).slice(0, 2000) : null,
        component_stack ? String(component_stack).slice(0, 1000) : null,
        url ? String(url).slice(0, 500) : null,
        user_agent ? String(user_agent).slice(0, 300) : null,
        ts ? new Date(ts) : new Date(),
      ]
    );
  } catch (err) {
    const e = err as { message?: string };
    logger.warn(`[Errors] Failed to persist client error report: ${e.message}`);
    // Still return 200 — we don't want the client ErrorBoundary to fail
  }

  return res.json({ ok: true });
});
