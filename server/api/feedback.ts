import { Router, Request, Response } from 'express';
import { sanitizeBody, requireSupabaseAuth } from '../middleware';
import { pool } from '../db/pool';
import { logger } from '../lib/logger';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export const feedbackRouter = Router();

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
  if (entry.count > 5) {
    return res.status(429).json({ error: 'Too many feedback submissions. Please wait a moment.' });
  }
  next();
}

/* ──────────────────────────────────────────────
   POST /api/feedback/submit
   Requires auth — userId is extracted from JWT, not from body.
────────────────────────────────────────────── */
feedbackRouter.post('/submit', sanitizeBody, ipRateLimit, requireSupabaseAuth, async (req: Request, res: Response) => {
  const userId = req.supabaseUid;
  if (!userId) return res.status(401).json({ error: 'Unauthorized.' });

  const {
    type = 'trip_review',
    category,
    rating,
    areaRatings,
    comment,
    chauffeurId,
    tripId,
    isAnonymous = false,
  } = req.body as {
    type?: string;
    category?: string;
    rating?: number;
    areaRatings?: Record<string, number>;
    comment?: string;
    chauffeurId?: string;
    tripId?: string;
    isAnonymous?: boolean;
  };

  if (rating !== undefined && (typeof rating !== 'number' || rating < 1 || rating > 5)) {
    return res.status(400).json({ error: 'Rating must be a number between 1 and 5.' });
  }

  const VALID_TYPES = ['trip_review', 'app_feedback', 'chauffeur_feedback', 'complaint', 'suggestion'];
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Invalid feedback type.' });
  }

  try {
    await pool.query(
      `INSERT INTO client_feedback
         (user_id, type, category, rating, area_ratings, comment, chauffeur_id, trip_id, is_anonymous, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [
        userId,
        type,
        category || null,
        rating || null,
        areaRatings ? JSON.stringify(areaRatings) : null,
        comment ? comment.trim().slice(0, 2000) : null,
        chauffeurId || null,
        tripId || null,
        isAnonymous,
      ]
    );

    return res.json({ success: true });
  } catch (err) {
    logger.error(`[Feedback] Submit error: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Failed to save feedback.' });
  }
});

export async function getFeedbackForAdmin(): Promise<object[]> {
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, type, category, rating, area_ratings, comment,
              chauffeur_id, trip_id, is_anonymous, created_at
       FROM client_feedback
       ORDER BY created_at DESC
       LIMIT 500`
    );
    return rows;
  } catch {
    return [];
  }
}
