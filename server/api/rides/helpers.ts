import Stripe from 'stripe';
import { pool } from "../../db/pool";
import { logger } from '../../lib/logger';
import { CONSECUTIVE_TRIP_BONUS } from "../../config/pricing";

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let _stripeRides: Stripe | null = null;
const _RIDES_STRIPE_SK = process.env.STRIPE_SECRET_KEY;
if (!_RIDES_STRIPE_SK && process.env.NODE_ENV === 'production') {
  logger.warn('[WARN] STRIPE_SECRET_KEY not set — ride payments will be unavailable.');
}

export function getStripe(): Stripe | null {
  if (_stripeRides) return _stripeRides;
  const key = _RIDES_STRIPE_SK;
  if (!key || key.startsWith('pk_')) return null;
  _stripeRides = new Stripe(key);
  return _stripeRides;
}

export const VALET_COMMISSION_USD = 10;

export async function updateDriverStreak(driverId: string, _extraFee: number): Promise<void> {
  try {
    const { rows } = await pool.query<{ consecutive_trips: number }>(
      `INSERT INTO driver_stats (driver_id, consecutive_trips, total_earned, last_updated)
       VALUES ($1, 1, 0, NOW())
       ON CONFLICT (driver_id) DO UPDATE
         SET consecutive_trips = driver_stats.consecutive_trips + 1,
             last_updated = NOW()
       RETURNING consecutive_trips`,
      [driverId]
    );
    const next = rows[0]?.consecutive_trips ?? 1;
    const bonus = CONSECUTIVE_TRIP_BONUS[next] ?? 0;
    if (bonus > 0) {
      await pool.query(
        `UPDATE driver_stats SET total_earned = total_earned + $1 WHERE driver_id = $2`,
        [bonus, driverId]
      );
      logger.info(`[RIDES] Streak bonus $${bonus} issued to driver ${driverId} (trip #${next})`);
    }
  } catch (streakErr: unknown) {
    logger.warn(`[RIDES] updateDriverStreak failed for driver ${driverId}: ${(streakErr as Error)?.message}`);
  }
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function isDriverNearby(
  driverLat?: number | null,
  driverLng?: number | null,
  pickupLat?: number | null,
  pickupLng?: number | null,
  thresholdMeters: number = 500
): boolean {
  if (driverLat == null || driverLng == null || pickupLat == null || pickupLng == null) return false;
  const R = 6371e3;
  const φ1 = (driverLat * Math.PI) / 180;
  const φ2 = (pickupLat * Math.PI) / 180;
  const Δφ = ((pickupLat - driverLat) * Math.PI) / 180;
  const Δλ = ((pickupLng - driverLng) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return (R * c) <= thresholdMeters;
}

export const pinAttemptTracker = new Map<string, { count: number; resetAt: number }>();
export const MAX_PIN_ATTEMPTS  = 5;
export const PIN_LOCKOUT_MS    = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [rideId, entry] of pinAttemptTracker) {
    if (entry.resetAt < now) pinAttemptTracker.delete(rideId);
  }
}, PIN_LOCKOUT_MS);
