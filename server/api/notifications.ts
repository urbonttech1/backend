import { Router, Request, Response, NextFunction } from 'express';
import { requireSupabaseAuth } from '../middleware';
import { requireAdminJWT } from './admin-auth';
import { supabaseAdmin } from '../db/client';
import { validate } from '../middleware/validation';
import { createContextLogger } from '../lib/logger';
import { z } from 'zod';
import { sendMulticast, sendToToken, type PushPayload } from '../services/fcm';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

const log = createContextLogger('NOTIFICATIONS');
export const notificationsRouter = Router();

const registerTokenSchema = z.object({
  token: z.string().min(10, 'Invalid FCM token'),
  platform: z.enum(['ios', 'android', 'web']).default('web'),
  deviceId: z.string().max(200).optional(),
});

// POST /api/notifications/token — register or refresh an FCM push token
notificationsRouter.post(
  '/token',
  requireSupabaseAuth,
  validate(registerTokenSchema),
  async (req: Request, res: Response) => {
    const user_id = req.supabaseUid!;
    const { token, platform, deviceId } = req.body;

    try {
      const { error } = await supabaseAdmin
        .from('user_push_tokens')
        .upsert(
          {
            user_id,
            token,
            platform,
            device_id: deviceId || null,
            active: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'token' },
        );

      if (error) throw error;

      res.json({ success: true });
    } catch (err: any) {
      log.error({ err: err.message, user_id }, 'register token error');
      res.status(500).json({ error: 'Failed to register push token' });
    }
  },
);

// DELETE /api/notifications/token — unregister an FCM token (logout / permission revoked)
notificationsRouter.delete(
  '/token',
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    const user_id = req.supabaseUid!;
    const token = req.body?.token || req.query.token;

    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }

    try {
      await supabaseAdmin
        .from('user_push_tokens')
        .update({ active: false })
        .eq('user_id', user_id)
        .eq('token', token as string);

      res.json({ success: true });
    } catch (err: any) {
      log.error({ err: err.message, user_id }, 'unregister token error');
      res.status(500).json({ error: 'Failed to unregister push token' });
    }
  },
);

// GET /api/notifications/mine — fetch in-app notifications for the current user
notificationsRouter.get(
  '/mine',
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    const user_id = req.supabaseUid!;
    const limit = Math.min(parseInt(req.query.limit as string || '30'), 50);

    try {
      const { data, error } = await supabaseAdmin
        .from('notifications')
        .select('id, type, title, body, data, read, created_at')
        .eq('user_id', user_id)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      res.json(data ?? []);
    } catch (err: any) {
      log.error({ err: err.message, user_id }, 'get notifications error');
      res.status(500).json({ error: 'Failed to fetch notifications' });
    }
  },
);

// PATCH /api/notifications/read — mark notifications as read
notificationsRouter.patch(
  '/read',
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    const user_id = req.supabaseUid!;
    const { ids } = req.body;

    try {
      let query = supabaseAdmin
        .from('notifications')
        .update({ read: true })
        .eq('user_id', user_id);

      if (Array.isArray(ids) && ids.length > 0) {
        query = query.in('id', ids);
      }

      const { error } = await query;
      if (error) throw error;
      res.json({ success: true });
    } catch (err: any) {
      log.error({ err: err.message, user_id }, 'mark read error');
      res.status(500).json({ error: 'Failed to mark notifications as read' });
    }
  },
);

// ─── Admin: broadcast push notifications ─────────────────────────────────────

const broadcastSchema = z.object({
  title:     z.string().min(1).max(100),
  body:      z.string().min(1).max(500),
  imageUrl:  z.string().url().optional(),
  data:      z.record(z.string(), z.string()).optional(),
  // Targeting
  audience:  z.enum(['all', 'passengers', 'drivers', 'valets']).default('all'),
  user_ids:  z.array(z.string().uuid()).max(1000).optional(), // explicit list overrides audience
  platform:  z.enum(['all', 'ios', 'android', 'web']).default('all'),
});

/**
 * POST /api/notifications/broadcast
 * Admin-only: send a push notification to all or a segment of users.
 * FIX: Previously used a weak cookie presence check (req.cookies['urbont_admin_session'])
 * that any client could spoof by setting that cookie to any truthy value.
 * Now uses requireAdminJWT which verifies the signed JWT issued at admin login.
 */
notificationsRouter.post(
  '/broadcast',
  requireAdminJWT as unknown as (req: Request, res: Response, next: NextFunction) => void,
  async (req: Request, res: Response) => {
    const parsed = broadcastSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
    }

    const { title, body, imageUrl, data, audience, user_ids, platform } = parsed.data;

    try {
      let targetUserIds: string[] = [];
      let tokens: string[] = [];

      if (user_ids && user_ids.length > 0) {
        // Explicit user list
        targetUserIds = user_ids;

        let q = supabaseAdmin
          .from('user_push_tokens')
          .select('token')
          .in('user_id', user_ids)
          .eq('active', true);

        if (platform !== 'all') q = q.eq('platform', platform);

        const { data: rows } = await q;
        tokens = (rows ?? []).map((r: unknown) => (r as { token: string }).token);

      } else {
        // Audience segment — resolve user IDs first from profiles
        let profileQuery = supabaseAdmin.from('profiles').select('id');

        if (audience === 'passengers') {
          profileQuery = profileQuery.eq('role', 'passenger');
        } else if (audience === 'drivers') {
          profileQuery = profileQuery.in('role', ['chauffeur', 'driver']);
        } else if (audience === 'valets') {
          profileQuery = profileQuery.in('role', ['valet', 'concierge']);
        }
        // 'all' — no role filter

        const { data: profiles, error: profileErr } = await profileQuery;
        if (profileErr) throw profileErr;

        targetUserIds = (profiles ?? []).map((p: unknown) => (p as { id: string }).id);
        if (targetUserIds.length === 0) {
          return res.json({ sent: 0, failed: 0, total_tokens: 0 });
        }

        // Batch in chunks of 500 to avoid Supabase IN clause limits
        const chunks: string[][] = [];
        for (let i = 0; i < targetUserIds.length; i += 500) {
          chunks.push(targetUserIds.slice(i, i + 500));
        }

        for (const chunk of chunks) {
          let q = supabaseAdmin
            .from('user_push_tokens')
            .select('token')
            .in('user_id', chunk)
            .eq('active', true);

          if (platform !== 'all') q = q.eq('platform', platform);

          const { data: rows } = await q;
          tokens.push(...(rows ?? []).map((r: unknown) => (r as { token: string }).token));
        }
      }

      if (tokens.length === 0) {
        log.info({ audience, platform }, 'broadcast: no tokens found for audience');
        return res.json({ sent: 0, failed: 0, total_tokens: 0 });
      }

      const payload: PushPayload = { title, body, data, imageUrl };

      // Send FCM push + persist to in-app notification inbox in parallel.
      // Persistence is fire-and-forget in batches of 500 (Supabase insert limit).
      // Without this, broadcast/promo notifications never appeared in the
      // in-app notification list even when the FCM push arrived successfully.
      const [result] = await Promise.all([
        sendMulticast(tokens, payload),
        persistBroadcastToInbox(targetUserIds, title, body, data),
      ]);

      log.info(
        { sent: result.sent, failed: result.failed, total: tokens.length, audience, platform },
        'admin broadcast sent',
      );

      return res.json({
        sent:         result.sent,
        failed:       result.failed,
        total_tokens: tokens.length,
      });

    } catch (err: any) {
      log.error({ err: err.message }, 'broadcast error');
      return res.status(500).json({ error: 'Failed to send broadcast notification' });
    }
  },
);

/**
 * Bulk-insert one `notifications` row per user so broadcast/promo messages
 * appear in the in-app notification inbox (/api/notifications/mine).
 * Runs in batches of 500 to stay within Supabase's insert-row limits.
 * Non-throwing — failures are logged but never propagate to the caller.
 */
async function persistBroadcastToInbox(
  userIds: string[],
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  if (userIds.length === 0) return;
  const type = data?.type ?? 'promo';
  const now  = new Date().toISOString();

  try {
    for (let i = 0; i < userIds.length; i += 500) {
      const chunk = userIds.slice(i, i + 500);
      const rows  = chunk.map(user_id => ({
        user_id,
        title,
        body,
        type,
        read:       false,
        data:       data ?? {},
        created_at: now,
      }));
      const { error } = await supabaseAdmin.from('notifications').insert(rows);
      if (error) log.warn({ err: error.message }, 'persistBroadcastToInbox partial failure');
    }
  } catch (err: any) {
    log.warn({ err: err.message }, 'persistBroadcastToInbox error (non-critical)');
  }
}

/**
 * POST /api/notifications/send-to-user
 * Admin-only: send a push to a single user by user_id.
 * FIX: was gated by the same spoofable cookie-presence check as /broadcast
 * (any client could set `urbont_admin_session` to a truthy value and pass).
 * Now verified by requireAdminJWT like the other admin endpoints in this file.
 */
notificationsRouter.post(
  '/send-to-user',
  requireAdminJWT as unknown as (req: Request, res: Response, next: NextFunction) => void,
  async (req: Request, res: Response) => {
    const schema = z.object({
      user_id:  z.string().uuid(),
      title:    z.string().min(1).max(100),
      body:     z.string().min(1).max(500),
      data:     z.record(z.string(), z.string()).optional(),
      imageUrl: z.string().url().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
    }

    const { user_id, title, body, data, imageUrl } = parsed.data;

    try {
      const { data: rows } = await supabaseAdmin
        .from('user_push_tokens')
        .select('token')
        .eq('user_id', user_id)
        .eq('active', true);

      const tokens = (rows ?? []).map((r: unknown) => (r as { token: string }).token);
      if (tokens.length === 0) {
        return res.json({ sent: 0, failed: 0, message: 'No active tokens for this user' });
      }

      const result = await sendMulticast(tokens, { title, body, data, imageUrl });

      log.info({ user_id, sent: result.sent, failed: result.failed }, 'send-to-user sent');
      return res.json({ sent: result.sent, failed: result.failed });

    } catch (err: any) {
      log.error({ err: err.message, user_id }, 'send-to-user error');
      return res.status(500).json({ error: 'Failed to send notification to user' });
    }
  },
);

/**
 * GET /api/notifications/stats
 * Admin-only: returns push token stats by platform and audience.
 * FIX: was gated by the spoofable cookie-presence check (see /send-to-user above).
 */
notificationsRouter.get(
  '/stats',
  requireAdminJWT as unknown as (req: Request, res: Response, next: NextFunction) => void,
  async (req: Request, res: Response) => {
    try {
      const { data: rows, error } = await supabaseAdmin
        .from('user_push_tokens')
        .select('platform')
        .eq('active', true);

      if (error) throw error;

      const counts: Record<string, number> = { total: 0, web: 0, android: 0, ios: 0 };
      for (const r of rows ?? []) {
        counts.total++;
        const p = r.platform as string;
        counts[p] = (counts[p] ?? 0) + 1;
      }

      return res.json(counts);
    } catch (err: any) {
      log.error({ err: err.message }, 'stats error');
      return res.status(500).json({ error: 'Failed to fetch notification stats' });
    }
  },
);


  // ─── Notification Templates (predefined campaigns) ───────────────────────────
  // Uber-style: short titles, direct copy, urgency, commercial tone.
  // Supports {name} token — replace server-side before sending if personalizing.

  export const NOTIFICATION_TEMPLATES: Record<string, { title: string; body: string; data: Record<string, string> }> = {

    // ── Onboarding ─────────────────────────────────────────────────────────────
    welcome: {
      title: 'URBONT is ready for you',
      body: 'Your chauffeur is a tap away. Book your first ride now.',
      data: { type: 'onboarding', action: 'open_booking' },
    },

    // ── Promotions ─────────────────────────────────────────────────────────────
    promo_first_ride: {
      title: 'Your first ride, on us',
      body: '20% off — no strings attached. Use FIRST20 at checkout. Expires in 48 hours.',
      data: { type: 'promo', code: 'FIRST20', action: 'open_booking' },
    },
    promo_weekend: {
      title: 'Ride this weekend for less',
      body: '15% off Business Class, all weekend. Use WKND15 before Sunday midnight.',
      data: { type: 'promo', code: 'WKND15', action: 'open_booking' },
    },
    promo_airport: {
      title: 'Flying out? Book your transfer',
      body: 'Airport rides with complimentary meet & greet. Reserve your spot now.',
      data: { type: 'promo', action: 'open_booking' },
    },
    promo_flash: {
      title: 'Flash deal — 3 hours only',
      body: 'Book in the next 3 hours and save $10 on your next ride. Tap to claim.',
      data: { type: 'promo', action: 'open_booking' },
    },
    promo_loyalty: {
      title: "You've earned a free upgrade",
      body: 'Complimentary SUV on your next booking. No code needed — just book.',
      data: { type: 'promo', action: 'open_booking' },
    },

    // ── Re-engagement ──────────────────────────────────────────────────────────
    re_engagement: {
      title: "It's been a while",
      body: 'Your chauffeur is ready when you are. Book in under 60 seconds.',
      data: { type: 're_engagement', action: 'open_booking' },
    },
    re_engagement_personal: {
      title: 'Where to, {name}?',
      body: 'Your last ride was great. Ready for the next one?',
      data: { type: 're_engagement', action: 'open_booking' },
    },

    // ── Ride lifecycle ─────────────────────────────────────────────────────────
    ride_reminder_30min: {
      title: 'Your ride is in 30 minutes',
      body: 'Your chauffeur is confirmed. Be ready at your pickup location.',
      data: { type: 'ride_reminder', action: 'open_active_ride' },
    },
    ride_reminder_10min: {
      title: 'Your driver is 10 minutes out',
      body: "Head to the pickup point. They'll be there shortly.",
      data: { type: 'ride_reminder', action: 'open_active_ride' },
    },
    rate_ride: {
      title: 'How was your ride?',
      body: 'Rate your experience with {driver_name}. Takes 10 seconds.',
      data: { type: 'rate_ride', action: 'open_rating' },
    },

    // ── Referral ───────────────────────────────────────────────────────────────
    referral: {
      title: 'Give $10, get $10',
      body: 'Share your code with a friend. You both earn credit when they ride.',
      data: { type: 'referral', action: 'open_referral' },
    },

    // ── App updates ────────────────────────────────────────────────────────────
    app_update: {
      title: 'New in URBONT',
      body: "Faster booking, country selector, and more — open the app to see what's new.",
      data: { type: 'update', action: 'open_app' },
    },

    // ── Safety ─────────────────────────────────────────────────────────────────
    safety_check: {
      title: 'Everything okay?',
      body: "If anything felt off during your last ride, let us know. We're listening.",
      data: { type: 'safety', action: 'open_support' },
    },
};

  // GET /api/notifications/templates — list available notification templates
  // FIX: was gated by the spoofable cookie-presence check (see /send-to-user above).
  notificationsRouter.get(
    '/templates',
    requireAdminJWT as unknown as (req: Request, res: Response, next: NextFunction) => void,
    async (req: Request, res: Response) => {
      return res.json(NOTIFICATION_TEMPLATES);
    }
  );

  // POST /api/notifications/send-template
  // Admin-only: send a predefined template to a segment in one call.
  // FIX: was gated by the spoofable cookie-presence check (see /send-to-user above).
  notificationsRouter.post(
    '/send-template',
    requireAdminJWT as unknown as (req: Request, res: Response, next: NextFunction) => void,
    async (req: Request, res: Response) => {
      const schema = z.object({
        template_key: z.string().min(1),
        audience:     z.enum(['all', 'passengers', 'drivers', 'valets']).default('all'),
        platform:     z.enum(['all', 'ios', 'android', 'web']).default('all'),
        overrides:    z.object({
          title: z.string().optional(),
          body:  z.string().optional(),
        }).optional(),
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid payload', details: parsed.error.flatten() });
      }

      const { template_key, audience, platform, overrides } = parsed.data;
      const tpl = NOTIFICATION_TEMPLATES[template_key];
      if (!tpl) {
        return res.status(404).json({
          error: `Template '${template_key}' not found`,
          available: Object.keys(NOTIFICATION_TEMPLATES),
        });
      }

      // Forward to broadcast endpoint logic
      const title = overrides?.title ?? tpl.title;
      const body  = overrides?.body  ?? tpl.body;
      const data  = tpl.data;

      // Reuse broadcast by delegating internally
      req.body = { title, body, data, audience, platform };
      // Mark as broadcast type so inbox stores it
      req.body.data = { ...data };

      try {
        let tokens: string[] = [];
        let targetUserIds: string[] = [];

        if (audience === 'all') {
          const { data: rows } = await supabaseAdmin
            .from('user_push_tokens')
            .select('user_id, token')
            .eq('active', true);
          tokens = (rows ?? []).map((r: Record<string,string>) => r.token);
          targetUserIds = [...new Set((rows ?? []).map((r: Record<string,string>) => r.user_id))];
        } else {
          const roleMap: Record<string, string[]> = {
            passengers: ['passenger'],
            drivers: ['chauffeur', 'driver'],
            valets: ['valet', 'concierge'],
          };
          const { data: profiles } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .in('role', roleMap[audience] ?? []);
          targetUserIds = (profiles ?? []).map((p: Record<string,string>) => p.id);
          if (targetUserIds.length > 0) {
            const { data: rows } = await supabaseAdmin
              .from('user_push_tokens')
              .select('token')
              .in('user_id', targetUserIds)
              .eq('active', true);
            tokens = (rows ?? []).map((r: Record<string,string>) => r.token);
          }
        }

        if (tokens.length === 0) {
          return res.json({ sent: 0, failed: 0, total_tokens: 0, template: template_key });
        }

        const payload: PushPayload = { title, body, data };
        const [result] = await Promise.all([
          sendMulticast(tokens, payload),
          persistBroadcastToInbox(targetUserIds, title, body, data),
        ]);

        log.info({ template: template_key, audience, sent: result.sent }, 'template notification sent');
        return res.json({ sent: result.sent, failed: result.failed, total_tokens: tokens.length, template: template_key });

      } catch (err: any) {
        log.error({ err: err.message, template: template_key }, 'send-template error');
        return res.status(500).json({ error: 'Failed to send template notification' });
      }
    }
  );
  