import { createContextLogger } from '../lib/logger';
import { supabaseAdmin } from '../db/client';
import { recordRideOffers } from './driverRideHistory';

const log = createContextLogger('FCM');

type FirebaseMessaging = import('firebase-admin/messaging').Messaging;

let messaging: FirebaseMessaging | null = null;
let initialized = false;

async function getMessaging(): Promise<FirebaseMessaging | null> {
  if (initialized) return messaging;
  initialized = true;

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountJson) {
    log.warn('FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled');
    return null;
  }

  try {
    const admin = await import('firebase-admin');
    const serviceAccount = JSON.parse(serviceAccountJson);

    if (!admin.default.apps.length) {
      admin.default.initializeApp({
        credential: admin.default.credential.cert(serviceAccount),
      });
    }

    messaging = admin.default.messaging();
    log.info('Firebase Admin initialized');
    return messaging;
  } catch (err: any) {
    log.error({ err: err.message }, 'Failed to initialize Firebase Admin');
    return null;
  }
}

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
}

export async function sendToToken(token: string, payload: PushPayload): Promise<boolean> {
  const fcm = await getMessaging();
  if (!fcm) return false;

  try {
    await fcm.send({
      token,
      notification: {
        title: payload.title,
        body: payload.body,
        ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
      },
      data: payload.data ?? {},
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'urbont_rides',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    });
    return true;
  } catch (err: any) {
    if (err.code === 'messaging/registration-token-not-registered') {
      log.warn({ token: token.slice(-8) }, 'Stale FCM token — removing');
      await invalidateToken(token);
    } else {
      log.error({ err: err.message, token: token.slice(-8) }, 'FCM send error');
    }
    return false;
  }
}

export async function sendMulticast(tokens: string[], payload: PushPayload): Promise<{ sent: number; failed: number }> {
  if (tokens.length === 0) return { sent: 0, failed: 0 };
  const fcm = await getMessaging();
  if (!fcm) return { sent: 0, failed: 0 };

  // FCM sendEachForMulticast handles up to 500 tokens per batch
  const chunks: string[][] = [];
  for (let i = 0; i < tokens.length; i += 500) {
    chunks.push(tokens.slice(i, i + 500));
  }

  let sent = 0;
  let failed = 0;
  const staleTokens: string[] = [];

  for (const chunk of chunks) {
    const response = await fcm.sendEachForMulticast({
      tokens: chunk,
      notification: {
        title: payload.title,
        body: payload.body,
        ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
      },
      data: payload.data ?? {},
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'urbont_rides' },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
      },
    });

    sent += response.successCount;
    failed += response.failureCount;

    response.responses?.forEach((r, idx: number) => {
      if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
        staleTokens.push(chunk[idx]);
      }
    });
  }

  if (staleTokens.length > 0) {
    await invalidateTokens(staleTokens);
  }

  log.info({ sent, failed, total: tokens.length }, 'FCM multicast sent');
  return { sent, failed };
}

// Notify all online drivers about a new ride request
export async function notifyNearbyDrivers(
  rideId: string,
  vehicleType: string,
  pickupAddress: string,
  radiusKm = 15,
): Promise<void> {
  try {
    // Get all online drivers (who have been active in the last 15 minutes)
    const { data: onlineDrivers, error } = await supabaseAdmin
      .from('driver_locations')
      .select('driver_id')
      .eq('is_online', true)
      .gte('updated_at', new Date(Date.now() - 15 * 60 * 1000).toISOString());

    if (error || !onlineDrivers || onlineDrivers.length === 0) {
      log.info({ rideId }, 'No online drivers to notify');
      return;
    }

    const driverIds = (onlineDrivers as Record<string, unknown>[]).map((d) => d.driver_id as string);

    // Get their FCM tokens
    const { data: tokenRows } = await supabaseAdmin
      .from('user_push_tokens')
      .select('user_id, token')
      .in('user_id', driverIds)
      .eq('active', true);

    const tokens = (tokenRows ?? []).map((r: unknown) => (r as { token: string }).token);
    if (tokens.length === 0) {
      log.info({ rideId, driverCount: driverIds.length }, 'Online drivers have no FCM tokens');
      return;
    }

    // Truncate address for notification
    const shortAddress = pickupAddress.length > 60 ? pickupAddress.slice(0, 57) + '...' : pickupAddress;

    await sendMulticast(tokens, {
      title: 'New Ride Request',
      body: `${vehicleType} needed — Pickup: ${shortAddress}`,
      data: {
        type: 'new_ride',
        ride_id: rideId,
        vehicle_type: vehicleType,
        screen: 'ride_offer',
      },
    });
    // Sólo quienes tenían token recibieron la oferta.
    recordRideOffers(rideId, (tokenRows ?? []).map((r: unknown) => (r as { user_id: string }).user_id), 'push');
  } catch (err: any) {
    log.error({ err: err.message, rideId }, 'notifyNearbyDrivers error');
  }
}

// Persist a notification to the in-app notifications table (fire-and-forget)
async function persistNotification(userId: string, payload: PushPayload): Promise<void> {
  try {
    await supabaseAdmin.from('notifications').insert({
      user_id: userId,
      title:   payload.title,
      body:    payload.body,
      type:    payload.data?.type ?? 'system',
      read:    false,
      data:    payload.data ?? {},
    });
  } catch { /* non-critical — never throw */ }
}

// Notify a specific user (passenger or driver)
export async function notifyUser(
  userId: string,
  payload: PushPayload,
): Promise<void> {
  try {
    // Persist to in-app notification history regardless of FCM status
    persistNotification(userId, payload).catch(() => {});

    const { data: tokenRows } = await supabaseAdmin
      .from('user_push_tokens')
      .select('token')
      .eq('user_id', userId)
      .eq('active', true);

    const tokens = (tokenRows ?? []).map((r: unknown) => (r as { token: string }).token);
    if (tokens.length === 0) return;

    await sendMulticast(tokens, payload);
  } catch (err: any) {
    log.error({ err: err.message, userId }, 'notifyUser error');
  }
}

async function invalidateToken(token: string): Promise<void> {
  await invalidateTokens([token]);
}

async function invalidateTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await supabaseAdmin
    .from('user_push_tokens')
    .update({ active: false })
    .in('token', tokens);
}
