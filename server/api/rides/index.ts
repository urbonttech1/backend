import { Router, Request, Response } from "express";
import { requireSupabaseAuth, validateBody } from "../../middleware";
import { supabaseAdmin } from "../../db/client";
import { pool } from "../../db/pool";
import { sendRideReceipt } from "../../services/email";
import { notifyNearbyDrivers, notifyUser } from "../../services/fcm";
import { driverNotif } from "../../services/notificationTemplates";
import { validateTransition, ACTIVE_STATUSES, type RideStatus, type UserRole } from "../../services/stateMachine";
import {
  calculateFareFromRules,
  WAIT_TIME_FREE_MINUTES, WAIT_TIME_FEE_PER_MIN,
  LONG_PICKUP_FEE, LONG_PICKUP_THRESHOLD_MINS,
  NO_SHOW_FEE, CANCELLATION_FEE, CANCELLATION_GRACE_MINS,
  CONSECUTIVE_TRIP_BONUS,
} from "../../config/pricing";
import { broadcastRideStatus, notifyAvailableDrivers, normalizeVehicleCategory } from "../../services/socketService";
import { sendSmsTwilio } from "../../services/twilio";
import { checkRideDeviation } from "../../services/rideCheck";
import Stripe from 'stripe';
import { logger } from '../../lib/logger';
import { randomInt } from 'crypto';

import type { PickupDropoff, RideRow, DriverStats } from './types';
export type { PickupDropoff, RideRow, DriverStats };

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

let _stripeRides: Stripe | null = null;
const _RIDES_STRIPE_SK = process.env.STRIPE_SECRET_KEY;
if (!_RIDES_STRIPE_SK && process.env.NODE_ENV === 'production') {
  logger.warn('[WARN] STRIPE_SECRET_KEY not set — ride payments will be unavailable.');
}

function getStripe(): Stripe | null {
  if (_stripeRides) return _stripeRides;
  const key = _RIDES_STRIPE_SK;
  if (!key || key.startsWith('pk_')) return null;
  _stripeRides = new Stripe(key);
  return _stripeRides;
}

const VALET_COMMISSION_USD = 10;

// ── Helper: update driver consecutive-trip streak and issue bonus ─────────────
async function updateDriverStreak(driverId: string, _extraFee: number): Promise<void> {
  // Atomic SQL: INSERT … ON CONFLICT DO UPDATE avoids read-modify-write race condition
  // when two rides complete simultaneously for the same driver.
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

export const rideRouter = Router();

// In-memory PIN brute-force tracker { rideId → { count, resetAt } }
// Prevents brute-forcing the 4-digit pickup-PIN (9999 max guesses without this)
const pinAttemptTracker = new Map<string, { count: number; resetAt: number }>();
const MAX_PIN_ATTEMPTS  = 5;
const PIN_LOCKOUT_MS    = 15 * 60 * 1000; // 15 min lockout after 5 wrong attempts

// Periodically purge expired PIN lockout entries to prevent unbounded Map growth
// (one entry per rideId that received a wrong PIN attempt; never auto-cleaned otherwise)
setInterval(() => {
  const now = Date.now();
  for (const [rideId, entry] of pinAttemptTracker) {
    if (entry.resetAt < now) pinAttemptTracker.delete(rideId);
  }
}, PIN_LOCKOUT_MS);

// --- GET /api/rides/calculate-fare — compute fare without creating a ride ---
rideRouter.get('/calculate-fare', requireSupabaseAuth, (req: Request, res: Response) => {
  const distanceKm     = parseFloat(req.query.distanceKm as string);
  const durationMinutes = parseFloat(req.query.durationMinutes as string);
  const vehicleType    = (req.query.vehicleType as string) || 'sedan';

  if (isNaN(distanceKm) || isNaN(durationMinutes) || distanceKm < 0 || durationMinutes < 0) {
    return res.status(400).json({ error: 'distanceKm and durationMinutes must be non-negative numbers.' });
  }

  try {
    const distanceMiles = distanceKm * 0.621371;
    const breakdown = calculateFareFromRules({ vehicleType, distanceMiles, durationMinutes });
    if (!breakdown) return res.status(400).json({ error: `Unknown vehicleType: ${vehicleType}` });
    return res.json(breakdown);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Fare calculation failed' });
  }
});

// --- Miami service-area geofence (125 km radius) ───────────────────────────
const MIAMI_CENTER = { lat: 25.7617, lng: -80.1918 };
const SERVICE_RADIUS_KM = 125;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isInServiceArea(lat: number, lng: number): boolean {
  return haversineKm(MIAMI_CENTER.lat, MIAMI_CENTER.lng, lat, lng) <= SERVICE_RADIUS_KM;
}

// --- GET /api/rides/estimate — Google Directions → real fare estimate ───────
rideRouter.get('/estimate', requireSupabaseAuth, async (req: Request, res: Response) => {
  const pickupLat   = parseFloat(req.query.pickupLat as string);
  const pickupLng   = parseFloat(req.query.pickupLng as string);
  const dropoffLat  = parseFloat(req.query.dropoffLat as string);
  const dropoffLng  = parseFloat(req.query.dropoffLng as string);
  const vehicleType = (req.query.vehicleType as string) || 'standard';
  const _isAirport  = req.query.isAirport === 'true'; // reserved: passed to fare calc once pricing.ts supports it

  if ([pickupLat, pickupLng, dropoffLat, dropoffLng].some(isNaN)) {
    return res.status(400).json({ error: 'pickupLat, pickupLng, dropoffLat, dropoffLng are required numbers.' });
  }

  // Geofence — both ends must be within Miami service area
  if (!isInServiceArea(pickupLat, pickupLng)) {
    return res.status(422).json({
      error: 'outside_service_area',
      message: "We're not available in your area yet. URBONT currently operates within the Greater Miami area. We'd love to serve you soon!",
    });
  }
  if (!isInServiceArea(dropoffLat, dropoffLng)) {
    return res.status(422).json({
      error: 'outside_service_area',
      message: "Your destination is outside our current service area. URBONT operates within the Greater Miami area. We'd love to expand soon!",
    });
  }

  // Build Google Directions URL with optional intermediate stops
  const GOOGLE_KEY = process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';

  let origin = `${pickupLat},${pickupLng}`;
  let destination = `${dropoffLat},${dropoffLng}`;
  let waypointsParam = '';

  if (req.query.stops) {
    try {
      const parsedStops = JSON.parse(req.query.stops as string) as Array<{ lat: number; lng: number }>;
      const validStops = parsedStops.filter(s => typeof s.lat === 'number' && typeof s.lng === 'number');
      if (validStops.length > 0) {
        waypointsParam = `&waypoints=${validStops.map(s => `${s.lat},${s.lng}`).join('|')}`;
      }
    } catch {
      return res.status(400).json({ error: 'Invalid stops format. Must be JSON array of { lat, lng } objects.' });
    }
  }

  const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}${waypointsParam}&mode=driving&key=${GOOGLE_KEY}`;

  try {
    const dirRes = await fetch(directionsUrl);
    if (!dirRes.ok) throw new Error('Google Directions API error');
    const dirData = await dirRes.json() as { status: string; routes?: Array<{ legs: Array<{ distance: { value: number }; duration: { value: number } }> }> };

    if (dirData.status !== 'OK' || !dirData.routes?.length) {
      return res.status(422).json({ error: 'No route found between those locations.' });
    }

    const legs = dirData.routes[0].legs;
    const totalDistance = legs.reduce((acc, l) => acc + l.distance.value, 0);
    const totalDuration = legs.reduce((acc, l) => acc + l.duration.value, 0);

    const distanceMiles   = totalDistance / 1609.344;  // meters → miles
    const durationMinutes = totalDuration / 60;         // seconds → minutes

    const breakdown = calculateFareFromRules({ vehicleType, distanceMiles, durationMinutes }) ?? { total: 0, distanceMiles, durationMinutes };
    res.json({ ...breakdown, distanceMiles, durationMinutes });
  } catch (err: any) {
    logger.error(`[RIDES] estimate error: ${err.message}`);
    res.status(500).json({ error: 'Failed to calculate fare estimate.' });
  }
});

// --- Cancellation fee logic ---
function calculateCancellationFee(scheduledAt: string | null, fare: number): number {
  if (!scheduledAt) return 0;
  const now = new Date();
  const scheduled = new Date(scheduledAt);
  if (isNaN(scheduled.getTime())) return 0; // guard: "Invalid Date" → NaN in fare math
  const diffHours = (scheduled.getTime() - now.getTime()) / (1000 * 60 * 60);
  if (diffHours < 2) return fare;
  if (diffHours < 24) return fare * 0.5;
  return 0;
}

// --- Haversine proximity check (500m threshold) ---
function isDriverNearby(driverLat: number, driverLng: number, pickupLat: number, pickupLng: number): boolean {
  const R = 6371e3;
  const f1 = driverLat * Math.PI / 180;
  const f2 = pickupLat * Math.PI / 180;
  const df = (pickupLat - driverLat) * Math.PI / 180;
  const dl = (pickupLng - driverLng) * Math.PI / 180;
  const a = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= 500;
}

// --- 1. Create a new ride (POST /api/rides) ---
rideRouter.post("/", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const {
      vehicleType, vehicle_type,
      pickup, dropoff,
      pickupLat, pickupLng,
      dropoffLat, dropoffLng,
      fare, distance, durationMinutes, duration_minutes,
      distanceMeters: bodyDistanceMeters,
      paymentMethod, payment_method,
      paymentIntentId, payment_intent_id: paymentIntentIdAlt,
      notes, scheduled_at, scheduledAt,
      flightNumber, airline, airportMode,
      stops,
      booking_type, bookingType: bookingTypeBody,
      hourly_hours, hourlyHours: hourlyHoursBody,
      accessibility,
      guestName, guest_name: guestNameAlt,
      guestPhone, guest_phone: guestPhoneAlt,
    } = req.body;

    const passenger_id = req.supabaseUid;
    const finalVehicleType = vehicleType || vehicle_type;
    const finalPickup = pickup;
    const finalDropoff = dropoff || pickup;

    if (!finalPickup || !finalVehicleType) {
      return res.status(400).json({ error: 'Missing required fields: pickup, vehicleType' });
    }

    // ── Miami service-area geofence check ────────────────────────────────────
    // Accept coordinates either as top-level fields OR nested inside pickup/dropoff objects
    const pLat = typeof pickupLat === 'number' ? pickupLat : (typeof finalPickup === 'object' ? (finalPickup as { lat?: number })?.lat : undefined);
    const pLng = typeof pickupLng === 'number' ? pickupLng : (typeof finalPickup === 'object' ? (finalPickup as { lng?: number })?.lng : undefined);
    const dLat = typeof dropoffLat === 'number' ? dropoffLat : (typeof finalDropoff === 'object' ? (finalDropoff as { lat?: number })?.lat : undefined);
    const dLng = typeof dropoffLng === 'number' ? dropoffLng : (typeof finalDropoff === 'object' ? (finalDropoff as { lng?: number })?.lng : undefined);

    if (typeof pLat === 'number' && typeof pLng === 'number' && !isInServiceArea(pLat, pLng)) {
      return res.status(422).json({
        error: 'outside_service_area',
        message: "We're not available in your area yet. URBONT currently operates within the Greater Miami area. We'd love to serve you soon!",
      });
    }
    if (typeof dLat === 'number' && typeof dLng === 'number' && !isInServiceArea(dLat, dLng)) {
      return res.status(422).json({
        error: 'outside_service_area',
        message: "Your destination is outside our current service area. URBONT operates within the Greater Miami area. We'd love to expand soon!",
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Active ride guard — passenger can only have one active ride at a time
    const { data: existing } = await supabaseAdmin
      .from('rides')
      .select('id')
      .eq('passenger_id', passenger_id)
      .in('ride_status', ACTIVE_STATUSES)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({
        error: 'You already have an active ride in progress. Please complete or cancel it before requesting a new one.',
        code: 'ACTIVE_RIDE_EXISTS',
        ride_id: (existing as { id: string }).id,
      });
    }

    // ── scheduled_at validation: must be in the future (min 15 min from now) ─────
      const rawScheduledAt = scheduledAt || scheduled_at;
      if (rawScheduledAt) {
        const scheduledMs = new Date(rawScheduledAt).getTime();
        if (isNaN(scheduledMs)) {
          return res.status(400).json({ error: 'Invalid scheduled_at: not a valid date.' });
        }
        const minsFromNow = (scheduledMs - Date.now()) / 60000;
        if (minsFromNow < -1) {
          return res.status(400).json({ error: 'Scheduled pickup time must be in the future.' });
        }
      }

      // Generate a 4-digit verification PIN for this ride
    const verificationPin = String(randomInt(1000, 10000));

    // ── Build the insert payload, always satisfying Supabase NOT NULL constraints ──
    // The Supabase DB was initialised with pickup_address / dropoff_address TEXT NOT NULL
    // and fare NUMERIC NOT NULL. We provide all of those plus extended JSONB columns.
    // If extended columns (pickup JSONB, dropoff JSONB, pickup_pin, stops) were not yet
    // added to Supabase, the first insert fails with code "42703"; we then retry with
    // only the guaranteed base schema and patch extended fields separately.
    const pickupObj  = typeof finalPickup  === 'string' ? { address: finalPickup }  : (finalPickup as Record<string, unknown>) ?? {};
    const dropoffObj = typeof finalDropoff === 'string' ? { address: finalDropoff } : (finalDropoff as Record<string, unknown>) ?? {};
    const pickupAddress  = String(pickupObj?.address  || 'Miami, FL');
    const dropoffAddress = String(dropoffObj?.address || pickupAddress);
    const finalFare = typeof fare === 'number' ? fare : (parseFloat(String(fare)) || 0);

    const finalGuestName  = guestName  || guestNameAlt  || null;
    const finalGuestPhone = guestPhone || guestPhoneAlt || null;

    const basePayload: Record<string, unknown> = {
      passenger_id,
      vehicle_type:    finalVehicleType,
      // pickup_address / dropoff_address intentionally omitted here: they may not yet be in the
      // PostgREST schema cache on the first deploy after the migration adds them.
      // They are written via the direct pool.query patch below when the fallback path is taken.
      fare:            finalFare,
      guest_name:      finalGuestName,
      // guest_phone is in extendedPayload only — not guaranteed in base schema until migration runs
      pickup_lat:      typeof pLat === 'number' ? pLat : null,
      pickup_lng:      typeof pLng === 'number' ? pLng : null,
      duration_minutes: durationMinutes || duration_minutes || null,
      payment_method:  paymentMethod || payment_method || 'card',
      notes:           notes || null,
      scheduled_at:    scheduledAt || scheduled_at || null,
      // Uber/Lyft model: rides booked >30 min ahead get status 'scheduled'
      // (not 'searching'). The cron job dispatches them at T-30 min before pickup.
      // Immediate rides (no scheduledAt or <30 min away) go straight to 'searching'.
      ride_status: (() => {
        const sa = scheduledAt || scheduled_at;
        if (!sa) return 'searching';
        const saDate = new Date(sa);
        const minsUntil = isNaN(saDate.getTime()) ? 0 : (saDate.getTime() - Date.now()) / 60000;
        return minsUntil > 30 ? 'scheduled' : 'searching';
      })(),
      created_at:      new Date().toISOString(),
      updated_at:      new Date().toISOString(),
    };

    const finalPaymentIntentId = paymentIntentId || paymentIntentIdAlt || null;

    // ── Upfront price lock: store locked_fare so it can never change after booking ──
    // Also store a full fare breakdown for earnings/receipt display
    const { surgeMultiplier: bodySurge, distanceMiles: bodyMiles, durationMinutes: bodyDuration } = req.body as { surgeMultiplier?: number; distanceMiles?: number; durationMinutes?: number; };
    const surgeMultiplier = typeof bodySurge === 'number' ? bodySurge : 1.0;
    let fareBreakdown: object | null = null;
    if (typeof bodyMiles === 'number' && typeof bodyDuration === 'number') {
      fareBreakdown = calculateFareFromRules({
        vehicleType:     finalVehicleType,
        distanceMiles:   bodyMiles,
        durationMinutes: bodyDuration,
        bookingType:     (req.body as { booking_type?: string; bookingType?: string }).booking_type || (req.body as { booking_type?: string; bookingType?: string }).bookingType || 'now',
      });
    }

    const finalDistanceMeters = typeof bodyDistanceMeters === 'number' ? bodyDistanceMeters : null;
    const finalDistanceMiles  = finalDistanceMeters !== null ? parseFloat((finalDistanceMeters / 1609.34).toFixed(4)) : null;

    const extendedPayload: Record<string, unknown> = {
      ...basePayload,
      // Include TEXT address columns in the extended payload (full schema).
      // Omitted from basePayload to avoid PostgREST schema-cache errors on first deploy.
      pickup_address:        pickupAddress,
      dropoff_address:       dropoffAddress,
      // Only include guest_phone when it has a value — omitting null prevents
      // PostgREST schema-cache errors on deployments where the column was just added.
      ...(finalGuestPhone ? { guest_phone: finalGuestPhone } : {}),
      dropoff_lat:           typeof dLat === 'number' ? dLat : null,
      dropoff_lng:           typeof dLng === 'number' ? dLng : null,
      booking_type:          booking_type || bookingTypeBody || 'now',
      hourly_hours:          hourly_hours || hourlyHoursBody || null,
      pickup:                pickupObj,
      dropoff:               dropoffObj,
      stops:                 Array.isArray(stops) && stops.length > 0 ? stops : null,
      pickup_pin:            verificationPin,
      payment_intent_id:     finalPaymentIntentId,
      accessibility:         accessibility === true || accessibility === 'true' ? true : false,
      // Upfront price lock — this is the guaranteed price shown before booking
      locked_fare:           finalFare,
      surge_multiplier:      surgeMultiplier,
      base_fare_breakdown:   fareBreakdown ? JSON.stringify(fareBreakdown) : null,
      // Route data from Google Directions (stored at booking time)
      distance_meters:       finalDistanceMeters,
      distance_miles:        finalDistanceMiles,
    };

    // ── Server-side fare guard: override client fare when server has enough data ──
    // Prevents a malicious client sending fare=0.01 to underpay for the ride.
    if (fareBreakdown && typeof (fareBreakdown as { total: number }).total === 'number' && (fareBreakdown as { total: number }).total > 0) {
      const serverFare = (fareBreakdown as { total: number }).total;
      basePayload.fare         = serverFare;
      extendedPayload.fare     = serverFare;
      extendedPayload.locked_fare = serverFare;
    } else if (finalFare < 3.00) {
      // Client omitted distanceMiles/durationMinutes and provided a suspiciously low fare
      return res.status(400).json({ error: 'Fare must be at least $3.00' });
    }

    // First attempt: full payload (works when Supabase schema has extended columns)
    let { data: ride, error } = await supabaseAdmin
      .from('rides').insert(extendedPayload).select().single();

    // Second attempt: if Supabase rejected an unknown column (PostgreSQL 42703 or
    // PostgREST PGRST204 schema-cache miss), fall back to base columns then patch.
    const isColumnError = error && (
      (error as NodeJS.ErrnoException)?.code === '42703' ||
      (error as NodeJS.ErrnoException)?.code === 'PGRST204' ||
      String((error as Error)?.message).includes('column') ||
      String((error as Error)?.message).includes('schema cache')
    );
    if (isColumnError) {
      logger.warn(`[RIDES] Extended columns missing in Supabase — retrying with base schema: ${(error as Error).message}`);
      const baseResult = await supabaseAdmin
        .from('rides').insert(basePayload).select().single();
      error = baseResult.error;
      ride  = baseResult.data;

      // Patch ALL extended columns onto the new row via direct SQL (bypasses PostgREST schema cache)
      if (!error && ride) {
        try {
          const rideId = (ride as RideRow).id;
          await pool.query(
            `UPDATE rides SET
               pickup_address    = $1,
               dropoff_address   = $2,
               dropoff_lat       = $3,
               dropoff_lng       = $4,
               pickup_lat        = $5,
               pickup_lng        = $6,
               pickup_pin        = $7,
               payment_intent_id = $8,
               locked_fare       = $9,
               booking_type      = $10,
               distance_meters   = $11,
               distance_miles    = $12,
               guest_phone       = $13
             WHERE id = $14`,
            [
              pickupAddress,
              dropoffAddress,
              typeof dLat === 'number' ? dLat : null,
              typeof dLng === 'number' ? dLng : null,
              typeof pLat === 'number' ? pLat : null,
              typeof pLng === 'number' ? pLng : null,
              verificationPin,
              finalPaymentIntentId || null,
              finalFare || null,
              booking_type || bookingTypeBody || 'now',
              finalDistanceMeters,
              finalDistanceMiles,
              finalGuestPhone || null,
              rideId,
            ]
          );
        } catch (patchErr: unknown) {
          logger.warn(`[RIDES] Extended patch failed: ${errMsg(patchErr)}`);
        }
      }
    }

    if (error) {
      logger.error(`Supabase ride insert error details:: ${JSON.stringify(error, null, 2)}`);
      throw error;
    }
    
    // Fire-and-forget: push notification + socket event to online drivers
    const rideRecord = ride as Record<string, any>;
    const pickupAddr = typeof rideRecord.pickup === 'string'
      ? rideRecord.pickup
      : (rideRecord.pickup?.address || 'Miami, FL');

    // ── Scheduled ride guard (Uber/Lyft model) ─────────────────────────────
    // Rides with status 'scheduled' must NOT be dispatched at booking time.
    // The ride is too far in the future — drivers can't accept it yet, and it
    // won't appear in the driver's available-rides list.
    // The cron job (dispatchScheduledRides) transitions it to 'searching' and
    // dispatches at T-30 min before the scheduled pickup time.
    const createdStatus = rideRecord.ride_status as string;

    // ── Notify passenger: booking confirmation ────────────────────────────────
    const paxId = String(rideRecord.passenger_id || '');
    if (paxId) {
      if (createdStatus === 'scheduled') {
        notifyUser(paxId, {
          title: 'Ride Scheduled',
          body: 'Your ride is confirmed. We\'ll assign your chauffeur closer to pickup time.',
          data: { type: 'ride_scheduled', ride_id: rideRecord.id, screen: 'ride_tracking' },
        }).catch(() => {});
      } else {
        notifyUser(paxId, {
          title: 'Looking for your chauffeur',
          body: 'Your ride request is live. A driver will confirm shortly.',
          data: { type: 'ride_searching', ride_id: rideRecord.id, screen: 'ride_tracking' },
        }).catch(() => {});
      }
    }

    if (createdStatus !== 'scheduled') {
      notifyNearbyDrivers(
        rideRecord.id,
        finalVehicleType,
        pickupAddr,
      ).catch(() => {});

      // Notify online drivers via Socket.IO — nearest driver first (Uber-style)
      notifyAvailableDrivers(
        rideRecord.id,
        finalVehicleType,
        pickupAddr,
        typeof pLat === 'number' ? pLat : null,
        typeof pLng === 'number' ? pLng : null,
      );
    } else {
      const sa = rideRecord.scheduled_at as string;
      const minsUntil = Math.round((new Date(sa).getTime() - Date.now()) / 60000);
      logger.info(`[RIDES] Scheduled ride ${rideRecord.id} is ${minsUntil} min away — driver dispatch deferred to T-30 cron`);
    }

    // Return ride + PIN so the passenger can share it with the driver
    // Update Stripe PaymentIntent metadata with ride_id so the webhook
      // can link payment events back to this ride.
      if (finalPaymentIntentId && ride) {
        const stripe = getStripe();
        if (stripe) {
          stripe.paymentIntents.update(finalPaymentIntentId, {
            metadata: {
              ride_id:      (ride as Record<string,any>).id,
              passenger_id: passenger_id || '',
            },
          }).catch((piErr: unknown) => {
            logger.warn(`[RIDES] Could not update PI metadata with ride_id:: ${(piErr as Error)?.message}`);
          });
        }
      }

      // Return ride + PIN so the passenger can share it with the driver
      res.json({ ...ride, verification_pin: verificationPin });
  } catch (err: any) {
    logger.error(`[RIDES] create error:: ${err?.message || err}`);
    res.status(500).json({ error: err?.message || 'Failed to create ride' });
  }
});

// --- 2a. GET /api/rides — root handler for filtered queries (e.g. ?type=scheduled&role=driver) ---
// Frontend calls: /api/rides?type=scheduled&role=driver&limit=10
rideRouter.get("/", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const uid   = req.supabaseUid!;
    const role  = req.supabaseRole || 'passenger';
    const type  = (req.query.type as string) || '';
    const qRole = (req.query.role as string) || '';
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));

    if (type === 'scheduled' && qRole === 'driver') {
      // Upcoming scheduled rides assigned to this driver
      if (role !== 'driver' && role !== 'chauffeur') {
        return res.status(403).json({ error: 'Drivers only' });
      }
      const now = new Date().toISOString();
      const { data, error } = await supabaseAdmin
        .from('rides')
        .select('id, pickup, dropoff, scheduled_at, vehicle_type, passenger_id, fare, notes, ride_status, guest_name, valet_booking_ref, passengers, luggage')
        .eq('driver_id', uid)
        .in('ride_status', ['scheduled', 'searching', 'accepted'])
        .gt('scheduled_at', now)
        .order('scheduled_at', { ascending: true })
        .limit(limit);

      if (error) throw error;
      return res.json({ rides: data ?? [] });
    }

    // Default: return the caller's own rides (same as /my)
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const from = (page - 1) * limit;
    const to   = from + limit - 1;
    const { data, error, count } = await supabaseAdmin
      .from('rides')
      .select('*', { count: 'exact' })
      .eq('passenger_id', uid)
      .neq('hidden_by_passenger', true)
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw error;
    return res.json({ rides: data ?? [], total: count ?? 0, page, limit, pages: Math.ceil((count ?? 0) / limit) });
  } catch (err: any) {
    logger.error(`[RIDES] GET / error:: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch rides' });
  }
});

// --- 2. Get rides for the current user ---
rideRouter.get("/my", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const passenger_id = req.supabaseUid;
    const page  = Math.max(1, parseInt(String(req.query.page  ?? '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));
    const from  = (page - 1) * limit;
    const to    = from + limit - 1;

    const { data, error, count } = await supabaseAdmin.from('rides')
      .select('*', { count: 'exact' })
      .eq('passenger_id', passenger_id)
      .neq('hidden_by_passenger', true)
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw error;
    res.json({
      rides: data ?? [],
      total: count ?? 0,
      page,
      limit,
      pages: Math.ceil((count ?? 0) / limit),
    });
  } catch (err: any) {
    logger.error(`[RIDES] my error:: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch rides' });
  }
});

// ── PATCH /api/rides/:id/hide — Passenger soft-deletes one ride from history ──
rideRouter.patch("/:id/hide", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const passenger_id = req.supabaseUid;
    const { id } = req.params;
    const { error } = await supabaseAdmin.from('rides')
      .update({ hidden_by_passenger: true, hidden_at: new Date().toISOString() })
      .eq('id', id)
      .eq('passenger_id', passenger_id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    logger.error(`[RIDES] hide error:: ${err.message}`);
    res.status(500).json({ error: 'Failed to hide ride' });
  }
});

// ── POST /api/rides/hide-all — Passenger hides all their rides from history ───
rideRouter.post("/hide-all", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const passenger_id = req.supabaseUid;
    const { before } = req.body as { before?: string };
    let query = supabaseAdmin.from('rides')
      .update({ hidden_by_passenger: true, hidden_at: new Date().toISOString() })
      .eq('passenger_id', passenger_id)
      .neq('hidden_by_passenger', true);
    if (before) query = query.lt('created_at', before);
    const { error } = await query;
    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    logger.error(`[RIDES] hide-all error:: ${err.message}`);
    res.status(500).json({ error: 'Failed to hide rides' });
  }
});

// ── POST /api/rides/restore-all — Passenger restores all hidden rides ─────────
rideRouter.post("/restore-all", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const passenger_id = req.supabaseUid;
    const { error } = await supabaseAdmin.from('rides')
      .update({ hidden_by_passenger: false, hidden_at: null })
      .eq('passenger_id', passenger_id)
      .eq('hidden_by_passenger', true);
    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    logger.error(`[RIDES] restore-all error:: ${err.message}`);
    res.status(500).json({ error: 'Failed to restore rides' });
  }
});

// --- 2b. Driver ride history (completed + cancelled) ---
rideRouter.get("/driver-history", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const driver_id = req.supabaseUid;
    const role = req.supabaseRole || 'passenger';
    if (role !== 'chauffeur' && role !== 'driver' && role !== 'admin') {
      return res.status(403).json({ error: 'Only chauffeurs can view driver history' });
    }
    const page  = Math.max(1, parseInt(String(req.query.page  ?? '1'), 10));
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '25'), 10)));
    const from  = (page - 1) * limit;
    const to    = from + limit - 1;

    const { data, error, count } = await supabaseAdmin.from('rides')
      .select('id, created_at, ride_status, fare, tip_amount, driver_earnings, surge_multiplier, base_fare_breakdown, vehicle_type, distance_meters, duration_minutes, pickup, dropoff, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, passenger_id, scheduled_at, booking_type, cancel_reason', { count: 'exact' })
      .eq('driver_id', driver_id)
      .in('ride_status', ['completed', 'cancelled'])
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;

    // Enrich with passenger name
    const rides = data ?? [];
    const passengerIds = [...new Set(rides.map((r: Record<string, unknown>) => r.passenger_id as string).filter(Boolean))];
    let passengerMap: Record<string, string> = {};
    if (passengerIds.length > 0) {
      const { data: profiles } = await supabaseAdmin.from('profiles')
        .select('id, first_name, last_name')
        .in('id', passengerIds);
      (profiles ?? []).forEach((p: Record<string, unknown>) => {
        passengerMap[String(p.id)] = [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Passenger';
      });
    }
    const enriched = rides.map((r: Record<string, unknown>) => ({
      ...r,
      passenger_name: passengerMap[String(r.passenger_id)] || 'Passenger',
    }));
    res.json({
      rides: enriched,
      total: count ?? 0,
      page,
      limit,
      pages: Math.ceil((count ?? 0) / limit),
    });
  } catch (err: any) {
    logger.error(`[RIDES] driver-history error:: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch driver history' });
  }
});

// --- 3a. Available rides for drivers — MUST be before /:id ---
// Optional Destination Mode: pass ?destMode=1&homeLat=25.77&homeLng=-80.19
// Vehicle matching: filters rides to only those matching the driver's vehicle category
rideRouter.get("/available", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const role = req.supabaseRole || 'passenger';
    if (role !== 'chauffeur' && role !== 'admin') {
      return res.status(403).json({ error: 'Only drivers can view available rides' });
    }

    // Get driver's vehicle category for matching
    // Uses pool directly — supabaseAdmin REST may not have vehicle in schema cache
    let driverVehicleCategory: string | null = null;
    if (role === 'chauffeur') {
      const pc = await pool.connect();
      try {
        const pr = await pc.query<{ vehicle: Record<string, any> | null }>(
          'SELECT vehicle FROM profiles WHERE id = $1',
          [req.supabaseUid!],
        );
        const vehicle = pr.rows[0]?.vehicle ?? null;
        driverVehicleCategory = vehicle?.category?.toLowerCase() || null;
      } finally {
        pc.release();
      }
    }

    // ── Recency guard ─────────────────────────────────────────────────────────
    // Immediate rides: valid for only 20 minutes after creation.
    //   If a ride hasn't been accepted in 20 min it's considered stale — prevents
    //   old test/abandoned rides from surfacing as new requests.
    // Scheduled rides: only show within 90 minutes of the scheduled pickup time
    //   (with a 30-minute grace window for slightly-late pickups).
    //   A ride booked for tomorrow must NOT appear to drivers today.
    const twentyMinsAgo   = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const thirtyMinsAgo   = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const ninetyMinsFromNow = new Date(Date.now() + 90 * 60 * 1000).toISOString();

    let query = supabaseAdmin.from('rides')
      .select('*')
      .eq('ride_status', 'searching')
      .is('driver_id', null)
      .or(
        `and(scheduled_at.is.null,created_at.gt.${twentyMinsAgo}),` +
        `and(scheduled_at.not.is.null,scheduled_at.gt.${thirtyMinsAgo},scheduled_at.lt.${ninetyMinsFromNow})`
      )
      .order('created_at', { ascending: false })
      .limit(50);

    // Filter by vehicle type using normalized category matching.
    // Driver profile stores category as 'Sedan'/'SUV'/'executive'/'suv'/'concierge'.
    // Ride stores vehicle_type as 'Business Class'/'Premium SUV'/'First Class'/'Van & Sprinter'.
    // We normalize both sides and match via OR patterns so nothing slips through.
    //
    // ── Uber-style vehicle upgrade logic ─────────────────────────────────────
    // A driver with a LARGER vehicle class can accept bookings from SMALLER classes
    // (e.g. SUV driver can serve a sedan booking — more space, same or better comfort).
    // A driver with a SMALLER vehicle class CANNOT accept a larger-class booking
    // (e.g. sedan driver cannot serve an SUV booking — insufficient seats/space).
    //
    // Hierarchy (largest → smallest): Van > First Class > SUV > Sedan
    //
    // IMPORTANT: valet rides (dispatched_by_valet = true) are shown to ALL drivers
    // regardless of vehicle type — the valet picks the driver manually on acceptance.
    if (driverVehicleCategory) {
      const cat = normalizeVehicleCategory(driverVehicleCategory);
      let vehicleFilter: string;

      if (cat === 'signature') {
        // First Class drivers see: First Class + SUV + Sedan (can serve all smaller classes)
        vehicleFilter = [
          'vehicle_type.ilike.%first class%',
          'vehicle_type.ilike.%first-class%',
          'vehicle_type.ilike.%signature%',
          'vehicle_type.ilike.%suv%',
          'vehicle_type.ilike.%business%',
          'vehicle_type.ilike.%executive%',
        ].join(',');
      } else if (cat === 'suv') {
        // SUV drivers see: SUV rides + Sedan (Business Class) rides
        // They CANNOT see First Class (higher tier) or Van (different class)
        vehicleFilter = [
          'vehicle_type.ilike.%suv%',
          'vehicle_type.ilike.%business%',
          'vehicle_type.ilike.%executive%',
        ].join(',');
      } else if (cat === 'executive') {
        // Sedan (executive) drivers see ONLY sedan/business rides — cannot serve SUV
        vehicleFilter = 'vehicle_type.ilike.%business%,vehicle_type.ilike.%executive%';
      } else if (cat === 'van') {
        // Van drivers can serve any class (maximum capacity)
        vehicleFilter = [
          'vehicle_type.ilike.%van%',
          'vehicle_type.ilike.%sprinter%',
          'vehicle_type.ilike.%suv%',
          'vehicle_type.ilike.%business%',
          'vehicle_type.ilike.%executive%',
        ].join(',');
      } else if (cat === 'concierge') {
        vehicleFilter = 'vehicle_type.ilike.%concierge%,vehicle_type.ilike.%luxury%';
      } else {
        vehicleFilter = `vehicle_type.ilike.%${cat}%`;
      }
      // Include valet rides for all drivers (bypasses vehicle-type restriction)
      query = query.or(`dispatched_by_valet.eq.true,${vehicleFilter}`);
    }

    const { data, error } = await query;
    if (error) throw error;

    let rides = (data ?? []) as Array<Record<string, any>>;

    const destMode = req.query.destMode === '1' || req.query.destMode === 'true';
    if (destMode) {
      const homeLat = parseFloat(req.query.homeLat as string);
      const homeLng = parseFloat(req.query.homeLng as string);
      if (isNaN(homeLat) || isNaN(homeLng)) {
        return res.status(400).json({ error: 'Destination mode requires valid homeLat and homeLng parameters.' });
      }
      rides = rides.filter((ride) => {
        const dropoff = ride.dropoff as Record<string, number> | null;
        if (!dropoff?.lat || !dropoff?.lng) return false;
        return haversineKm(homeLat, homeLng, dropoff.lat, dropoff.lng) <= 5;
      });
    }

    // Enrich rides with real passenger profile data (name, phone, rating, avatar)
    const passengerIds = [...new Set(rides.map(r => r.passenger_id).filter(Boolean))];
    if (passengerIds.length > 0) {
      const { data: profiles } = await supabaseAdmin
        .from('profiles')
        .select('id, first_name, last_name, phone, rating, avatar_url, preferences')
        .in('id', passengerIds);
      const pMap = new Map((profiles ?? []).map((p: Record<string, unknown>) => [p.id as string, p]));
      rides = rides.map(r => {
        const p = pMap.get(r.passenger_id as string) as Record<string, unknown> | undefined;
        if (!p) return r;
        return {
          ...r,
          passenger_name: `${p.first_name || ''} ${p.last_name || ''}`.trim() || null,
          passenger_phone: p.phone ?? null,
          passenger_rating: p.rating ?? 5.0,
          passenger_avatar: p.avatar_url ?? null,
          passenger_preferences: p.preferences ?? {},
        };
      });
    }

    res.json(rides.slice(0, 20));
  } catch (err: any) {
    logger.error(`[RIDES] available error:: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch available rides' });
  }
});

// ── GET /api/rides/driver-active — Return driver's current active ride (for app resume) ──
rideRouter.get("/driver-active", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const driver_id = req.supabaseUid;
    const { data: ride, error } = await supabaseAdmin
      .from('rides')
      .select('*')
      .eq('driver_id', driver_id)
      .in('ride_status', ['confirmed', 'in_progress'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!ride) return res.json(null);
    const r = ride as Record<string, any>;
    // Enrich with passenger profile + trust signals (trip count, card verified)
    if (r.passenger_id) {
      const { data: p } = await supabaseAdmin
        .from('profiles')
        .select('first_name, last_name, phone, rating, avatar_url, preferences, stripe_customer_id')
        .eq('id', r.passenger_id)
        .maybeSingle();
      if (p) {
        const prof = p as Record<string, unknown> | undefined;
        r.passenger_name = `${prof.first_name || ''} ${prof.last_name || ''}`.trim() || null;
        r.passenger_phone = prof.phone ?? null;
        r.passenger_rating = prof.rating ?? 5.0;
        r.passenger_avatar = prof.avatar_url ?? null;
        r.passenger_preferences = prof.preferences ?? {};
        r.passenger_card_verified = !!prof.stripe_customer_id;
      }
      // Count completed rides for this passenger (Uber-style trust signal)
      try {
        const { count } = await supabaseAdmin
          .from('rides')
          .select('id', { count: 'exact', head: true })
          .eq('passenger_id', r.passenger_id)
          .eq('ride_status', 'completed');
        r.passenger_trip_count = count ?? 0;
      } catch { r.passenger_trip_count = 0; }
    }
    res.json(r);
  } catch (err: any) {
    logger.error(`[RIDES] driver-active error:: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch active ride' });
  }
});

// --- 3b. Get pending valet rides (for drivers to claim) — MUST be before /:id ---
rideRouter.get("/valet-pending", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('rides')
      .select('id, pickup, dropoff, vehicle_type, guest_name, scheduled_at, valet_booking_ref, created_at, notes, passengers, luggage, valet_user_id, dispatched_by_valet, pickup_pin, passenger_id, fare, distance, ride_status')
      .eq('dispatched_by_valet', true)
      .eq('ride_status', 'searching')
      .is('driver_id', null)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;

    let rides = (data ?? []) as Array<Record<string, any>>;

    // Enrich with passenger profile data (name, phone, avatar, rating) if passenger_id exists
    const passengerIds = [...new Set(rides.map(r => r.passenger_id).filter(Boolean))];
    if (passengerIds.length > 0) {
      const { data: profiles } = await supabaseAdmin
        .from('profiles')
        .select('id, first_name, last_name, phone, rating, avatar_url')
        .in('id', passengerIds);
      const pMap = new Map((profiles ?? []).map((p: Record<string, unknown>) => [p.id as string, p]));
      rides = rides.map(r => {
        const p = pMap.get(r.passenger_id as string) as Record<string, unknown> | undefined;
        if (!p) return r;
        return {
          ...r,
          passenger_name: `${p.first_name || ''} ${p.last_name || ''}`.trim() || null,
          passenger_phone: p.phone ?? null,
          passenger_rating: p.rating ?? null,
          passenger_avatar: p.avatar_url ?? null,
        };
      });
    }

    // Enrich each ride with the valet agent's profile (property name, name, phone)
    const enriched = await Promise.all(
      rides.map(async (ride: Record<string, any>) => {
        if (ride.valet_user_id) {
          const { data: vp } = await supabaseAdmin
            .from('profiles')
            .select('first_name, last_name, phone, property_name')
            .eq('id', ride.valet_user_id as string)
            .maybeSingle();
          if (vp) {
            const valetProfile = vp as Record<string, unknown>;
            return {
              ...ride,
              valet_property_name: valetProfile.property_name || null,
              valet_agent_first_name: valetProfile.first_name || null,
              valet_agent_last_name: valetProfile.last_name || null,
              valet_agent_phone: valetProfile.phone || null,
            };
          }
        }
        return ride;
      })
    );

    res.json(enriched);
  } catch (err: any) {
    logger.error(`[RIDES] valet-pending error:: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch valet rides' });
  }
});

// --- 3c. Get valet's own dispatched ride history — GET /valet-history ---
rideRouter.get("/valet-history", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const valetId = req.supabaseUid;
    const { data, error } = await supabaseAdmin
      .from('rides')
      .select('id, pickup, dropoff, vehicle_type, guest_name, scheduled_at, valet_booking_ref, created_at, pickup_pin, ride_status, driver_id, payment_method, notes, valet_commission_paid, passengers, luggage')
      .eq('valet_user_id', valetId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    const rides = (data ?? []) as Array<Record<string, any>>;

    // Enrich rides that have an assigned driver with their profile info
    const driverIds = [...new Set(rides.map(r => r.driver_id).filter(Boolean))] as string[];
    let driverMap: Record<string, Record<string, any>> = {};
    if (driverIds.length > 0) {
      // Use pool directly — supabaseAdmin REST may not have vehicle in schema cache
      const pc = await pool.connect();
      try {
        const pr = await pc.query<Record<string, any>>(
          'SELECT id, first_name, last_name, avatar_url, rating, phone, vehicle FROM profiles WHERE id = ANY($1)',
          [driverIds],
        );
        for (const p of pr.rows) {
          driverMap[p.id] = p;
        }
      } finally {
        pc.release();
      }
    }

    const enriched = rides.map(r => {
      const driver = r.driver_id ? driverMap[r.driver_id] : null;
      const v = driver?.vehicle ?? {};
      return {
        ...r,
        driver: driver ? {
          name: [driver.first_name, driver.last_name].filter(Boolean).join(' ') || null,
          avatar_url: driver.avatar_url || null,
          rating: driver.rating ?? null,
          phone: driver.phone || null,
          vehicle_make: v.make || null,
          vehicle_model: v.model || null,
          vehicle_year: v.year || null,
          vehicle_color: v.color || null,
          vehicle_plate: v.plate || null,
        } : null,
      };
    });

    res.json(enriched);
  } catch (err: any) {
    logger.error(`[RIDES] valet-history error:: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch valet history' });
  }
});

// --- 3. Get ride by ID (only own rides) ---
rideRouter.get("/:id", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin.from('rides')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Ride not found' }); return; }

    const ride = data as Record<string, unknown>;
    const uid = req.supabaseUid;
    const role = req.supabaseRole || 'passenger';

    const isDriver = role === 'chauffeur' || role === 'driver';
    const isSearching = ride.ride_status === 'searching';

    // Only the passenger, assigned driver, admin, or any driver (for searching rides) can view a ride
    if (
      role !== 'admin' &&
      ride.passenger_id !== uid &&
      ride.driver_id !== uid &&
      !(isDriver && isSearching)
    ) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    // For valet-dispatched rides, enrich with the valet agent's profile so drivers
    // see the real property name, agent name, and desk phone number.
    if (ride.dispatched_by_valet && ride.valet_user_id) {
      const { data: valetProfile } = await supabaseAdmin
        .from('profiles')
        .select('first_name, last_name, phone, property_name')
        .eq('id', ride.valet_user_id as string)
        .maybeSingle();
      if (valetProfile) {
        const vp = valetProfile as Record<string, unknown>;
        (ride as Record<string, unknown>).valet_property_name = vp.property_name || null;
        (ride as Record<string, unknown>).valet_agent_first_name = vp.first_name || null;
        (ride as Record<string, unknown>).valet_agent_last_name = vp.last_name || null;
        (ride as Record<string, unknown>).valet_agent_phone = vp.phone || null;
      }
    }

    // ── Passenger PIN visibility ─────────────────────────────────────────────
    // Show pickup_pin to the passenger ONLY while the driver is on the way or has arrived.
    // Hide it before driver acceptance (no point) and after the trip starts (consumed).
    // This is the URBONT verification code: passenger reads it aloud, driver enters to start.
    if (!isDriver && role !== 'admin') {
      const visibleStatuses = ['confirmed', 'driver_arrived'];
      if (!visibleStatuses.includes(ride.ride_status as string)) {
        delete (ride as Record<string, unknown>).pickup_pin;
      }
    }

    // Enrich with driver profile when a passenger fetches a confirmed/active ride.
    // Direct Supabase queries from the client are blocked by RLS, so the server enriches here.
    const isPassenger = !isDriver && role !== 'admin';
    if (isPassenger && ride.driver_id && !ride.driver_name) {
      const { data: driverProfile } = await supabaseAdmin
        .from('profiles')
        .select('first_name, last_name, avatar_url, rating, vehicle')
        .eq('id', ride.driver_id as string)
        .maybeSingle();
      if (driverProfile) {
        const dp = driverProfile as Record<string, unknown>;
        const dv = (dp.vehicle as Record<string, unknown>) ?? {};
        (ride as Record<string, unknown>).driver_name =
          [`${dp.first_name || ''}`, `${dp.last_name || ''}`].join(' ').trim() || null;
        (ride as Record<string, unknown>).driver_avatar_url = dp.avatar_url ?? null;
        (ride as Record<string, unknown>).driver_rating = (dp.rating as number) ?? null;
        (ride as Record<string, unknown>).driver_vehicle_make   = dv.make   ?? null;
        (ride as Record<string, unknown>).driver_vehicle_model  = dv.model  ?? null;
        (ride as Record<string, unknown>).driver_vehicle_year   = dv.year   ?? null;
        (ride as Record<string, unknown>).driver_vehicle_color  = dv.color  ?? null;
        (ride as Record<string, unknown>).driver_vehicle_plate  = dv.plate  ?? null;
        (ride as Record<string, unknown>).driver_vehicle_photo  = dv.vehicle_photo_url ?? null;
      }
    }

    // Enrich with real passenger profile data when a driver fetches a searching/available ride.
    // The rides table stores passenger_id but not the profile fields — we join here so the
    // driver's IncomingModal shows real name, photo, and rating instead of nulls.
    if (isDriver && ride.passenger_id && !ride.passenger_name) {
      const { data: passengerProfile } = await supabaseAdmin
        .from('profiles')
        .select('first_name, last_name, phone, rating, avatar_url, preferences, stripe_customer_id')
        .eq('id', ride.passenger_id as string)
        .maybeSingle();
      if (passengerProfile) {
        const p = passengerProfile as Record<string, unknown>;
        (ride as Record<string, unknown>).passenger_name =
          [`${p.first_name || ''}`, `${p.last_name || ''}`].join(' ').trim() || null;
        (ride as Record<string, unknown>).passenger_phone = p.phone ?? null;
        (ride as Record<string, unknown>).passenger_rating = (p.rating as number) ?? null;
        (ride as Record<string, unknown>).passenger_avatar = p.avatar_url ?? null;
        (ride as Record<string, unknown>).passenger_preferences = p.preferences ?? {};
        (ride as Record<string, unknown>).passenger_card_verified = !!p.stripe_customer_id;
      }
      // Trust signal: total completed rides for this passenger
      try {
        const { count } = await supabaseAdmin
          .from('rides')
          .select('id', { count: 'exact', head: true })
          .eq('passenger_id', ride.passenger_id as string)
          .eq('ride_status', 'completed');
        (ride as Record<string, unknown>).passenger_trip_count = count ?? 0;
      } catch { (ride as Record<string, unknown>).passenger_trip_count = 0; }
    }

    res.json(ride);
  } catch (err: any) {
    logger.error(`[RIDES] get error:: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch ride' });
  }
});

// --- 4. Cancel a ride ---
// Uber-style logic:
//   searching  → release hold (cancel PI), zero charge
//   accepted   → $5 cancellation fee if >2 min after driver was assigned, else zero charge
//   in_progress → cannot cancel (blocked on client)
rideRouter.post("/cancel/:id", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { reason, cancelledBy } = req.body;
    const { data: ride, error: fetchErr } = await supabaseAdmin.from('rides')
      .select('fare, scheduled_at, ride_status, payment_intent_id, passenger_id, driver_id, updated_at, accepted_at')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchErr || !ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    const rideStatus = (ride as RideRow).ride_status;
    if (rideStatus === 'completed' || rideStatus === 'cancelled') {
      return res.status(400).json({ error: 'Ride cannot be cancelled in its current state' });
    }
    if (rideStatus === 'in_progress') {
      return res.status(400).json({ error: 'Cannot cancel a ride that is already in progress' });
    }

    // ── Driver-initiated cancellation: reassign to searching ─────────────────
    // When a driver cancels a ride they accepted, we reset the ride to 'searching'
    // so another available driver can pick it up — exactly like Uber/Lyft.
    // No Stripe charges are applied to the passenger.
    if (cancelledBy === 'driver' && ['confirmed', 'accepted', 'driver_arrived'].includes(rideStatus)) {
      const { error: resetErr } = await supabaseAdmin.from('rides').update({
        ride_status: 'searching',
        driver_id: null,
        accepted_at: null,
        updated_at: new Date().toISOString(),
      }).eq('id', req.params.id);

      if (resetErr) throw resetErr;

      const passengerIdStr = String((ride as RideRow).passenger_id || '');
      const driverIdStr    = String((ride as RideRow).driver_id || '');

      // Notify passenger via socket: driver cancelled but we're searching again
      broadcastRideStatus(req.params.id, 'searching', {
        driverCancelled: true,
        reason: reason || 'driver_cancelled',
        passengerId: passengerIdStr,
        driverId: driverIdStr,
      });

      // Push notification to passenger
      notifyUser(passengerIdStr, {
        title: 'Finding you a new chauffeur',
        body: 'Your driver had to cancel. We\'re searching for another chauffeur right now.',
        data: { type: 'driver_cancelled_reassigning', ride_id: req.params.id, screen: 'ride_tracking' },
      }).catch(() => {});

      // Optionally re-broadcast to available drivers so they see this ride again
      try {
        notifyAvailableDrivers(
          req.params.id,
          (ride as RideRow).vehicle_type || 'executive',
          (ride as RideRow).pickup_address || 'Miami, FL',
          (ride as RideRow).pickup_lat ?? null,
          (ride as RideRow).pickup_lng ?? null,
        );
      } catch {}

      logger.info(`[RIDES] Driver ${driverIdStr} cancelled ride ${req.params.id} — reset to searching for reassignment`);
      return res.json({ success: true, reassigning: true, cancellationFee: 0 });
    }

    const stripe = getStripe();
    const piId = (ride as RideRow).payment_intent_id ?? undefined;
    let stripeChargeId: string | null = null;
    let cancellationFee = 0;

    if (stripe && piId) {
      try {
        const pi = await stripe.paymentIntents.retrieve(piId);

        if (rideStatus === 'searching' || rideStatus === 'scheduled') {
          // ── No driver dispatched → full release, zero charge ──────────────
          // 'scheduled' rides have no driver assigned (they haven't been dispatched yet)
          // so they always get a full release with no cancellation fee.
          if (pi.status === 'requires_capture') {
            await stripe.paymentIntents.cancel(piId);
          } else if (pi.status === 'succeeded') {
            // Already captured (old automatic flow) → full refund
            await stripe.refunds.create({ payment_intent: piId });
          }
          // requires_payment_method / canceled → nothing to do

        } else if (rideStatus === 'accepted' || rideStatus === 'confirmed') {
          // ── Driver was dispatched ─────────────────────────────────────────
          // Grace period: CANCELLATION_GRACE_MINS from when the driver accepted (accepted_at)
          const acceptedTimestamp = (ride as RideRow).accepted_at || (ride as RideRow).updated_at || Date.now();
          const driverAssignedAt = new Date(acceptedTimestamp).getTime();
          const minutesSinceAssigned = (Date.now() - driverAssignedAt) / 60000;
          const withinGrace = minutesSinceAssigned <= CANCELLATION_GRACE_MINS;

          if (withinGrace) {
            // Within grace → release hold, no charge
            if (pi.status === 'requires_capture') {
              await stripe.paymentIntents.cancel(piId);
            } else if (pi.status === 'succeeded') {
              await stripe.refunds.create({ payment_intent: piId });
            }
          } else {
            // Outside grace → charge CANCELLATION_FEE ($10), release the rest
            cancellationFee = CANCELLATION_FEE;
            const cancelFeeCents = Math.round(CANCELLATION_FEE * 100);

            if (pi.status === 'requires_capture') {
              // Capture only the cancellation fee, cancel the rest
              const captureAmount = Math.min(cancelFeeCents, pi.amount);
              await stripe.paymentIntents.capture(piId, { amount_to_capture: captureAmount });
              stripeChargeId = piId;
            } else if (pi.status === 'succeeded') {
              // Already fully captured → refund everything except the cancellation fee
              const refundAmount = Math.max(0, pi.amount_received - cancelFeeCents);
              if (refundAmount > 0) {
                await stripe.refunds.create({ payment_intent: piId, amount: refundAmount });
              }
              stripeChargeId = piId;
            }
          }
        }
      } catch (stripeErr: unknown) {
        logger.error(`[RIDES] Stripe cancel handling failed (non-blocking):: ${errMsg(stripeErr)}`);
      }
    }

    // Legacy cancellation fee path (pre-booked/scheduled rides) — kept for edge cases
    const fee = cancellationFee || 0;

    let { error: cancelErr } = await supabaseAdmin.from('rides').update({
      ride_status: 'cancelled',
      cancel_reason: reason || null,
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id);

    // Fallback: if extended columns (cancel_reason, cancelled_at) don't exist
    if (cancelErr && (
      String((cancelErr as Error)?.message).includes('column') ||
      String((cancelErr as Error)?.message).includes('schema cache') ||
      (cancelErr as NodeJS.ErrnoException)?.code === '42703' ||
      (cancelErr as NodeJS.ErrnoException)?.code === 'PGRST204'
    )) {
      const baseCancel = await supabaseAdmin.from('rides').update({
        ride_status: 'cancelled',
        updated_at: new Date().toISOString(),
      }).eq('id', req.params.id);
      cancelErr = baseCancel.error;
    }

    if (cancelErr) throw cancelErr;

    const ridePassengerId = String((ride as RideRow).passenger_id || '');
    const rideDriverId    = String((ride as RideRow).driver_id || '');

    // ── Socket broadcast: notify ALL participants instantly ───────────────────
    // This is the primary real-time signal for the driver dashboard and any
    // passenger screens (ConfirmedScreen, TrackingScreen) still open.
    broadcastRideStatus(req.params.id, 'cancelled', {
      reason:      reason || 'passenger_cancelled',
      passengerId: ridePassengerId,
      driverId:    rideDriverId,
    });

    // ── Push notification → driver (if assigned) ─────────────────────────────
    if (rideDriverId) {
      notifyUser(rideDriverId, {
        title: 'Ride Cancelled',
        body: 'The passenger has cancelled this ride.',
        data: { type: 'ride_cancelled', ride_id: req.params.id, screen: 'driver_home' },
      }).catch(() => {});
    }

    res.json({ success: true, cancellationFee: fee, stripeChargeId });
  } catch (err: any) {
    logger.error(`[RIDES] cancel error:: ${err.message}`);
    res.status(500).json({ error: 'Cancellation failed' });
  }
});

// --- 5. Driver check-in (confirms pickup location match) ---
rideRouter.post("/driver-checkin/:id", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { driverLat, driverLng } = req.body;
    const { data: ride, error } = await supabaseAdmin.from('rides')
      .select('pickup, scheduled_at, driver_id, ride_status')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error || !ride) return res.status(404).json({ error: 'Ride not found' });

    // Ownership: only the assigned driver may call check-in
    const rChk = ride as Record<string, unknown>;
    if (rChk.driver_id !== req.supabaseUid) {
      return res.status(403).json({ error: 'Access denied. You are not the assigned driver for this ride.' });
    }
    if (!['confirmed', 'driver_arrived'].includes(rChk.ride_status as string)) {
      return res.status(409).json({ error: 'Ride is not in a state that allows check-in.' });
    }

    const pickup = (ride as RideRow).pickup;
    const pickupCoords = pickup && typeof pickup === 'object' ? pickup : null;
    if (pickupCoords?.lat && pickupCoords?.lng && driverLat && driverLng) {
      const isNearby = isDriverNearby(driverLat, driverLng, pickupCoords.lat, pickupCoords.lng);
      if (!isNearby) {
        return res.status(400).json({ error: 'Driver is not near pickup location', code: 'NOT_NEAR_PICKUP' });
      }
    }

    const scheduledAt = (ride as RideRow).scheduled_at;
    if (scheduledAt) {
      const diffMinutes = (new Date(scheduledAt).getTime() - Date.now()) / 60000;
      if (diffMinutes > 30) {
        return res.status(400).json({ error: 'Too early to check in. Please wait closer to the scheduled time.', code: 'TOO_EARLY' });
      }
    }

    res.json({ success: true, checkedIn: true });
  } catch (err: any) {
    logger.error(`[RIDES] checkin error:: ${err.message}`);
    res.status(500).json({ error: 'Check-in failed' });
  }
});

// --- 6. Valet dispatch — POST /valet-dispatch ---
rideRouter.post("/valet-dispatch", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const {
      guestName, pickup, destination, vehicleType,
      paymentMethod, scheduledAt, notes, skipPin,
      passengers, luggage, pickupLat, pickupLng, dropoffLat, dropoffLng,
      vehiclePrice, distanceMiles: valetMiles, durationMinutes: valetDuration,
    } = req.body;

    if (!pickup || !vehicleType || !destination) {
      return res.status(400).json({ error: 'Missing required fields: pickup, destination, vehicleType' });
    }

    const gpsLat = typeof pickupLat === 'number' ? pickupLat : null;
    const gpsLng = typeof pickupLng === 'number' ? pickupLng : null;
    const gpsDstLat = typeof dropoffLat === 'number' ? dropoffLat : null;
    const gpsDstLng = typeof dropoffLng === 'number' ? dropoffLng : null;
    const pmMethod = (paymentMethod || 'cash') as string;

    // ── Valet $10 surcharge ──────────────────────────────────────────────────
    // Parse the base fare sent by the dashboard (e.g. "$22.50" → 22.50)
    const rawPrice = typeof vehiclePrice === 'number'
      ? vehiclePrice
      : parseFloat(String(vehiclePrice ?? '').replace(/[^0-9.]/g, '')) || 0;
    const baseFare        = rawPrice > 0 ? rawPrice : 0;
    const valetSurcharge  = VALET_COMMISSION_USD;                  // $10
    const totalFare       = baseFare > 0 ? +(baseFare + valetSurcharge).toFixed(2) : null;

    // For cash rides: the driver collects the full fare in cash (including the $10).
    // We record platform_fee_amount = $10 so we know how much the driver owes the platform.
    const platformFee = pmMethod === 'cash' && totalFare ? valetSurcharge : 0;

    // Fare breakdown for receipts — uses FARE_RULES model to match what valet dashboard shows
    const valetFareBreakdown = (typeof valetMiles === 'number' && typeof valetDuration === 'number')
      ? calculateFareFromRules({ vehicleType, distanceMiles: valetMiles, durationMinutes: valetDuration })
      : null;

    const pin = skipPin ? null : String(randomInt(1000, 10000));
    const valetId = req.supabaseUid;
    const bookingRef = `URB-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    const now = new Date().toISOString();

    const pickupPayload = typeof pickup === 'string'
      ? { address: pickup, ...(gpsLat !== null ? { lat: gpsLat, lng: gpsLng } : {}) }
      : pickup;

    const dropoffPayload = typeof destination === 'string'
      ? { address: destination, ...(gpsDstLat !== null ? { lat: gpsDstLat, lng: gpsDstLng } : {}) }
      : destination;

    let { data: ride, error: insertErr } = await supabaseAdmin.from('rides').insert({
      passenger_id:         valetId,
      valet_user_id:        valetId,
      vehicle_type:         vehicleType,
      pickup:               pickupPayload,
      dropoff:              dropoffPayload,
      fare:                 totalFare,
      locked_fare:          totalFare,
      valet_surcharge:      valetSurcharge,
      platform_fee_amount:  platformFee || null,
      payment_method:       pmMethod,
      notes:                notes || null,
      scheduled_at:         scheduledAt || null,
      ride_status:          'searching',
      pickup_pin:           pin,
      dispatched_by_valet:  true,
      valet_booking_ref:    bookingRef,
      guest_name:           guestName || null,
      passengers:           typeof passengers === 'number' ? passengers : 1,
      luggage:              typeof luggage === 'number' ? luggage : 0,
      pickup_lat:           gpsLat,
      pickup_lng:           gpsLng,
      dropoff_lat:          gpsDstLat,
      dropoff_lng:          gpsDstLng,
      distance_miles:       typeof valetMiles === 'number' ? valetMiles : null,
      base_fare_breakdown:  valetFareBreakdown ? JSON.stringify(valetFareBreakdown) : null,
      created_at:           now,
      updated_at:           now,
    }).select().single();

    // Handle schema-cache miss — retry with base columns + raw SQL patch
    if (insertErr) {
      const isSchemaErr = (insertErr as NodeJS.ErrnoException)?.code === 'PGRST204' ||
        String((insertErr as Error)?.message).includes('column') ||
        String((insertErr as Error)?.message).includes('schema cache');
      if (!isSchemaErr) throw insertErr;

      logger.warn('[RIDES] valet-dispatch: extended columns missing, patching via SQL');
      const baseInsert = await supabaseAdmin.from('rides').insert({
        passenger_id: valetId, valet_user_id: valetId, vehicle_type: vehicleType,
        pickup: pickupPayload,
        dropoff: dropoffPayload,
        fare: totalFare, payment_method: pmMethod, notes: notes || null,
        scheduled_at: scheduledAt || null, ride_status: 'searching', pickup_pin: pin,
        dispatched_by_valet: true, valet_booking_ref: bookingRef, guest_name: guestName || null,
        pickup_lat: gpsLat, pickup_lng: gpsLng,
        dropoff_lat: gpsDstLat, dropoff_lng: gpsDstLng,
        created_at: now, updated_at: now,
        platform_fee_amount: platformFee || null,
      }).select().single();
      if (baseInsert.error) throw baseInsert.error;
      // Assign fallback ride so the success path below can use it
      ride = baseInsert.data as typeof ride;
      const rideId = (ride as RideRow).id;
      // Patch extended columns via direct SQL
      await pool.query(
        `UPDATE rides SET locked_fare = $1, valet_surcharge = $2, passengers = $3, luggage = $4 WHERE id = $5`,
        [totalFare, valetSurcharge, typeof passengers === 'number' ? passengers : 1, typeof luggage === 'number' ? luggage : 0, rideId]
      );
    }

    if (!ride) {
      // Should never reach here — kept as a safety net
      return res.status(500).json({ error: 'Failed to dispatch valet ride' });
    }

    // Notify all online drivers — same as regular rides
    const pickupAddr = typeof pickup === 'string' ? pickup : (pickup?.address || 'Location');
    notifyAvailableDrivers(ride.id, vehicleType, pickupAddr, gpsLat, gpsLng);

    logger.info(`[VALET_DISPATCH] Ride ${ride.id} | base $${baseFare} + surcharge $${valetSurcharge} = total $${totalFare} | method: ${pmMethod} | cash owed by driver: $${platformFee}`);

    res.json({ ride, pin, bookingRef, baseFare, valetSurcharge, totalFare });
  } catch (err: any) {
    // Surface the *actual* DB / Supabase error so the operator can see what's broken
    // instead of staring at a generic "Failed to dispatch valet ride" forever.
    const code = err?.code || err?.status;
    const details = err?.details || err?.hint || '';
    logger.error({
      message: err?.message,
      code,
      details,
      stack: err?.stack?.split('\n').slice(0, 5).join('\n'),
    }, '[RIDES] valet-dispatch error');
    // Common Postgres / Supabase error codes → friendlier messages
    let userMessage = 'Failed to dispatch valet ride';
    if (code === '42703' || String(err?.message || '').toLowerCase().includes('column')) {
      userMessage = `Database schema mismatch (${err?.message || 'missing column'}). Restart the server so migrations can run.`;
    } else if (code === '23505') {
      userMessage = 'Duplicate booking reference. Please retry.';
    } else if (code === '23503') {
      userMessage = 'Invalid reference (valet user not found). Please sign out and sign back in.';
    } else if (code === 'PGRST301' || code === 401) {
      userMessage = 'Session expired. Please sign out and sign back in.';
    } else if (err?.message) {
      // Echo the raw message so the operator can debug instead of staring at a wall
      userMessage = `Dispatch error: ${err.message}`;
    }
    res.status(500).json({ error: userMessage, code, details });
  }
});


// --- 8. Verify PIN and activate valet ride — POST /:id/verify-pin ---
rideRouter.post("/:id/verify-pin", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ error: 'PIN is required' });

    const rideId = req.params.id;

    // Brute-force protection: lock out after 5 wrong attempts for 15 minutes
    const nowMs = Date.now();
    const pinTrack = pinAttemptTracker.get(rideId);
    if (pinTrack && nowMs < pinTrack.resetAt && pinTrack.count >= MAX_PIN_ATTEMPTS) {
      const retryAfterSec = Math.ceil((pinTrack.resetAt - nowMs) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'Too many incorrect PIN attempts. Try again later.', code: 'PIN_LOCKED', retryAfterSeconds: retryAfterSec });
    }

    const { data: rideRow, error: fetchErr2 } = await supabaseAdmin
      .from('rides')
      .select('pickup_pin, dispatched_by_valet, ride_status, driver_id, valet_user_id, valet_commission_paid, passenger_id, payment_method, valet_surcharge')
      .eq('id', rideId)
      .maybeSingle();
    if (fetchErr2) throw fetchErr2;
    const r = rideRow as Record<string, any> | null;

    if (!r) return res.status(404).json({ error: 'Ride not found' });

    // Option A: PIN is required for ALL rides (valet + regular).
    // The PIN is generated server-side at booking time and shown to the passenger
    // until the trip starts; the driver must enter it to advance to in_progress.
    if (!r.pickup_pin) {
      return res.status(400).json({ error: 'This ride does not require a PIN' });
    }

    if (r.ride_status !== 'searching' && r.ride_status !== 'confirmed' && r.ride_status !== 'driver_arrived') {
      return res.status(400).json({ error: 'Ride is no longer available' });
    }

    if (String(r.pickup_pin) !== String(pin).trim()) {
      // Track failed attempt
      const nowTrack = Date.now();
      const existing = pinAttemptTracker.get(rideId);
      if (!existing || nowTrack >= existing.resetAt) {
        pinAttemptTracker.set(rideId, { count: 1, resetAt: nowTrack + PIN_LOCKOUT_MS });
      } else {
        pinAttemptTracker.set(rideId, { count: existing.count + 1, resetAt: existing.resetAt });
      }
      return res.status(401).json({ error: 'Incorrect PIN. Please verify with the concierge.', code: 'WRONG_PIN' });
    }

    const driverId = req.supabaseUid;
    // Clear brute-force tracker on successful PIN
    pinAttemptTracker.delete(rideId);
    const resolvedDriverId = r.driver_id || driverId;
    const { error: updateErr2 } = await supabaseAdmin
      .from('rides')
      .update({ driver_id: resolvedDriverId, ride_status: 'in_progress', pickup_pin: null, started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', rideId);
    if (updateErr2) throw updateErr2;

    // Instant Socket.IO push so the passenger's TrackingScreen transitions without polling delay
    broadcastRideStatus(rideId, 'in_progress', {
      driverId: resolvedDriverId,
      passengerId: r.passenger_id,
    });

    // ── Valet commission ($10) via Stripe Transfer ────────────────────────────
    // For CARD rides: the $10 surcharge is already included in the passenger fare.
    //   → Stripe transfer of $10 to valet comes from the platform's application fee.
    // For CASH rides: the driver collects the full fare in cash (incl. $10 surcharge).
    //   → Platform pays $10 to valet via Stripe Transfer.
    //   → Driver owes $10 to the platform (tracked via platform_fee_amount on the ride).
    let valetCommissionResult: {
      paid: boolean;
      transferId?: string;
      error?: string;
      cashDebitRequired?: boolean;
      cashDebitAmount?: number;
    } = { paid: false };

    const valetUserId    = r.valet_user_id    as string | null;
    const alreadyPaid    = r.valet_commission_paid as boolean;
    const isCashRide     = (r.payment_method as string) === 'cash';
    const surchargeAmt   = Number(r.valet_surcharge ?? VALET_COMMISSION_USD);

    if (valetUserId && !alreadyPaid) {
      try {
        const { data: valetProfile } = await supabaseAdmin
          .from('profiles')
          .select('stripe_account_id')
          .eq('id', valetUserId)
          .maybeSingle();

        const valetAccountId = (valetProfile as { stripe_account_id?: string } | null)?.stripe_account_id;

        if (valetAccountId) {
          const stripe = getStripe();
          if (stripe) {
            const transfer = await stripe.transfers.create({
              amount: surchargeAmt * 100,
              currency: 'usd',
              destination: valetAccountId,
              metadata: {
                ride_id:        rideId,
                valet_user_id:  valetUserId,
                type:           'valet_commission',
                payment_method: isCashRide ? 'cash' : 'card',
              },
            });

            await supabaseAdmin.from('rides').update({
              valet_commission_paid:           true,
              valet_commission_transfer_id:    transfer.id,
            }).eq('id', rideId);

            valetCommissionResult = { paid: true, transferId: transfer.id };

            if (isCashRide) {
              // For cash rides: log that the driver owes $surchargeAmt to the platform.
              // platform_fee_amount was already set at dispatch time.
              // Deduct from driver_stats.total_earned so the driver wallet shows the debt.
              await supabaseAdmin.rpc('adjust_driver_cash_debit', {
                p_driver_id: resolvedDriverId,
                p_amount:    surchargeAmt,
              }).then(({ error: rpcErr }) => {
                if (rpcErr) logger.warn(`[VALET_COMMISSION] driver_stats debit RPC failed (non-fatal): ${rpcErr.message}`);
              });
              valetCommissionResult.cashDebitRequired = true;
              valetCommissionResult.cashDebitAmount   = surchargeAmt;
              logger.info(`[VALET_COMMISSION] CASH ride — $${surchargeAmt} transferred to valet ${valetAccountId}; driver ${resolvedDriverId} owes $${surchargeAmt} to platform`);
            } else {
              logger.info(`[VALET_COMMISSION] CARD ride — $${surchargeAmt} transferred to valet ${valetAccountId} — transfer: ${transfer.id}`);
            }
          }
        } else {
          logger.info(`[VALET_COMMISSION] Valet ${valetUserId} has no Stripe account — commission skipped`);
          valetCommissionResult = { paid: false, error: 'valet_no_stripe_account' };
        }
      } catch (commErr: unknown) {
        logger.error(`[VALET_COMMISSION] Transfer failed:: ${errMsg(commErr)}`);
        valetCommissionResult = { paid: false, error: errMsg(commErr) };
      }
    }

    res.json({
      success:         true,
      message:         'PIN verified. Ride activated.',
      valetCommission: valetCommissionResult,
    });
  } catch (err: any) {
    logger.error(`[RIDES] verify-pin error:: ${err.message}`);
    res.status(500).json({ error: 'PIN verification failed' });
  }
});

// --- 8b. Valet card checkout — POST /:id/valet-card-checkout ---
// Driver-initiated. For valet rides where the passenger is paying by card.
// Creates a Stripe Checkout Session (Apple Pay / Google Pay / card) with:
//   - application_fee_amount = URBONT 10% (of fare) + valet $10  (kept by platform)
//   - transfer_data.destination = driver's connected account     (driver gets the rest)
// On payment_intent.succeeded the webhook then issues a Transfer of $10 from the
// platform balance to the valet's connected account, and marks the ride as paid.
rideRouter.post('/:id/valet-card-checkout', requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const rideId = req.params.id;
    const driverId = req.supabaseUid;

    const { data: ride, error: rideErr } = await supabaseAdmin
      .from('rides')
      .select('id, driver_id, ride_status, payment_method, dispatched_by_valet, valet_user_id, valet_surcharge, locked_fare, fare, payment_intent_id, guest_name, valet_booking_ref')
      .eq('id', rideId)
      .maybeSingle();

    if (rideErr) throw rideErr;
    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    const r = ride as Record<string, any>;

    if (r.driver_id && r.driver_id !== driverId) {
      return res.status(403).json({ error: 'Only the assigned driver can charge this ride' });
    }
    if (r.payment_method !== 'card') {
      return res.status(400).json({ error: 'Ride is not flagged for card payment' });
    }
    if (!['confirmed', 'in_progress'].includes(r.ride_status)) {
      return res.status(400).json({ error: 'Ride must be in progress to charge' });
    }
    if (r.payment_intent_id) {
      return res.status(409).json({ error: 'A payment is already in progress for this ride' });
    }

    // Resolve driver Stripe Connect account
    const { data: driverProfile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_account_id, stripe_connect_status')
      .eq('id', driverId)
      .maybeSingle();

    const driverAccountId = (driverProfile as { stripe_account_id?: string; stripe_connect_status?: string } | null)?.stripe_account_id;
    if (!driverAccountId) {
      return res.status(400).json({ error: 'Driver has no Stripe Connect account' });
    }
    if ((driverProfile as { stripe_account_id?: string; stripe_connect_status?: string } | null)?.stripe_connect_status !== 'active') {
      return res.status(400).json({ error: 'Driver Stripe Connect account is not active' });
    }

    // Compute amounts. The valet surcharge ONLY applies if the ride was actually
    // dispatched by a valet — driver-created rides have no $10 add-on.
    const isValetRide    = !!r.dispatched_by_valet && !!r.valet_user_id;
    const valetSurcharge = isValetRide ? Number(r.valet_surcharge ?? VALET_COMMISSION_USD) : 0;
    const totalFareDb    = Number(r.locked_fare ?? r.fare ?? 0);
    const fareNoValet    = Math.max(0, totalFareDb - valetSurcharge);           // driver-owned portion
    const platformPct    = 0.10;
    const platformCut    = +(fareNoValet * platformPct).toFixed(2);             // URBONT 10%
    const totalToCharge  = +(fareNoValet + valetSurcharge).toFixed(2);          // total billed

    if (totalToCharge < 1) {
      return res.status(400).json({ error: 'Fare too low to charge' });
    }

    // application_fee = URBONT 10% + valet surcharge (platform keeps both for now;
    // valet leg is then transferred out by the webhook).
    const applicationFeeCents = Math.round((platformCut + valetSurcharge) * 100);
    const totalCents          = Math.round(totalToCharge * 100);

    const origin = (req.headers.origin as string) || process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    const guestName = (r.guest_name as string) || 'Passenger';
    const bookingRef = (r.valet_booking_ref as string) || rideId.slice(0, 8);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      automatic_tax: { enabled: true },
      billing_address_collection: 'auto',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: totalCents,
          tax_behavior: 'exclusive',
          product_data: {
            name: `URBONT Ride · ${bookingRef}`,
            description: `Chauffeur service for ${guestName}`,
            tax_code: 'txcd_20030000',
          },
        },
      }],
      payment_intent_data: {
        application_fee_amount: applicationFeeCents,
        transfer_data: { destination: driverAccountId },
        metadata: {
          ride_id:        rideId,
          driver_id:      driverId,
          valet_user_id:  (r.valet_user_id as string) || '',
          valet_surcharge_cents: String(Math.round(valetSurcharge * 100)),
          platform_fee_cents:    String(Math.round(platformCut * 100)),
          type: 'valet_card_checkout',
        },
      },
      success_url: `${origin}/driver?payment=success&ride=${rideId}`,
      cancel_url:  `${origin}/driver?payment=cancelled&ride=${rideId}`,
    });

    // Persist the PI so we don't double-charge
    if (session.payment_intent) {
      await supabaseAdmin.from('rides').update({
        payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id,
        updated_at: new Date().toISOString(),
      }).eq('id', rideId);
    }

    return res.json({
      url: session.url,
      sessionId: session.id,
      total: totalToCharge,
      breakdown: {
        fare: fareNoValet,
        valetSurcharge,
        platformFee: platformCut,
        driverNet: +(fareNoValet - platformCut).toFixed(2),
      },
    });
  } catch (err: any) {
    logger.error(`[RIDES] valet-card-checkout error:: ${err.message}`);
    res.status(500).json({ error: err.message || 'Failed to create checkout' });
  }
});

// --- 8c. Driver-created ride — POST /driver-create ---
// The driver creates a ride directly with the passenger in front of them
// (walk-up, hotel pickup, friend, etc). The ride is auto-assigned to the
// driver and starts in `in_progress`. No PIN. No valet surcharge.
// Payment defaults to cash; if 'card', the driver can then call
// /:id/valet-card-checkout to collect via Stripe.
rideRouter.post('/driver-create', requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const driverId = req.supabaseUid;
    const callerRole = req.supabaseRole || '';
    if (!['chauffeur', 'driver', 'admin'].includes(callerRole)) {
      return res.status(403).json({ error: 'Only drivers may create rides directly.' });
    }
    const {
      pickup, destination, vehicleType,
      paymentMethod, passengerName, passengerPhone,
      vehiclePrice, distanceMiles, durationMinutes,
      passengers, luggage, notes,
      pickupLat, pickupLng, dropoffLat, dropoffLng,
    } = req.body;

    if (!pickup || !destination) {
      return res.status(400).json({ error: 'Missing required fields: pickup, destination' });
    }

    // Resolve driver's vehicle category (fallback to 'sedan')
    const { data: driverProfile } = await supabaseAdmin
      .from('profiles')
      .select('vehicle_type, vehicle')
      .eq('id', driverId)
      .maybeSingle();
    const dp = driverProfile as { vehicle_type?: string; vehicle?: { class?: string; category?: string } | null } | null;
    const resolvedVehicleType: string = vehicleType
      || dp?.vehicle_type
      || dp?.vehicle?.class
      || dp?.vehicle?.category
      || 'sedan';

    const pmMethod = (paymentMethod || 'cash') as string;
    if (!['cash', 'card'].includes(pmMethod)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    // Compute fare. Prefer explicit price from client (already from
    // calculateFareFromRules on the driver UI), otherwise compute it now.
    const rawPrice = typeof vehiclePrice === 'number'
      ? vehiclePrice
      : parseFloat(String(vehiclePrice ?? '').replace(/[^0-9.]/g, '')) || 0;
    let fareTotal = rawPrice > 0 ? rawPrice : 0;
    let fareBreakdown: Record<string, unknown> | null = null;
    if (typeof distanceMiles === 'number' && typeof durationMinutes === 'number') {
      fareBreakdown = calculateFareFromRules({
        vehicleType: resolvedVehicleType,
        distanceMiles,
        durationMinutes,
      }) as unknown as Record<string, unknown>;
      if (!fareTotal && fareBreakdown?.total) fareTotal = Number(fareBreakdown.total);
    }
    if (fareTotal < 1) {
      return res.status(400).json({ error: 'Could not compute a valid fare' });
    }
    fareTotal = +fareTotal.toFixed(2);

    const gpsLat = typeof pickupLat === 'number' ? pickupLat : null;
    const gpsLng = typeof pickupLng === 'number' ? pickupLng : null;
    const dLat   = typeof dropoffLat === 'number' ? dropoffLat : null;
    const dLng   = typeof dropoffLng === 'number' ? dropoffLng : null;

    const pickupPayload = typeof pickup === 'string'
      ? { address: pickup, ...(gpsLat !== null ? { lat: gpsLat, lng: gpsLng } : {}) }
      : pickup;
    const dropoffPayload = typeof destination === 'string'
      ? { address: destination, ...(dLat !== null ? { lat: dLat, lng: dLng } : {}) }
      : destination;

    const bookingRef = `URB-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    const now = new Date().toISOString();

    const insertPayload: Record<string, unknown> = {
      passenger_id:        driverId,           // driver acts as the booking author
      driver_id:           driverId,           // and is the assigned driver
      vehicle_type:        resolvedVehicleType,
      pickup:              pickupPayload,
      dropoff:             dropoffPayload,
      fare:                fareTotal,
      locked_fare:         fareTotal,
      payment_method:      pmMethod,
      ride_status:         'in_progress',
      pickup_pin:          null,
      dispatched_by_valet: false,
      valet_booking_ref:   bookingRef,
      guest_name:          passengerName || null,
      passengers:          typeof passengers === 'number' ? passengers : 1,
      luggage:             typeof luggage === 'number' ? luggage : 0,
      pickup_lat:          gpsLat,
      pickup_lng:          gpsLng,
      distance_miles:      typeof distanceMiles === 'number' ? distanceMiles : null,
      base_fare_breakdown: fareBreakdown ? JSON.stringify(fareBreakdown) : null,
      notes:               notes || null,
      accepted_at:         now,
      started_at:          now,
      created_at:          now,
      updated_at:          now,
    };

    const { data: ride, error: insertErr } = await supabaseAdmin
      .from('rides')
      .insert(insertPayload)
      .select()
      .single();

    if (insertErr) throw insertErr;
    if (!ride) return res.status(500).json({ error: 'Failed to create ride' });

    logger.info(`[DRIVER_CREATE] Ride ${ride.id} | driver=${driverId} | $${fareTotal} | ${pmMethod} | passenger="${passengerName || '—'}"`);

    return res.json({
      ride,
      bookingRef,
      fare: fareTotal,
    });
  } catch (err: any) {
    logger.error(`[RIDES] driver-create error:: ${err.message}`);
    res.status(500).json({ error: err.message || 'Failed to create ride' });
  }
});

// --- 9. Update ride status — PATCH /:id/status ---
rideRouter.patch("/:id/status", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { status, ride_status, rating } = req.body;
    const finalStatus = status || ride_status;

    if (!finalStatus) {
      return res.status(400).json({ error: 'Missing required field: status' });
    }

    const uid  = req.supabaseUid;
    const role = (req.supabaseRole || 'passenger') as UserRole;

    // Fetch ride to validate ownership and current state
    const { data: ride, error: fetchErr } = await supabaseAdmin.from('rides')
      .select('passenger_id, driver_id, ride_status, payment_intent_id, fare, locked_fare, wait_started_at, started_at, accepted_at, pickup_pin')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchErr || !ride) {
      return res.status(404).json({ error: 'Ride not found.' });
    }

    const r = ride as Record<string, unknown>;
    const currentStatus = r.ride_status as RideStatus;

    // Ownership check — passenger, assigned driver, or admin
    const isDriver = role === 'chauffeur' || role === 'driver';
    if (
      role !== 'admin' &&
      r.passenger_id !== uid &&
      r.driver_id !== uid &&
      !(isDriver && finalStatus === 'confirmed') // drivers can accept unassigned rides
    ) {
      return res.status(403).json({ error: 'Access denied. You are not a participant in this ride.' });
    }

    // State machine validation
    const transition = validateTransition(currentStatus, finalStatus as RideStatus, role);
    if (!transition.allowed) {
      return res.status(409).json({ error: transition.reason });
    }

    // Driver active ride guard — driver cannot accept a second ride while already in one
    if (finalStatus === 'confirmed' && isDriver) {
      const { data: driverActive } = await supabaseAdmin
        .from('rides')
        .select('id')
        .eq('driver_id', uid)
        .in('ride_status', ['confirmed', 'driver_arrived', 'in_progress'])
        .maybeSingle();

      if (driverActive) {
        return res.status(409).json({
          error: 'You already have an active ride. Please complete it before accepting a new one.',
          code: 'DRIVER_BUSY',
        });
      }
    }

    if (rating !== undefined && (typeof rating !== 'number' || rating < 1 || rating > 5)) {
      return res.status(400).json({ error: 'Rating must be a number between 1 and 5.' });
    }

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
      ride_status: finalStatus,
      updated_at: now,
    };
    if (rating !== undefined) updates.rating = rating;

    // ── Uber-parity timestamps ───────────────────────────────────────────────
    // Record when driver accepts (for cancellation grace period timing)
    if (finalStatus === 'confirmed' && isDriver) {
      updates.accepted_at = now;
      if (!r.driver_id) updates.driver_id = uid;
      // Track acceptance in driver stats (fire-and-forget)
      (async () => {
        try {
          await supabaseAdmin.rpc('upsert_driver_stats_accept', { p_driver_id: uid });
        } catch {
          // RPC may not exist — fall back to direct update
          try {
            await supabaseAdmin.from('driver_stats').upsert({
              driver_id: uid,
              trips_accepted: 1,
              trips_offered: 1,
              last_updated: now,
            }, { onConflict: 'driver_id', ignoreDuplicates: false });
          } catch { /* ignore */ }
        }
      })();
    }

    // Record when driver arrives — starts the wait time meter
    if ((finalStatus === 'driver_arrived' || finalStatus === 'arrived') && isDriver) {
      updates.wait_started_at = now;
    }

    // On trip start — store start time for time-based billing
    if (finalStatus === 'in_progress') {
      // Option A: PIN must be verified before any ride can advance to in_progress.
      // The /verify-pin endpoint clears pickup_pin once it succeeds, so a non-null
      // pickup_pin here means the driver tried to skip the PIN step.
      if (r.pickup_pin && role !== 'admin') {
        return res.status(409).json({
          error: 'PIN verification required to start this trip.',
          code: 'PIN_REQUIRED',
        });
      }
      updates.started_at = now;
    }

    // On completion — calculate wait fee and finalize fare
    let waitFeeAdded = 0;
    if (finalStatus === 'completed') {
      updates.completed_at = now;

      // Wait time fee: charge $0.50/min after 5 free minutes
      const rideData = r as Record<string, unknown>;
      if (rideData.wait_started_at) {
        const waitStart = new Date(rideData.wait_started_at as string).getTime();
        const startedAt = rideData.started_at ? new Date(rideData.started_at as string).getTime() : Date.now();
        const waitMinutes = (startedAt - waitStart) / 60000;
        const billableMinutes = Math.min(60, Math.max(0, waitMinutes - WAIT_TIME_FREE_MINUTES)); // cap: 60 min max
        if (billableMinutes > 0) {
          waitFeeAdded = Math.round(billableMinutes * WAIT_TIME_FEE_PER_MIN * 100) / 100;
          updates.wait_fee = waitFeeAdded;
        }
      }

      // Update driver streak stats (fire-and-forget)
      if (uid) {
        updateDriverStreak(uid, waitFeeAdded).catch(() => {});
      }

      // Increment passenger total_rides (fire-and-forget)
      const passengerIdForIncrement = String(r.passenger_id || '');
      if (passengerIdForIncrement) {
        void (async () => {
          try {
            const { error: rpcErr } = await supabaseAdmin.rpc('increment_total_rides', { user_id: passengerIdForIncrement });
            if (rpcErr) {
              // RPC might not exist yet — fall back to manual increment
              const { data: pd } = await supabaseAdmin.from('profiles').select('total_rides').eq('id', passengerIdForIncrement).maybeSingle();
              const current = parseInt(String((pd as Record<string, unknown> | null)?.total_rides ?? '0'), 10);
              await supabaseAdmin.from('profiles').update({ total_rides: current + 1 }).eq('id', passengerIdForIncrement);
            }
          } catch {
            // fire-and-forget: ignore errors
          }
        })();
      }
    }

    let { data: updatedRows, error } = await supabaseAdmin
      .from('rides')
      .update(updates)
      .eq('id', req.params.id)
      .eq('ride_status', currentStatus) // Atomic check: only update if status hasn't changed
      .select('id, ride_status, driver_id');

    // If extended columns (accepted_at, wait_started_at, started_at, wait_fee, etc.) don't exist,
    // retry with only the core columns that are guaranteed in the base schema.
    const isSchemaError = error && (
      String(error.message).includes('column') ||
      String(error.message).includes('schema cache') ||
      (error as NodeJS.ErrnoException)?.code === 'PGRST204' ||
      (error as NodeJS.ErrnoException)?.code === '42703'
    );
    if (isSchemaError) {
      logger.warn(`[RIDES] Schema fallback for status update:: ${error.message}`);
      const coreUpdates: Record<string, unknown> = {
        ride_status: finalStatus,
        updated_at: now,
      };
      if (updates.driver_id !== undefined) coreUpdates.driver_id = updates.driver_id;
      if (updates.rating    !== undefined) coreUpdates.rating    = updates.rating;
      const fallback = await supabaseAdmin
        .from('rides')
        .update(coreUpdates)
        .eq('id', req.params.id)
        .eq('ride_status', currentStatus)
        .select('id, ride_status, driver_id');
      updatedRows = fallback.data;
      error       = fallback.error;
    }

    if (error) throw error;

    // If 0 rows were updated the status changed under us (race condition).
    // Re-fetch the actual current status and broadcast that instead so clients
    // converge on the real state rather than the stale intended one.
    if (!updatedRows || updatedRows.length === 0) {
      const { data: current } = await supabaseAdmin
        .from('rides')
        .select('ride_status, driver_id')
        .eq('id', req.params.id)
        .maybeSingle();
      const actualStatus = String((current as Record<string,unknown>)?.ride_status ?? currentStatus);
      logger.warn(`[RIDES] Status update had no effect for ${req.params.id}: wanted ${currentStatus}→${finalStatus}, actual=${actualStatus}`);
      broadcastRideStatus(req.params.id, actualStatus, {
        driverId: String((current as Record<string,unknown>)?.driver_id ?? r.driver_id ?? ''),
        passengerId: r.passenger_id,
      });
      return res.status(409).json({ error: 'Ride status changed — current status: ' + actualStatus, currentStatus: actualStatus });
    }

    logger.info(`[RIDES] Status updated: ${req.params.id} ${currentStatus}→${finalStatus} by ${role}/${uid}`);

    // ── Stripe capture on ride completion ─────────────────────────────────────
    // When using capture_method: 'manual', the PI is authorized but not charged.
    // We capture (charge) the full amount only once the trip is successfully completed.
    // If wait_fee was added, capture the full amount (locked_fare + wait_fee).
    // Add wait_fee to the fare column so receipts/history show the correct total
    if (waitFeeAdded > 0) {
      const baseFare = Number((r as Record<string,unknown>).locked_fare ?? (r as Record<string,unknown>).fare ?? 0);
      const totalFare = Math.round((baseFare + waitFeeAdded) * 100) / 100;
      void supabaseAdmin
        .from('rides')
        .update({ fare: totalFare, updated_at: now })
        .eq('id', req.params.id)
        .then(({ error: fareErr }) => {
          if (fareErr) logger.warn(`[RIDES] Could not update fare with wait_fee: ${fareErr.message}`);
          else logger.info(`[RIDES] Fare updated to $${totalFare} (locked $${baseFare} + wait $${waitFeeAdded})`);
        });
    }

    if (finalStatus === 'completed' && r.payment_intent_id) {
      const stripe = getStripe();
      if (stripe) {
        stripe.paymentIntents.retrieve(r.payment_intent_id as string).then(async (pi) => {
          if (pi.status === 'requires_capture') {
            const baseCents = pi.amount; // original authorized amount in cents
            // If wait_fee was charged, increase the capture amount by the wait fee
            if (waitFeeAdded > 0) {
              const extraCents = Math.round(waitFeeAdded * 100);
              const totalCents = baseCents + extraCents;
              try {
                // Stripe allows increasing a PI before capture via update
                await stripe.paymentIntents.update(r.payment_intent_id as string, { amount: totalCents });
              } catch (updateErr: unknown) {
                // If update fails (e.g. PI in non-updatable state), fall back to capturing original amount
                logger.warn(`[RIDES] Could not update PI amount for wait_fee:: ${errMsg(updateErr)}`);
              }
            }
            await stripe.paymentIntents.capture(r.payment_intent_id as string);
            logger.info(`[RIDES] Captured payment ${r.payment_intent_id} for completed ride ${req.params.id}`);
          }
        }).catch((err: unknown) => {
          logger.error(`[RIDES] Stripe capture failed for ride ${req.params.id}: ${(err as Error)?.message}`);
        });
      }
    }

    // Broadcast status change to all participants via Socket.io instantly
    broadcastRideStatus(req.params.id, finalStatus, {
      driverId: finalStatus === 'confirmed' && isDriver ? uid : r.driver_id,
      passengerId: r.passenger_id,
    });

    // Audit log: record every status transition
    const logBody = req.body as { lat?: number; lng?: number };
    void supabaseAdmin.from('ride_logs').insert({
      ride_id:         req.params.id,
      old_status:      currentStatus,
      new_status:      finalStatus,
      changed_by_id:   uid,
      changed_by_role: role,
      gps_lat:         logBody.lat ?? null,
      gps_lng:         logBody.lng ?? null,
      metadata:        { rating: rating ?? null },
    });

    // Push notifications for key status transitions (fire-and-forget)
    const passengerId = String(r.passenger_id || '');
    const driverId = String(r.driver_id || updates.driver_id || '');
    const rideId = req.params.id;

    if (finalStatus === 'confirmed' && passengerId) {
      notifyUser(passengerId, {
        title: 'Driver on the way!',
        body: 'Your chauffeur has accepted your ride and is heading to you.',
        data: { type: 'ride_confirmed', ride_id: rideId, screen: 'ride_tracking' },
      }).catch(() => {});
    } else if ((finalStatus === 'driver_arrived' || finalStatus === 'arrived') && passengerId) {
      notifyUser(passengerId, {
        title: 'Your driver has arrived!',
        body: 'Your chauffeur is at the pickup location. Please proceed to the vehicle.',
        data: { type: 'driver_arrived', ride_id: rideId, screen: 'ride_tracking' },
      }).catch(() => {});
    } else if (finalStatus === 'in_progress' && passengerId) {
      notifyUser(passengerId, {
        title: 'Ride started',
        body: 'Your ride is now in progress. Sit back and enjoy the trip!',
        data: { type: 'ride_started', ride_id: rideId, screen: 'ride_tracking' },
      }).catch(() => {});

      // T013: Auto-share with trusted contact via SMS (fire-and-forget)
      supabaseAdmin.auth.admin.getUserById(passengerId).then(({ data: paxUser }) => {
        const meta = paxUser?.user?.user_metadata ?? {};
        const trustedPhone = meta.trusted_contact_phone as string | undefined;
        const trustedName  = meta.trusted_contact_name  as string | undefined;
        if (!trustedPhone) return;
        const pickupAddr  = String((r as Record<string,unknown>).pickup_address  || 'unknown location');
        const dropoffAddr = String((r as Record<string,unknown>).dropoff_address || 'destination');
        const paxName = `${(r as Record<string,unknown>).passenger_first_name || 'Your contact'}`.trim();
        const msg = `URBONT Safety Alert: ${paxName || 'Someone'} has started a ride from ${pickupAddr} to ${dropoffAddr}. Ride ID: ${rideId.substring(0, 8).toUpperCase()}. This message was sent automatically by URBONT Premium Chauffeur.`;
        sendSmsTwilio(trustedPhone, msg).catch(() => {});
        logger.info(`[T013] Trusted contact SMS sent to ${trustedName || trustedPhone} for ride ${rideId}`);
      }).catch(() => {});
    } else if (finalStatus === 'completed' && passengerId) {
      notifyUser(passengerId, {
        title: 'You have arrived!',
        body: 'Thank you for riding with URBONT. Please rate your experience.',
        data: { type: 'ride_completed', ride_id: rideId, screen: 'ride_summary' },
      }).catch(() => {});
      // Notify driver of earnings + check quest milestones
      if (driverId) {
        const fare = Number(r.fare) || 0;
        const driverEarnings = Math.round(fare * 0.9 * 100) / 100;
        notifyUser(driverId, driverNotif.tripEarnings(rideId, driverEarnings)).catch(() => {});

        // Quest milestone: count trips this week and fire at 5, 10, 15, 25
        void (async () => {
          try {
            const weekStart = new Date();
            weekStart.setDate(weekStart.getDate() - weekStart.getDay());
            weekStart.setHours(0, 0, 0, 0);
            const { count } = await supabaseAdmin
              .from('rides')
              .select('*', { count: 'exact', head: true })
              .eq('driver_id', driverId)
              .eq('ride_status', 'completed')
              .gte('created_at', weekStart.toISOString());
            const tripsThisWeek = count ?? 0;
            const QUEST_MILESTONES: Record<number, { title: string; reward: string }> = {
              5:  { title: 'Complete 5 rides this week',  reward: 'bonus eligibility' },
              10: { title: 'Complete 10 rides this week', reward: 'Quest progress' },
              15: { title: 'Halfway to 25 rides!',        reward: 'keep going' },
              25: { title: 'Complete 25 rides this week', reward: '$50 bonus' },
            };
            if (QUEST_MILESTONES[tripsThisWeek]) {
              const q = QUEST_MILESTONES[tripsThisWeek];
              if (tripsThisWeek === 25) {
                notifyUser(driverId, driverNotif.questComplete(q.title, q.reward)).catch(() => {});
              } else {
                notifyUser(driverId, driverNotif.questProgress(q.title, tripsThisWeek, 25, q.reward)).catch(() => {});
              }
            }
          } catch { /* quest check is non-critical */ }
        })();
      }

      // Auto-send email receipt (fire and forget)
      if (!r.receipt_sent) {
        void (async () => {
          try {
            const { data: fullRide } = await supabaseAdmin
              .from('rides')
              .select(`id, fare, tip_amount, promo_discount, distance_miles, duration_minutes, vehicle_type, pickup_address, dropoff_address, created_at, stops,
                passenger:profiles!rides_passenger_id_fkey(first_name, last_name, email),
                driver:profiles!rides_driver_id_fkey(first_name, last_name)`)
              .eq('id', rideId)
              .maybeSingle();
            if (!fullRide) return;
            const fr = fullRide as Record<string,unknown>;
            const pax = fr.passenger as { first_name?: string; last_name?: string; email?: string } | null;
            const drv = fr.driver as { first_name?: string; last_name?: string } | null;
            if (!pax?.email) return;
            const sent = await sendRideReceipt({
              passengerEmail: pax.email,
              passengerName: `${pax.first_name || ''} ${pax.last_name || ''}`.trim() || 'Passenger',
              driverName: drv ? `${drv.first_name || ''} ${drv.last_name || ''}`.trim() : 'Your Chauffeur',
              vehicleType: String(fr.vehicle_type || 'Sedan'),
              pickupAddress: String(fr.pickup_address || ''),
              dropoffAddress: String(fr.dropoff_address || ''),
              distanceMiles: parseFloat(String(fr.distance_miles ?? 0)),
              durationMin: Math.round(Number(fr.duration_minutes ?? 0)),
              fare: Number(fr.fare ?? 0),
              tip: fr.tip_amount != null ? Number(fr.tip_amount) : undefined,
              discount: fr.promo_discount != null ? Number(fr.promo_discount) : undefined,
              paymentMethod: 'Card on file',
              rideDate: new Date(String(fr.created_at)).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
              rideId,
              stops: (fr.stops as string[]) || [],
            });
            if (sent) {
              try {
                await supabaseAdmin.from('rides').update({ receipt_sent: true }).eq('id', rideId);
              } catch { /* ignore */ }
            }
          } catch {
            // fire-and-forget: ignore errors
          }
        })();
      }
    } else if (finalStatus === 'cancelled' && driverId) {
      notifyUser(driverId, {
        title: 'Ride Cancelled',
        body: 'The passenger has cancelled this ride.',
        data: { type: 'ride_cancelled', ride_id: rideId, screen: 'driver_home' },
      }).catch(() => {});
    }

    res.json({ success: true });
  } catch (err: any) {
    logger.error(`[RIDES] status update error:: ${err.message}`);
    res.status(500).json({ error: 'Failed to update ride status' });
  }
});

// ── GET /api/rides/heatmap — pickup coordinates for demand heat map ────────────
rideRouter.get('/heatmap', requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('rides')
      .select('pickup_lat, pickup_lng')
      .not('pickup_lat', 'is', null)
      .not('pickup_lng', 'is', null)
      .gte('created_at', new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString())
      .limit(2000);
    if (error) throw error;
    const points = (data ?? []).map((r: Record<string,unknown>) => ({ lat: r.pickup_lat, lng: r.pickup_lng }));
    res.json(points);
  } catch (err: any) {
    logger.error(`[RIDES] heatmap error:: ${err.message}`);
    res.status(500).json({ error: 'Failed to fetch heatmap data' });
  }
});

// ── POST /api/rides/:id/send-receipt — email trip receipt to passenger ────────
rideRouter.post('/:id/send-receipt', requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data: ride, error } = await supabaseAdmin
      .from('rides')
      .select(`
        id, created_at, pickup_address, dropoff_address, fare, distance_miles, duration_minutes,
        vehicle_type, ride_status,
        passenger:profiles!rides_passenger_id_fkey(first_name, last_name, email, phone),
        driver:profiles!rides_driver_id_fkey(first_name, last_name)
      `)
      .eq('id', id)
      .single();
    if (error || !ride) return res.status(404).json({ error: 'Ride not found' });

    const passenger = (ride as Record<string,unknown>).passenger as { first_name?: string; last_name?: string; email?: string; phone?: string } | null;
    const driver = (ride as Record<string,unknown>).driver as { first_name?: string; last_name?: string } | null;
    const email = passenger?.email;
    if (!email) return res.status(400).json({ error: 'No email on file for passenger' });

    const smtpHost = process.env.SMTP_HOST;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpPort = parseInt(process.env.SMTP_PORT || '587');
    if (!smtpHost || !smtpUser || !smtpPass) {
      return res.status(503).json({ error: 'Email not configured' });
    }

    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransport({ host: smtpHost, port: smtpPort, auth: { user: smtpUser, pass: smtpPass } });

    const rideRec = ride as Record<string,unknown>;
    const fare = typeof rideRec.fare === 'number' ? `${(rideRec.fare as number).toFixed(2)}` : '—';
    const distMiles = parseFloat(String(rideRec.distance_miles ?? 0));
    const distMi = distMiles ? `${distMiles.toFixed(1)} mi` : '—';
    const dur = rideRec.duration_minutes ? `${Math.round(Number(rideRec.duration_minutes))} min` : '—';
    const rideDate = new Date(String(rideRec.created_at)).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const passengerName = passenger ? `${passenger.first_name} ${passenger.last_name}`.trim() : 'Passenger';
    const driverName = driver ? `${driver.first_name} ${driver.last_name}`.trim() : 'Your Chauffeur';

    await transporter.sendMail({
      from: `URBONT <${smtpUser}>`,
      to: email,
      subject: `Your URBONT Receipt — ${rideDate}`,
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#001F3F;">
          <div style="background:#001F3F;padding:32px;border-radius:12px 12px 0 0;text-align:center;">
            <h1 style="color:#D4A055;margin:0;font-size:28px;letter-spacing:4px;">URBONT</h1>
            <p style="color:#fff;margin:8px 0 0;opacity:0.7;font-size:13px;">Premium Chauffeur Service</p>
          </div>
          <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;">
            <p style="font-size:16px;margin:0 0 24px;">Hi ${passengerName},<br>Thank you for riding with URBONT. Here is your trip receipt.</p>
            <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
              <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px;">Date</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:13px;text-align:right;">${rideDate}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px;">Chauffeur</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:13px;text-align:right;">${driverName}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px;">Vehicle</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:13px;text-align:right;text-transform:capitalize;">${(ride as Record<string,unknown>).vehicle_type || 'Sedan'}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px;">Pickup</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:13px;text-align:right;max-width:200px;">${(ride as Record<string,unknown>).pickup_address || '—'}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px;">Dropoff</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:13px;text-align:right;max-width:200px;">${(ride as Record<string,unknown>).dropoff_address || '—'}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px;">Distance</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:13px;text-align:right;">${distMi}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px;">Duration</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:13px;text-align:right;">${dur}</td></tr>
              <tr><td style="padding:12px 0;color:#001F3F;font-weight:bold;font-size:15px;">Total</td><td style="padding:12px 0;font-weight:bold;font-size:18px;color:#D4A055;text-align:right;">${fare}</td></tr>
            </table>
            <p style="font-size:12px;color:#9ca3af;margin:0;">Questions? Reply to this email or contact support. Thank you for choosing URBONT.</p>
          </div>
          <div style="background:#f9fafb;padding:16px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none;text-align:center;">
            <p style="font-size:11px;color:#9ca3af;margin:0;">© ${new Date().getFullYear()} URBONT. Premium Chauffeur Service.</p>
          </div>
        </div>
      `,
    });

    res.json({ success: true });
  } catch (err: any) {
    logger.error(`[RIDES] receipt email error:: ${err.message}`);
    res.status(500).json({ error: 'Failed to send receipt' });
  }
});

// ── NEW: POST /api/rides/ride/start — Protocolo PIN ──────────────────────────
// The driver submits the verification PIN given by the passenger.
// The ride status only advances to in_progress if the PIN is correct.
rideRouter.post("/ride/start", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { rideId, pin } = req.body;
    if (!rideId || !pin) {
      return res.status(400).json({ error: 'rideId and pin are required.' });
    }

    const role = req.supabaseRole || 'passenger';
    if (role !== 'chauffeur' && role !== 'admin') {
      return res.status(403).json({ error: 'Only drivers can start a ride.' });
    }

    const { data: ride, error: fetchErr } = await supabaseAdmin
      .from('rides')
      .select('pickup_pin, ride_status, driver_id, passenger_id')
      .eq('id', rideId)
      .maybeSingle();

    if (fetchErr || !ride) {
      return res.status(404).json({ error: 'Ride not found.' });
    }

    const r = ride as Record<string, any>;

    if (r.ride_status !== 'confirmed' && r.ride_status !== 'searching' && r.ride_status !== 'driver_arrived') {
      return res.status(409).json({
        error: `Ride cannot be started in status "${r.ride_status}".`,
        code: 'INVALID_STATUS',
      });
    }

    if (String(r.pickup_pin) !== String(pin).trim()) {
      return res.status(401).json({
        error: 'Incorrect PIN. Please ask the passenger to confirm the code.',
        code: 'WRONG_PIN',
      });
    }

    const driverId = req.supabaseUid;
    const { error: updateErr } = await supabaseAdmin.from('rides').update({
      ride_status: 'in_progress',
      driver_id: r.driver_id || driverId,
      pickup_pin: null,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', rideId);

    if (updateErr) throw updateErr;

    broadcastRideStatus(rideId, 'in_progress', { startedAt: new Date().toISOString() });

    res.json({ success: true, message: 'PIN verified. Ride is now in_progress.' });
  } catch (err: any) {
    logger.error(`[RIDES] ride/start error:: ${err.message}`);
    res.status(500).json({ error: 'Failed to start ride.' });
  }
});


// ── NEW: POST /api/rides/ride-check — Real-time route deviation check ─────────
// Call this every ~30 seconds while a ride is in_progress.
// Emits `anomaly_detected` via Socket.IO if driver deviates >2km or >15min.
rideRouter.post("/ride-check", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { rideId, driverLat, driverLng } = req.body;

    if (!rideId || typeof driverLat !== 'number' || typeof driverLng !== 'number') {
      return res.status(400).json({ error: 'rideId, driverLat, and driverLng are required.' });
    }

    const result = await checkRideDeviation({ rideId, driverLat, driverLng });
    res.json(result);
  } catch (err: any) {
    logger.error(`[RIDES] ride-check error:: ${err.message}`);
    res.status(500).json({ error: 'Ride check failed.' });
  }
});

// ── GET /api/rides/export — Download ride history as CSV ─────────────────────
rideRouter.get('/export', requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.supabaseUid;
    const role   = req.supabaseRole;

    let query = supabaseAdmin
      .from('rides')
      .select('id, created_at, ride_status, fare, vehicle_type, distance_meters, duration_minutes, pickup, dropoff, driver_id, passenger_id, payment_method, cancel_reason, booking_type')
      .order('created_at', { ascending: false })
      .limit(5000);

    if (role !== 'admin' && role !== 'chauffeur') {
      query = query.or(`passenger_id.eq.${userId},driver_id.eq.${userId}`);
    }

    const { data: rides, error } = await query;
    if (error) throw error;

    const header = ['id', 'date', 'status', 'fare_usd', 'vehicle', 'distance_m', 'duration_min', 'pickup_address', 'dropoff_address', 'booking_type', 'payment_method', 'cancel_reason'].join(',');
    const rows = (rides ?? []).map((r: Record<string,unknown>) => {
      const row = [
        r.id,
        r.created_at ? new Date(r.created_at as string).toISOString() : '',
        r.ride_status || '',
        r.fare != null ? Number(r.fare).toFixed(2) : '',
        r.vehicle_type || '',
        r.distance_meters || '',
        r.duration_minutes || '',
        `"${String((r.pickup as Record<string,unknown> | null)?.address || '').replace(/"/g, '""')}"`,
        `"${String((r.dropoff as Record<string,unknown> | null)?.address || '').replace(/"/g, '""')}"`,
        r.booking_type || 'standard',
        r.payment_method || '',
        `"${String(r.cancel_reason || '').replace(/"/g, '""')}"`,
      ];
      return row.join(',');
    });

    const csv = [header, ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="urbont-rides-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err: any) {
    logger.error(`[RIDES] export error:: ${err.message}`);
    res.status(500).json({ error: 'Export failed' });
  }
});

// POST /api/rides/:rideId/cancel-and-credit — cancel a searching/accepted ride and credit the fare to URBONT balance
rideRouter.post('/:rideId/cancel-and-credit', requireSupabaseAuth, async (req: Request, res: Response) => {
  const { rideId } = req.params;
  const userId = req.supabaseUid;
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  try {
    // Fetch ride and verify it belongs to passenger and is cancellable
    const { data: ride, error: rideErr } = await supabaseAdmin
      .from('rides')
      .select('id, passenger_id, ride_status, fare')
      .eq('id', rideId)
      .single();

    if (rideErr || !ride) return res.status(404).json({ error: 'Ride not found' });
    if (ride.passenger_id !== userId) return res.status(403).json({ error: 'Not your ride' });
    if (!['searching', 'confirmed', 'driver_arrived'].includes(ride.ride_status)) {
      return res.status(400).json({ error: `Cannot cancel ride in status: ${ride.ride_status}` });
    }

    const creditAmount = parseFloat(ride.fare ?? 0);

    // FIX: Credit the passenger BEFORE cancelling the ride.
    // Previously the ride was cancelled first and then credited — if the credit query
    // threw (DB error, pool timeout), the ride was left cancelled with no credit issued
    // and the passenger lost their fare with no recourse.
    // Now: credit succeeds → cancel the ride. If credit fails we throw before touching
    // the ride status, so the passenger can retry. If cancel fails after a successful
    // credit, the ride stays in its prior status and the passenger keeps the credit
    // (a harmless over-credit is far better than a silent fare loss).
    if (creditAmount > 0) {
      // Atomic SQL increment to prevent race condition when multiple concurrent
      // cancel-and-credit requests overwrite each other's balance.
      await pool.query(
        `UPDATE profiles SET urbont_credits = COALESCE(urbont_credits::numeric, 0) + $1 WHERE id = $2`,
        [creditAmount, userId]
      );
    }

    // Cancel the ride (after credit is confirmed safe)
    let { error: cancelErr } = await supabaseAdmin
      .from('rides')
      .update({ ride_status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: 'passenger_cancel_credit' })
      .eq('id', rideId);

    if (cancelErr && (String((cancelErr as Error)?.message).includes('column') || String((cancelErr as Error)?.message).includes('schema cache') || (cancelErr as NodeJS.ErrnoException)?.code === '42703')) {
      const fb = await supabaseAdmin.from('rides').update({ ride_status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', rideId);
      cancelErr = fb.error;
    }

    if (cancelErr) throw cancelErr;

    return res.json({ success: true, creditedAmount: creditAmount });
  } catch (err: any) {
    logger.error(`[RIDES] cancel-and-credit error:: ${err.message}`);
    return res.status(500).json({ error: 'Failed to cancel and credit' });
  }
});

// ── POST /api/rides/:id/prefer-driver — add ride's driver to preferred list ──
rideRouter.post('/:id/prefer-driver', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { id: rideId } = req.params;
  try {
    const { data: ride, error: rideErr } = await supabaseAdmin
      .from('rides')
      .select('driver_id')
      .eq('id', rideId)
      .single();
    if (rideErr || !ride || !(ride as Record<string,unknown>).driver_id) {
      return res.status(404).json({ error: 'Driver not found for this ride' });
    }
    const driverId = (ride as Record<string,unknown>).driver_id as string;
    const { error } = await supabaseAdmin
      .from('preferred_drivers')
      .insert({ passenger_id: uid, driver_id: driverId });
    if (error && error.code !== '23505') {
      return res.status(500).json({ error: 'Failed to save preferred driver' });
    }
    return res.json({ success: true, driverId });
  } catch (err: any) {
    logger.error(`[RIDES] prefer-driver error:: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /:id/passenger-message — passenger sends pre-defined quick message to driver ──
rideRouter.post('/:id/passenger-message', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { id: rideId } = req.params;
  const { message } = req.body as { message?: string };
  if (!message || typeof message !== 'string' || message.trim().length < 2) {
    return res.status(400).json({ error: 'message is required' });
  }
  try {
    const { data: ride, error: rideErr } = await supabaseAdmin
      .from('rides')
      .select('id, passenger_id, driver_id, ride_status')
      .eq('id', rideId)
      .single();
    if (rideErr || !ride) return res.status(404).json({ error: 'Ride not found' });
    if (String((ride as Record<string,unknown>).passenger_id) !== uid) return res.status(403).json({ error: 'Not your ride' });
    const driverId = (ride as Record<string,unknown>).driver_id as string | null;
    // Emit real-time message to the driver via socket
    const socketIo = (await import('../../services/socketService')).getIo();
    if (socketIo && driverId) {
      socketIo.to(`user:${driverId}`).emit('passenger:message', {
        rideId,
        message: message.trim(),
        fromPassenger: uid,
        sentAt: new Date().toISOString(),
      });
    }
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /:id/rating — passenger rates driver OR driver rates passenger ────────
rideRouter.post('/:id/rating', requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const uid  = req.supabaseUid!;
    const role = (req.supabaseRole || 'passenger') as UserRole;
    const { rating, comment, tags } = req.body as { rating: number; comment?: string; tags?: string[] };

    if (!rating || typeof rating !== 'number' || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be 1–5' });
    }

    const { data: ride, error: fetchErr } = await supabaseAdmin
      .from('rides')
      .select('passenger_id, driver_id, ride_status')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchErr || !ride) return res.status(404).json({ error: 'Ride not found' });
    const r = ride as Record<string, unknown>;

    if (r.ride_status !== 'completed') {
      return res.status(409).json({ error: 'Ride is not completed yet' });
    }

    const isDriver = role === 'chauffeur' || role === 'driver';
    const isPassenger = r.passenger_id === uid;
    const isDriverUser = r.driver_id === uid;

    if (!isPassenger && !isDriverUser) {
      return res.status(403).json({ error: 'Not a participant in this ride' });
    }

    let newDriverRating: number | null = null;

    if (isPassenger) {
      // Passenger rates driver → update driver's rating average
      const driverId = r.driver_id as string;
      if (driverId) {
        const { data: dp } = await supabaseAdmin.from('profiles').select('rating, total_rides').eq('id', driverId).maybeSingle();
        const currentRating = parseFloat(String((dp as Record<string,unknown>)?.rating ?? '5.0'));
        const totalRides = parseInt(String((dp as Record<string,unknown>)?.total_rides ?? '1'), 10);
        const newRating = parseFloat(((currentRating * totalRides + rating) / (totalRides + 1)).toFixed(2));
        newDriverRating = Math.min(5, Math.max(1, newRating));

        const profileUpdate: Record<string, unknown> = { rating: newDriverRating };

        // Auto-flag for admin review if average drops below threshold
        const ratedRides = totalRides + 1;
        if (newDriverRating < 4.0 && ratedRides >= 10) {
          profileUpdate.needs_review = true;
          profileUpdate.rating_flagged_at = new Date().toISOString();
          logger.warn(`[RIDES] Driver ${driverId} flagged for review — rating ${newDriverRating} after ${ratedRides} rides`);
        } else if (newDriverRating >= 4.5 && (dp as Record<string,unknown>)?.needs_review) {
          // Clear flag if driver recovers above 4.5
          profileUpdate.needs_review = false;
        }

        await supabaseAdmin.from('profiles').update(profileUpdate).eq('id', driverId);
      }
      // Store passenger rating in ride record
      await supabaseAdmin.from('rides').update({ rating, passenger_review_comment: comment ?? null, passenger_review_tags: tags ?? null }).eq('id', req.params.id);
    } else {
      // Driver rates passenger → update passenger_rating on ride + update passenger's profile rating average
      await supabaseAdmin.from('rides').update({ passenger_rating: rating, driver_review_comment: comment ?? null }).eq('id', req.params.id);
      const passengerId = r.passenger_id as string;
      if (passengerId) {
        // Compute passenger's average rating from all rated rides
        const { data: ratedRides } = await supabaseAdmin
          .from('rides')
          .select('passenger_rating')
          .eq('passenger_id', passengerId)
          .not('passenger_rating', 'is', null);
        if (ratedRides && ratedRides.length > 0) {
          const avg = ratedRides.reduce((s: number, r: Record<string,unknown>) => s + parseFloat(String(r.passenger_rating)), 0) / ratedRides.length;
          await supabaseAdmin.from('profiles').update({ rating: parseFloat(avg.toFixed(2)) }).eq('id', passengerId);
        }
      }
    }

    return res.json({ success: true, rating, newDriverRating });
  } catch (err: any) {
    logger.error(`[RIDES] rating error:: ${err.message}`);
    return res.status(500).json({ error: 'Failed to save rating' });
  }
});

// ── POST /:id/dispute — passenger reports a problem with a ride ───────────────
rideRouter.post('/:id/dispute', requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const uid = req.supabaseUid!;
    const { category, description, contactEmail } = req.body as {
      category: string; description: string; contactEmail?: string;
    };

    if (!category || !description?.trim()) {
      return res.status(400).json({ error: 'category and description are required' });
    }

    const { data: ride, error: fetchErr } = await supabaseAdmin
      .from('rides')
      .select('passenger_id, driver_id, ride_status, fare')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchErr || !ride) return res.status(404).json({ error: 'Ride not found' });
    const r = ride as Record<string, unknown>;

    if (r.passenger_id !== uid) {
      return res.status(403).json({ error: 'Only the passenger can file a dispute' });
    }

    const { error } = await supabaseAdmin.from('feedback').insert({
      user_id:     uid,
      type:        'dispute',
      category,
      comment:     description.trim(),
      ride_id:     req.params.id,
      metadata:    { contactEmail: contactEmail ?? null, fare: r.fare, driverId: r.driver_id },
      created_at:  new Date().toISOString(),
    });

    if (error) throw error;

    return res.json({ success: true, message: 'Dispute filed. Our team will review within 24 hours.' });
  } catch (err: any) {
    logger.error(`[RIDES] dispute error:: ${err.message}`);
    return res.status(500).json({ error: 'Failed to file dispute' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// T003: POST /:id/no-show — driver marks passenger as no-show after arrival
//   Charges NO_SHOW_FEE ($10) to passenger's saved payment method via Stripe
// ═══════════════════════════════════════════════════════════════════════════════
rideRouter.post('/:id/no-show', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid  = req.supabaseUid!;
  const role = (req.supabaseRole || 'passenger') as UserRole;
  const isDriver = role === 'chauffeur' || role === 'driver';
  if (!isDriver) return res.status(403).json({ error: 'Only drivers can mark a no-show' });

  try {
    const { data: ride, error: fetchErr } = await supabaseAdmin
      .from('rides')
      .select('id, ride_status, driver_id, passenger_id, payment_intent_id, wait_started_at')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchErr || !ride) return res.status(404).json({ error: 'Ride not found' });
    const r = ride as Record<string, unknown>;

    if (r.driver_id !== uid) return res.status(403).json({ error: 'Not your ride' });
    if (!['driver_arrived', 'arrived', 'confirmed'].includes(String(r.ride_status))) {
      return res.status(409).json({ error: 'Driver must be at pickup location to mark no-show' });
    }

    // Verify driver has waited at least the free window before charging
    if (r.wait_started_at) {
      const waitMins = (Date.now() - new Date(r.wait_started_at as string).getTime()) / 60000;
      if (waitMins < WAIT_TIME_FREE_MINUTES) {
        return res.status(409).json({
          error: `Please wait at least ${WAIT_TIME_FREE_MINUTES} minutes before marking no-show`,
          waitedMinutes: Math.round(waitMins),
        });
      }
    }

    // Charge passenger $10 no-show fee via Stripe (capture from existing PI)
    let noShowCharged = false;
    const piId = r.payment_intent_id as string | undefined;
    if (piId) {
      const stripe = getStripe();
      if (stripe) {
        try {
          const pi = await stripe.paymentIntents.retrieve(piId);
          const feeAmountCents = Math.round(NO_SHOW_FEE * 100);
          if (pi.status === 'requires_capture') {
            const captureAmount = Math.min(feeAmountCents, pi.amount);
            await stripe.paymentIntents.capture(piId, { amount_to_capture: captureAmount });
            noShowCharged = true;
          }
        } catch (stripeErr: unknown) {
          logger.error(`[RIDES] No-show Stripe charge failed:: ${errMsg(stripeErr)}`);
        }
      }
    }

    // Cancel the ride and flag it as no-show
    await supabaseAdmin.from('rides').update({
      ride_status:  'cancelled',
      no_show:       true,
      no_show_fee:   noShowCharged ? NO_SHOW_FEE : 0,
      updated_at:    new Date().toISOString(),
      cancelled_at:  new Date().toISOString(),
      cancel_reason: 'passenger_no_show',
    }).eq('id', req.params.id);

    // Notify passenger
    notifyUser(String(r.passenger_id), {
      title: 'Ride Cancelled — No-Show',
      body:  `Your driver waited but could not find you. A $${NO_SHOW_FEE} no-show fee was applied.`,
      data: { type: 'ride_no_show', ride_id: req.params.id, screen: 'ride_summary' },
    }).catch(() => {});

    broadcastRideStatus(req.params.id, 'cancelled', { driverId: uid, passengerId: String(r.passenger_id) });

    return res.json({ success: true, noShowFee: NO_SHOW_FEE, charged: noShowCharged });
  } catch (err: any) {
    logger.error(`[RIDES] no-show error:: ${err.message}`);
    return res.status(500).json({ error: 'Failed to process no-show' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// T009 / T017: GET /:id/earnings-breakdown — per-trip earnings detail
// ═══════════════════════════════════════════════════════════════════════════════
rideRouter.get('/:id/earnings-breakdown', requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    let { data: ride, error } = await supabaseAdmin
      .from('rides')
      .select('id, fare, locked_fare, wait_fee, tip_amount, surge_multiplier, base_fare_breakdown, driver_id, ride_status, completed_at, distance_miles, duration_minutes')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error?.message?.includes('base_fare_breakdown')) {
      // Column missing — retry without it
      const fallback = await supabaseAdmin
        .from('rides')
        .select('id, fare, locked_fare, wait_fee, tip_amount, surge_multiplier, driver_id, ride_status, completed_at, distance_miles, duration_minutes')
        .eq('id', req.params.id)
        .maybeSingle();
      ride = fallback.data ? { ...fallback.data, base_fare_breakdown: null } : null;
      error = fallback.error;
    }

    if (error || !ride) return res.status(404).json({ error: 'Ride not found' });
    const r = ride as Record<string, unknown>;

    const fare         = Number(r.fare         || 0);
    const waitFee      = Number(r.wait_fee      || 0);
    const tipAmount    = Number(r.tip_amount    || 0);
    const surgeMulti   = Number(r.surge_multiplier || 1);
    const lockedFare   = Number(r.locked_fare   || fare);

    // Breakdown from stored JSON or estimated from fare
    let breakdown: Record<string,unknown> | null = null;
    if (r.base_fare_breakdown) {
      try { breakdown = JSON.parse(r.base_fare_breakdown as string); } catch {}
    }

    // URBONT takes 10% platform fee; driver earns 90% of total (excl. tip)
    const driverBase  = Math.round((lockedFare + waitFee) * 0.9 * 100) / 100;
    const driverTotal = Math.round((driverBase + tipAmount) * 100) / 100;

    return res.json({
      ride_id:        req.params.id,
      status:         r.ride_status,
      completed_at:   r.completed_at,
      fare: {
        locked:        lockedFare,
        base:          breakdown?.base_fare       ?? null,
        distance:      breakdown?.distance_charge ?? null,
        time:          breakdown?.time_charge     ?? null,
        vehicle:       breakdown?.vehicle_premium ?? null,
        airport:       breakdown?.airport_surcharge ?? null,
        booking_fee:   breakdown?.booking_fee     ?? null,
        surge:         breakdown?.surge_applied   ?? null,
        platform_fee:  breakdown?.platform_fee    ?? null,
        surge_multi:   surgeMulti,
      },
      extras: {
        wait_fee:      waitFee,
        tip:           tipAmount,
      },
      driver_earnings: {
        base:          driverBase,
        tip:           tipAmount,
        total:         driverTotal,
      },
    });
  } catch (err: any) {
    logger.error(`[RIDES] earnings-breakdown error:: ${err.message}`);
    return res.status(500).json({ error: 'Failed to get earnings breakdown' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// T017: POST /:id/adjust-tip — passenger adjusts tip up to 30 days after trip
// ═══════════════════════════════════════════════════════════════════════════════
rideRouter.post('/:id/adjust-tip', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { tipAmount } = req.body as { tipAmount?: number };

  if (typeof tipAmount !== 'number' || tipAmount < 0 || tipAmount > 200) {
    return res.status(400).json({ error: 'tipAmount must be a number between 0 and 200' });
  }

  try {
    const { data: ride, error: fetchErr } = await supabaseAdmin
      .from('rides')
      .select('passenger_id, driver_id, ride_status, completed_at, payment_intent_id, tip_amount')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchErr || !ride) return res.status(404).json({ error: 'Ride not found' });
    const r = ride as Record<string, unknown>;

    if (r.passenger_id !== uid) return res.status(403).json({ error: 'Only the passenger can adjust the tip' });
    if (r.ride_status !== 'completed') return res.status(409).json({ error: 'Ride must be completed to adjust tip' });

    // 30-day window
    const completedAt = r.completed_at ? new Date(r.completed_at as string).getTime() : 0;
    const daysSince   = (Date.now() - completedAt) / (1000 * 60 * 60 * 24);
    if (daysSince > 30) return res.status(409).json({ error: 'Tip can only be adjusted within 30 days of trip completion' });

    // Charge the tip delta via Stripe
    const oldTip  = Number(r.tip_amount || 0);
    const delta   = Math.round((tipAmount - oldTip) * 100); // cents
    if (delta > 0 && r.payment_intent_id) {
      const stripe = getStripe();
      if (stripe) {
        try {
          // Create a new PaymentIntent for the tip delta. Idempotency key is
          // anchored to rideId + the exact target tipAmount (in cents) — a
          // client retry (timeout, double-tap) that resolves to the same
          // target amount reuses the same PaymentIntent instead of charging
          // the delta twice. A genuinely different tipAmount gets a new key.
          const pi = await stripe.paymentIntents.retrieve(r.payment_intent_id as string);
          if (pi.customer) {
            await stripe.paymentIntents.create({
              amount:   delta,
              currency: 'usd',
              customer: pi.customer as string,
              confirm:  true,
              metadata: { ride_id: req.params.id, type: 'tip_adjustment' },
            }, {
              idempotencyKey: `adjust-tip_${req.params.id}_${Math.round(tipAmount * 100)}`,
            });
          }
        } catch (stripeErr: unknown) {
          logger.error(`[RIDES] Tip Stripe charge failed:: ${errMsg(stripeErr)}`);
          return res.status(502).json({ error: 'Failed to charge tip adjustment. Please try again.' });
        }
      }
    }

    // Compare-and-swap on tip_amount: only apply the update if it still matches
    // the value we read at the top of this request. Prevents a second concurrent
    // request (which computed its own delta off the same oldTip) from silently
    // overwriting the first request's result after both have charged.
    const { data: updated } = await supabaseAdmin.from('rides')
      .update({ tip_amount: tipAmount, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('tip_amount', r.tip_amount as number | null ?? 0)
      .select('id')
      .maybeSingle();

    if (!updated) {
      logger.warn(`[RIDES] adjust-tip CAS miss for ride ${req.params.id} — tip_amount changed concurrently after charge`);
    }

    // Notify driver of tip update
    notifyUser(String(r.driver_id), {
      title: 'Tip Updated',
      body:  `Your passenger updated their tip to $${tipAmount.toFixed(2)}`,
      data: { type: 'tip_updated', ride_id: req.params.id, screen: 'driver_earnings' },
    }).catch(() => {});

    return res.json({ success: true, tipAmount, previousTip: oldTip });
  } catch (err: any) {
    logger.error(`[RIDES] adjust-tip error:: ${err.message}`);
    return res.status(500).json({ error: 'Failed to adjust tip' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// T016: POST /:id/add-stop — add an intermediate stop during active ride
// ═══════════════════════════════════════════════════════════════════════════════
rideRouter.post('/:id/add-stop', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { address, lat, lng, order } = req.body as Record<string,unknown>;
  if (!address) return res.status(400).json({ error: 'address is required' });

  try {
    const { data: ride, error: fetchErr } = await supabaseAdmin
      .from('rides')
      .select('passenger_id, driver_id, ride_status, stops, fare')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchErr || !ride) return res.status(404).json({ error: 'Ride not found' });
    const r = ride as Record<string, unknown>;

    if (r.passenger_id !== uid) return res.status(403).json({ error: 'Only the passenger can add stops' });
    if (!['confirmed', 'driver_arrived', 'in_progress', 'arrived'].includes(String(r.ride_status))) {
      return res.status(409).json({ error: 'Cannot add stop at this ride stage' });
    }

    const existingStops = Array.isArray(r.stops) ? r.stops as Record<string,unknown>[] : [];
    const newStop = {
      address,
      lat:      typeof lat === 'number' ? lat : null,
      lng:      typeof lng === 'number' ? lng : null,
      order:    typeof order === 'number' ? order : existingStops.length + 1,
      added_at: new Date().toISOString(),
    };

    const updatedStops = [...existingStops, newStop];

    await supabaseAdmin.from('rides').update({
      stops:      updatedStops,
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id);

    // Notify driver of new stop
    notifyUser(String(r.driver_id), {
      title: 'New Stop Added',
      body:  `Passenger added a stop: ${address}`,
      data: { type: 'stop_added', ride_id: req.params.id, screen: 'ride_tracking' },
    }).catch(() => {});

    broadcastRideStatus(req.params.id, String(r.ride_status) as RideStatus, {
      driverId:    String(r.driver_id),
      passengerId: String(r.passenger_id),
      extra:       { stops: updatedStops },
    });

    return res.json({ success: true, stops: updatedStops });
  } catch (err: any) {
    logger.error(`[RIDES] add-stop error:: ${err.message}`);
    return res.status(500).json({ error: 'Failed to add stop' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// T021: POST /:id/change-destination — update dropoff + recalculate fare delta
// ═══════════════════════════════════════════════════════════════════════════════
rideRouter.post('/:id/change-destination', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { address, lat, lng, distanceMiles, durationMinutes } = req.body as Record<string,unknown>;
  if (!address) return res.status(400).json({ error: 'address is required' });

  try {
    const { data: ride, error: fetchErr } = await supabaseAdmin
      .from('rides')
      .select('passenger_id, driver_id, ride_status, fare, locked_fare, vehicle_type, surge_multiplier, pickup_lat, pickup_lng')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchErr || !ride) return res.status(404).json({ error: 'Ride not found' });
    const r = ride as Record<string, unknown>;

    if (r.passenger_id !== uid) return res.status(403).json({ error: 'Only the passenger can change the destination' });
    if (!['confirmed', 'in_progress'].includes(String(r.ride_status))) {
      return res.status(409).json({ error: 'Destination can only be changed for confirmed or active rides' });
    }

    // Recalculate fare if distance/duration provided
    let newFare = Number(r.fare || 0);
    let newBreakdown = null;
    if (typeof distanceMiles === 'number' && typeof durationMinutes === 'number') {
      newBreakdown = calculateFareFromRules({
        vehicleType:     String(r.vehicle_type || 'sedan'),
        distanceMiles,
        durationMinutes,
      });
      newFare = newBreakdown?.total ?? newFare;
    }

    const newDropoff = { address, lat: lat ?? null, lng: lng ?? null };

    await supabaseAdmin.from('rides').update({
      dropoff_address:     address,
      dropoff_lat:         lat ?? null,
      dropoff_lng:         lng ?? null,
      dropoff:             newDropoff,
      fare:                newFare,
      locked_fare:         newFare,
      base_fare_breakdown: newBreakdown ? JSON.stringify(newBreakdown) : null,
      updated_at:          new Date().toISOString(),
    }).eq('id', req.params.id);

    // Notify driver of destination change
    notifyUser(String(r.driver_id), {
      title: 'Destination Changed',
      body:  `New drop-off: ${address}. Updated fare: $${newFare.toFixed(2)}`,
      data: { type: 'destination_changed', ride_id: req.params.id, screen: 'ride_tracking' },
    }).catch(() => {});

    broadcastRideStatus(req.params.id, String(r.ride_status) as RideStatus, {
      driverId:    String(r.driver_id),
      passengerId: uid,
      extra:       { newDestination: address, newFare },
    });

    return res.json({ success: true, newFare, newDropoff, breakdown: newBreakdown });
  } catch (err: any) {
    logger.error(`[RIDES] change-destination error:: ${err.message}`);
    return res.status(500).json({ error: 'Failed to change destination' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// T018: GET /favorites — passenger gets their favorite drivers
// ═══════════════════════════════════════════════════════════════════════════════
rideRouter.get('/favorites', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  try {
    const { data, error } = await supabaseAdmin
      .from('favorite_drivers')
      .select('driver_id, created_at')
      .eq('passenger_id', uid)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ favorites: data || [] });
  } catch (err: any) {
    logger.error(`[RIDES] favorites fetch error:: ${err.message}`);
    return res.status(500).json({ error: 'Failed to fetch favorites' });
  }
});

// ── POST /:id/favorite — toggle a driver as favorite for this passenger ───────
rideRouter.post('/:id/favorite', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  try {
    const { data: ride, error: rideErr } = await supabaseAdmin
      .from('rides')
      .select('driver_id, passenger_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (rideErr || !ride || !(ride as Record<string,unknown>).driver_id) {
      return res.status(404).json({ error: 'Ride or driver not found' });
    }
    const r = ride as Record<string, unknown>;
    if (r.passenger_id !== uid) return res.status(403).json({ error: 'Not your ride' });

    const driverId = r.driver_id as string;

    // Check if already favorited
    const { data: existing } = await supabaseAdmin
      .from('favorite_drivers')
      .select('id')
      .eq('passenger_id', uid)
      .eq('driver_id', driverId)
      .maybeSingle();

    if (existing) {
      // Remove favorite
      await supabaseAdmin.from('favorite_drivers')
        .delete()
        .eq('passenger_id', uid)
        .eq('driver_id', driverId);
      return res.json({ success: true, action: 'removed', driverId });
    } else {
      // Add favorite
      await supabaseAdmin.from('favorite_drivers').insert({
        passenger_id: uid,
        driver_id:    driverId,
        created_at:   new Date().toISOString(),
      });
      return res.json({ success: true, action: 'added', driverId });
    }
  } catch (err: any) {
    logger.error(`[RIDES] favorite toggle error:: ${err.message}`);
    return res.status(500).json({ error: 'Failed to toggle favorite' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// T020: GET /airport-queue — driver gets their position in the airport queue
// ═══════════════════════════════════════════════════════════════════════════════
rideRouter.get('/airport-queue', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid  = req.supabaseUid!;
  const role = (req.supabaseRole || 'passenger') as UserRole;
  const isDriver = role === 'chauffeur' || role === 'driver';
  const { airport } = req.query as { airport?: string };

  try {
    let query = supabaseAdmin
      .from('airport_queue')
      .select('id, driver_id, airport_code, joined_at, position')
      .eq('active', true)
      .order('joined_at', { ascending: true });

    if (airport) query = query.eq('airport_code', airport.toUpperCase());

    const { data, error } = await query;
    if (error) throw error;

    const queue = (data || []) as Record<string,unknown>[];

    // If driver: find their position
    if (isDriver) {
      const myEntry = queue.find(q => q.driver_id === uid);
      const position = myEntry ? queue.indexOf(myEntry) + 1 : null;
      return res.json({ inQueue: !!myEntry, position, totalInQueue: queue.length, queue });
    }

    return res.json({ queue, totalInQueue: queue.length });
  } catch (err: any) {
    logger.error(`[RIDES] airport-queue fetch error:: ${err.message}`);
    return res.status(500).json({ error: 'Failed to get airport queue' });
  }
});

// ── POST /airport-queue/join — driver joins airport FIFO queue ────────────────
rideRouter.post('/airport-queue/join', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid  = req.supabaseUid!;
  const role = (req.supabaseRole || 'passenger') as UserRole;
  const isDriver = role === 'chauffeur' || role === 'driver';
  if (!isDriver) return res.status(403).json({ error: 'Only drivers can join the airport queue' });

  const { airportCode } = req.body as { airportCode?: string };
  const SUPPORTED_AIRPORTS = ['MIA', 'FLL', 'OPF'];
  const airport = (airportCode || 'MIA').toUpperCase();
  if (!SUPPORTED_AIRPORTS.includes(airport)) {
    return res.status(400).json({ error: `Unsupported airport. Supported: ${SUPPORTED_AIRPORTS.join(', ')}` });
  }

  try {
    // Remove any existing entry for this driver (re-join refreshes position)
    await supabaseAdmin.from('airport_queue').delete().eq('driver_id', uid);

    // Count current queue length to assign position
    const { count } = await supabaseAdmin.from('airport_queue')
      .select('id', { count: 'exact', head: true })
      .eq('airport_code', airport)
      .eq('active', true);

    const position = (count ?? 0) + 1;

    const { error } = await supabaseAdmin.from('airport_queue').insert({
      driver_id:    uid,
      airport_code: airport,
      joined_at:    new Date().toISOString(),
      active:       true,
      position,
    });
    if (error) throw error;

    return res.json({ success: true, airport, position });
  } catch (err: any) {
    logger.error(`[RIDES] airport-queue join error:: ${err.message}`);
    return res.status(500).json({ error: 'Failed to join airport queue' });
  }
});

// ── POST /airport-queue/leave — driver leaves airport queue ──────────────────
rideRouter.post('/airport-queue/leave', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  try {
    await supabaseAdmin.from('airport_queue').delete().eq('driver_id', uid);
    return res.json({ success: true });
  } catch (err: any) {
    logger.error(`[RIDES] airport-queue leave error:: ${err.message}`);
    return res.status(500).json({ error: 'Failed to leave airport queue' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// T011: POST /:id/long-pickup-fee — apply long pickup fee when driver is far away
//   Called when driver accepts a ride and is >LONG_PICKUP_THRESHOLD_MINS away
// ═══════════════════════════════════════════════════════════════════════════════
rideRouter.post('/:id/long-pickup-fee', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid  = req.supabaseUid!;
  const role = (req.supabaseRole || 'passenger') as UserRole;
  const isDriver = role === 'chauffeur' || role === 'driver';
  if (!isDriver) return res.status(403).json({ error: 'Driver only' });

  const { etaMinutes } = req.body as { etaMinutes?: number };

  try {
    const { data: ride, error: fetchErr } = await supabaseAdmin
      .from('rides')
      .select('driver_id, passenger_id, ride_status, fare, long_pickup_fee')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchErr || !ride) return res.status(404).json({ error: 'Ride not found' });
    const r = ride as Record<string, unknown>;
    if (r.driver_id !== uid) return res.status(403).json({ error: 'Not your ride' });
    if (r.long_pickup_fee) return res.json({ alreadyApplied: true, longPickupFee: r.long_pickup_fee });

    const applies = typeof etaMinutes === 'number' && etaMinutes >= LONG_PICKUP_THRESHOLD_MINS;
    if (!applies) return res.json({ applies: false, etaMinutes });

    const newFare = Math.round((Number(r.fare || 0) + LONG_PICKUP_FEE) * 100) / 100;

    await supabaseAdmin.from('rides').update({
      long_pickup_fee: LONG_PICKUP_FEE,
      fare:            newFare,
      updated_at:      new Date().toISOString(),
    }).eq('id', req.params.id);

    // Notify passenger that a long-pickup fee was added
    notifyUser(String(r.passenger_id), {
      title: 'Long Pickup Fee Applied',
      body:  `Your driver is ${etaMinutes} min away. A $${LONG_PICKUP_FEE} long-pickup fee was added to your fare.`,
      data: { type: 'long_pickup_fee', ride_id: req.params.id, screen: 'ride_tracking' },
    }).catch(() => {});

    return res.json({ success: true, longPickupFee: LONG_PICKUP_FEE, newFare });
  } catch (err: any) {
    logger.error(`[RIDES] long-pickup-fee error:: ${err.message}`);
    return res.status(500).json({ error: 'Failed to apply long pickup fee' });
  }
});

// ── POST /:id/tip — Charge post-trip tip via Stripe + transfer to driver ─────
rideRouter.post('/:id/tip', requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Payment service unavailable' });

    const rideId      = req.params.id;
    const passengerId = req.supabaseUid!;
    const { amount }  = req.body as { amount?: number };

    if (!amount || typeof amount !== 'number' || amount <= 0 || amount > 200) {
      return res.status(400).json({ error: 'Tip amount must be between $0.01 and $200' });
    }

    const { data: ride, error: rideErr } = await supabaseAdmin
      .from('rides')
      .select('id, ride_status, passenger_id, driver_id, tip_amount, payment_method')
      .eq('id', rideId)
      .maybeSingle();

    if (rideErr || !ride) return res.status(404).json({ error: 'Ride not found' });
    if (String(ride.passenger_id) !== passengerId) return res.status(403).json({ error: 'Not your ride' });
    if (ride.ride_status !== 'completed') return res.status(400).json({ error: 'Can only tip completed rides' });
    if (ride.payment_method === 'cash') return res.status(400).json({ error: 'Cash rides cannot be tipped via card' });
    if (Number(ride.tip_amount) > 0) return res.status(409).json({ error: 'Tip already recorded for this ride' });

    const { data: passenger } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', passengerId)
      .maybeSingle();

    const customerId = (passenger as Record<string,unknown>)?.stripe_customer_id as string | undefined;
    if (!customerId) return res.status(400).json({ error: 'No saved payment method on file. Please add a card first.' });

    const { data: driverProfile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_account_id, stripe_connect_status')
      .eq('id', String(ride.driver_id))
      .maybeSingle();

    const driverAccountId = (driverProfile as { stripe_account_id?: string; stripe_connect_status?: string } | null)?.stripe_account_id as string | undefined;
    const tipCents        = Math.round(amount * 100);

    const customerObj = await stripe.customers.retrieve(customerId);
    if ((customerObj as unknown as Record<string,unknown>).deleted) return res.status(400).json({ error: 'Payment customer not found' });

    const paymentMethods = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
    if (!paymentMethods.data.length) return res.status(400).json({ error: 'No saved card found. Please add a card first.' });
    const pmId = paymentMethods.data[0].id;

    const pi = await stripe.paymentIntents.create({
      amount:              tipCents,
      currency:            'usd',
      customer:            customerId,
      payment_method:      pmId,
      payment_method_types: ['card'],
      confirm:             true,
      off_session:         true,
      metadata:            { ride_id: rideId, type: 'tip' },
    }, {
      // Idempotency key prevents double-charging if client retries on network error
      idempotencyKey: `tip_${rideId}_${passengerId}`,
    });

    let transferId: string | undefined;
    if (driverAccountId && (driverProfile as Record<string,unknown>)?.stripe_connect_status === 'active') {
      const latestCharge = typeof pi.latest_charge === 'string' ? pi.latest_charge : undefined;
      const transfer = await stripe.transfers.create({
        amount:             tipCents,
        currency:           'usd',
        destination:        driverAccountId,
        source_transaction: latestCharge,
        metadata:           { ride_id: rideId, type: 'tip' },
      });
      transferId = transfer.id;
    }

    await supabaseAdmin.from('rides').update({
      tip_amount:  amount,
      updated_at:  new Date().toISOString(),
    }).eq('id', rideId);

    if (ride.driver_id) {
      notifyUser(String(ride.driver_id), {
        title: '💰 You received a tip!',
        body:  `Your passenger left you a $${amount.toFixed(2)} tip. Great service!`,
        data:  { type: 'tip_received', ride_id: rideId, screen: 'driver_earnings' },
      }).catch(() => {});
    }

    return res.json({ success: true, tipAmount: amount, paymentIntentId: pi.id, transferId });
  } catch (err: any) {
    logger.error(`[RIDES] tip error:: ${err.message}`);
    return res.status(500).json({ error: 'Failed to process tip', details: err.message });
  }
});

// ── GET /:id/public — unauthenticated public tracking endpoint ────────────
rideRouter.get('/:id/public', async (req: Request, res: Response) => {
  try {
    const { data: ride, error } = await supabaseAdmin
      .from('rides')
      .select('ride_status, driver_id, pickup, dropoff, driver_location')
      .eq('id', req.params.id)
      .single();

    if (error || !ride) return res.status(404).json({ error: 'Ride not found' });

    const allowedStatuses = ['confirmed', 'driver_arrived', 'in_progress', 'completed'];
    if (!allowedStatuses.includes(String(ride.ride_status))) {
      return res.status(404).json({ error: 'Tracking not available' });
    }

    let driverName = 'Your Chauffeur';
    let vehicleModel = '';
    let vehiclePlate = '';
    let driverLat: number | undefined;
    let driverLng: number | undefined;

    if (ride.driver_id) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('first_name, last_name, vehicle, location_lat, location_lng')
        .eq('id', String(ride.driver_id))
        .single();

      if (profile) {
        driverName = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || 'Your Chauffeur';
        const v = (profile.vehicle as Record<string, string>) ?? {};
        vehicleModel = [v.make, v.model].filter(Boolean).join(' ') || '';
        vehiclePlate = v.plate || '';
        driverLat = ((profile as Record<string,unknown>).location_lat as number | undefined) ?? undefined;
        driverLng = ((profile as Record<string,unknown>).location_lng as number | undefined) ?? undefined;
      }
    }

    const loc = ride.driver_location as { lat?: number; lng?: number } | null;
    if (loc?.lat) { driverLat = loc.lat; driverLng = loc.lng; }

    const pickup  = typeof ride.pickup  === 'string' ? ride.pickup  : (ride.pickup as Record<string,unknown>)?.address || '';
    const dropoff = typeof ride.dropoff === 'string' ? ride.dropoff : (ride.dropoff as Record<string,unknown>)?.address || '';

    return res.json({
      status: ride.ride_status,
      driverName,
      vehicleModel,
      vehiclePlate,
      pickup,
      dropoff,
      ...(driverLat !== undefined ? { driverLat, driverLng } : {}),
    });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch tracking data' });
  }
});
