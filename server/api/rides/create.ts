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
  calculateHourlyFare,
  WAIT_TIME_FREE_MINUTES, WAIT_TIME_FEE_PER_MIN,
  LONG_PICKUP_FEE, LONG_PICKUP_THRESHOLD_MINS,
  NO_SHOW_FEE, CANCELLATION_FEE, CANCELLATION_GRACE_MINS,
  CONSECUTIVE_TRIP_BONUS,
  normalizePaymentMethod,
} from "../../config/pricing";
import { getEffectiveSurge } from "../config";
import { ensureFaresFresh } from "../../services/fareConfig";
import { broadcastRideStatus, notifyAvailableDrivers, normalizeVehicleCategory } from "../../services/socketService";
import { sendSmsTwilio } from "../../services/twilio";
import { checkRideDeviation } from "../../services/rideCheck";
import { logger } from '../../lib/logger';
import { randomInt } from 'crypto';
import { getStripe, updateDriverStreak, pinAttemptTracker, MAX_PIN_ATTEMPTS, PIN_LOCKOUT_MS, VALET_COMMISSION_USD, errMsg } from './helpers';
import type { PickupDropoff, RideRow, DriverStats } from './types';

export function registerCreateRoutes(router: Router): void {
router.get('/calculate-fare', requireSupabaseAuth, async (req: Request, res: Response) => {
  const vehicleType = (req.query.vehicleType as string) || 'sedan';
  const bookingType = (req.query.bookingType as string) || 'distance';

  try {
    await ensureFaresFresh();
    const surgeMultiplier = await getEffectiveSurge();

    // Chofer a disposición: se cotiza por bloque de horas, no por distancia.
    // Sin esta rama la app no tenía forma de mostrar un precio por horas sin
    // llevar su propia tabla de tarifas, que es justo lo que se busca eliminar.
    if (bookingType === 'hourly') {
      const hours = parseFloat(req.query.hours as string);
      if (isNaN(hours) || hours <= 0) {
        return res.status(400).json({ error: 'hours must be a positive number when bookingType=hourly.' });
      }
      const hourly = calculateHourlyFare({ vehicleType, hours, surgeMultiplier });
      if (!hourly) return res.status(400).json({ error: `Unknown vehicleType: ${vehicleType}` });
      return res.json(hourly);
    }

    const distanceKm      = parseFloat(req.query.distanceKm as string);
    const durationMinutes = parseFloat(req.query.durationMinutes as string);
    if (isNaN(distanceKm) || isNaN(durationMinutes) || distanceKm < 0 || durationMinutes < 0) {
      return res.status(400).json({ error: 'distanceKm and durationMinutes must be non-negative numbers.' });
    }

    const distanceMiles = distanceKm * 0.621371;
    const breakdown = calculateFareFromRules({ vehicleType, distanceMiles, durationMinutes, surgeMultiplier });
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
router.get('/estimate', requireSupabaseAuth, async (req: Request, res: Response) => {
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

    // La cotización lleva el mismo surge que se va a cobrar. Sin esto, cuando la
    // app deje de calcular por su cuenta vería un precio sin recargo y se le
    // cobraría con recargo — justo la dirección que no queremos.
    await ensureFaresFresh();
    const surgeMultiplier = await getEffectiveSurge();
    const breakdown = calculateFareFromRules({ vehicleType, distanceMiles, durationMinutes, surgeMultiplier })
      ?? { total: 0, distanceMiles, durationMinutes, surge_multiplier: surgeMultiplier };
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
router.post("/", requireSupabaseAuth, async (req: Request, res: Response) => {
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
      .select('id, ride_status, created_at, updated_at')
      .eq('passenger_id', passenger_id)
      .in('ride_status', ACTIVE_STATUSES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      // Auto-cleanup stale ride: if active ride is older than 6 hours, auto-cancel it so passenger isn't blocked forever
      const lastActivity = new Date(existing.updated_at || existing.created_at).getTime();
      const ageHours = (Date.now() - lastActivity) / (1000 * 60 * 60);
      if (ageHours > 6) {
        logger.warn(`[RIDES] Stale active ride ${existing.id} (${existing.ride_status}, age: ${ageHours.toFixed(1)}h) auto-cancelled for passenger ${passenger_id}`);
        await supabaseAdmin
          .from('rides')
          .update({
            ride_status: 'cancelled',
            cancel_reason: 'system_stale_timeout',
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
      } else {
        return res.status(409).json({
          error: 'You already have an active ride in progress. Please complete or cancel it before requesting a new one.',
          code: 'ACTIVE_RIDE_EXISTS',
          ride_id: (existing as { id: string }).id,
        });
      }
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
      // Normalizado: validation.ts tipa esto como `z.string()`, así que el cliente
      // puede mandar cualquier cosa. Como `rides.payment_method` ahora lleva un
      // CHECK ('card','cash'), un valor libre —'apple_pay', por ejemplo— tumbaría
      // la reserva entera. El otro handler de este archivo ya validaba con un 400
      // (línea ~541); éste no lo hacía.
      payment_method:  normalizePaymentMethod(paymentMethod || payment_method),
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

    // ── Surge: el servidor decide, pero nunca cobra más de lo que se mostró ──
    //
    // Hasta ahora el surge no se aplicaba en ningún cálculo: el recargo que el
    // pasajero aceptaba se descartaba al recalcular, y los viernes y sábados por
    // la noche se cobraba de menos.
    //
    // Al empezar a aplicarlo aparece el riesgo opuesto, que es peor: si el reloj
    // del teléfono no coincide con la hora de Miami —un pasajero en otro huso,
    // por ejemplo— el servidor podría cobrar un recargo que nunca se mostró en
    // pantalla. Por eso se toma el MENOR de los dos mientras la app siga
    // calculando por su cuenta: se recupera el recargo legítimo y es imposible
    // cobrar por encima de lo aceptado.
    //
    // Cuando la app consuma /api/rides/estimate (su fase 5), ambos valores serán
    // el mismo y este mínimo pasa a ser inofensivo.
    await ensureFaresFresh();
    const serverSurge = await getEffectiveSurge();
    const clientSurge = typeof bodySurge === 'number' && bodySurge >= 1 ? bodySurge : null;
    const surgeMultiplier = clientSurge !== null ? Math.min(serverSurge, clientSurge) : serverSurge;

    const requestedBookingType =
      (req.body as { booking_type?: string; bookingType?: string }).booking_type ||
      (req.body as { booking_type?: string; bookingType?: string }).bookingType ||
      'now';
    const requestedHours = Number(hourly_hours ?? hourlyHoursBody);

    let fareBreakdown: object | null = null;
    if (requestedBookingType === 'hourly' && Number.isFinite(requestedHours) && requestedHours > 0) {
      // Chofer a disposición: se cobra por bloque de horas, no por distancia.
      // Hasta ahora el backend guardaba `hourly_hours` pero no calculaba nada,
      // así que el precio de estas reservas era el que mandara el cliente.
      fareBreakdown = calculateHourlyFare({
        vehicleType: finalVehicleType,
        hours:       requestedHours,
        surgeMultiplier,
      });
    } else if (typeof bodyMiles === 'number' && typeof bodyDuration === 'number') {
      fareBreakdown = calculateFareFromRules({
        vehicleType:     finalVehicleType,
        distanceMiles:   bodyMiles,
        durationMinutes: bodyDuration,
        bookingType:     requestedBookingType,
        surgeMultiplier,
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

router.post('/driver-create', requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.post("/ride/start", requireSupabaseAuth, async (req: Request, res: Response) => {
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
}
