import { Router, Request, Response } from 'express';
import webpush from 'web-push';
import { supabaseAdmin } from '../db/client';
import { requireSupabaseAuth } from '../middleware';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export const pushRouter = Router();

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_EMAIL   = 'mailto:support@urbont.com';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
}

// ── POST /api/push/subscribe ─────────────────────────────────────────────────
pushRouter.post('/subscribe', requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.supabaseUid as string;
    const { subscription } = req.body as {
      subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
    };
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

    await supabaseAdmin.from('push_subscriptions').upsert({
      user_id:  userId,
      endpoint: subscription.endpoint,
      p256dh:   subscription.keys.p256dh,
      auth:     subscription.keys.auth,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' });

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/push/unsubscribe ─────────────────────────────────────────────
pushRouter.delete('/unsubscribe', requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.supabaseUid as string;
    const { endpoint } = req.body as { endpoint?: string };
    if (endpoint) {
      await supabaseAdmin.from('push_subscriptions').delete().eq('endpoint', endpoint);
    } else {
      await supabaseAdmin.from('push_subscriptions').delete().eq('user_id', userId);
    }
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Public key endpoint ──────────────────────────────────────────────────────
pushRouter.get('/vapid-public-key', (_req: Request, res: Response) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Push not configured' });
  return res.json({ publicKey: VAPID_PUBLIC });
});

// ── Helper: send push to a user (called internally) ─────────────────────────
export async function sendPushToUser(
  userId: string,
  payload: { title: string; body: string; data?: Record<string, unknown>; icon?: string }
): Promise<void> {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  try {
    const { data: subs } = await supabaseAdmin
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', userId);
    if (!subs?.length) return;

    const message = JSON.stringify({
      title: payload.title,
      body:  payload.body,
      icon:  payload.icon || '/icon-192.png',
      badge: '/badge-72.png',
      data:  payload.data || {},
    });

    const stale: string[] = [];
    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            message
          );
        } catch (err: any) {
          if (err.statusCode === 404 || err.statusCode === 410) stale.push(sub.endpoint);
        }
      })
    );
    if (stale.length) {
      await supabaseAdmin.from('push_subscriptions').delete().in('endpoint', stale);
    }
  } catch {}
}
