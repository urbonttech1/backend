import { Router, Request, Response } from 'express';
import { createContextLogger } from '../lib/logger';

const log = createContextLogger('DIAGNOSTICS');
export const diagnosticsRouter = Router();

/* ── GET /api/version ─────────────────────────────────────────────────────────
   Lets support/ops confirm exactly which build is running on Cloud Run without
   SSH access — critical after a deploy to verify the fix actually rolled out.
   GIT_SHA / BUILD_TIME are injected as build-args in the Dockerfile / Cloud Build
   substitutions; K_REVISION is set automatically by Cloud Run. ──────────────── */
diagnosticsRouter.get('/version', (_req: Request, res: Response) => {
  res.json({
    version: process.env.npm_package_version ?? '1.2.2',
    gitSha: process.env.GIT_SHA ?? process.env.COMMIT_SHA ?? 'unknown',
    buildTime: process.env.BUILD_TIME ?? 'unknown',
    cloudRunRevision: process.env.K_REVISION ?? 'unknown',
    nodeEnv: process.env.NODE_ENV ?? 'unknown',
    uptimeSec: Math.floor(process.uptime()),
    serverTime: new Date().toISOString(),
  });
});

/* ── POST /api/client-log ─────────────────────────────────────────────────────
   Client-side error/telemetry reporting. Without this, crashes and silent
   disconnections happening on a user's phone are completely invisible to us —
   this pipes them into Cloud Logging so `fetch_deployment_logs`-style queries
   (or `gcloud logging read`) can surface real-world failures proactively,
   not just when a user complains. Deliberately unauthenticated (errors can
   happen before login, e.g. during signup or a broken session) but tightly
   rate-limited and payload-capped to prevent abuse. ─────────────────────────── */
const clientLogRateMap = new Map<string, { count: number; resetAt: number }>();
const CLIENT_LOG_MAX_PER_MIN = 30;

function clientLogRateLimit(req: Request, res: Response, next: () => void) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = clientLogRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    clientLogRateMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  entry.count++;
  if (entry.count > CLIENT_LOG_MAX_PER_MIN) {
    return res.status(429).json({ error: 'Too many log reports.' });
  }
  next();
}

const ALLOWED_LEVELS = new Set(['error', 'warn', 'info']);
const ALLOWED_SOURCES = new Set([
  'error_boundary', 'unhandled_rejection', 'window_error',
  'connectivity', 'auth', 'manual',
]);

function truncate(v: unknown, max: number): string | undefined {
  if (v == null) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) : s;
}

diagnosticsRouter.post('/client-log', clientLogRateLimit, (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const level = ALLOWED_LEVELS.has(body.level as string) ? (body.level as string) : 'error';
    const source = ALLOWED_SOURCES.has(body.source as string) ? (body.source as string) : 'manual';

    const entry = {
      source,
      message: truncate(body.message, 500),
      stack: truncate(body.stack, 2000),
      componentStack: truncate(body.componentStack, 1000),
      errorId: truncate(body.errorId, 100),
      url: truncate(body.url, 500),
      appVersion: truncate(body.appVersion, 50),
      platform: truncate(body.platform, 50),
      userId: truncate(body.userId, 100),
      role: truncate(body.role, 30),
      extra: body.extra ? truncate(body.extra, 1000) : undefined,
      ua: truncate(req.headers['user-agent'], 300),
      ip: req.ip,
    };

    const logFn = level === 'warn' ? log.warn.bind(log) : level === 'info' ? log.info.bind(log) : log.error.bind(log);
    logFn(entry, `[ClientLog/${source}] ${entry.message ?? 'no message'}`);

    return res.status(204).end();
  } catch (err) {
    // Never let a malformed client payload break the response — this endpoint
    // must be maximally forgiving since it's often called from crash paths.
    log.error(`[ClientLog] failed to process report: ${(err as Error).message}`);
    return res.status(204).end();
  }
});
