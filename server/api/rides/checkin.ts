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
import { logger } from '../../lib/logger';
import { randomInt } from 'crypto';
import { getStripe, updateDriverStreak, pinAttemptTracker, MAX_PIN_ATTEMPTS, PIN_LOCKOUT_MS, VALET_COMMISSION_USD, errMsg, isDriverNearby } from './helpers';
import type { PickupDropoff, RideRow, DriverStats } from './types';

export function registerCheckinRoutes(router: Router): void {
router.post("/driver-checkin/:id", requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.post('/:id/passenger-message', requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.post('/:id/add-stop', requireSupabaseAuth, async (req: Request, res: Response) => {
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
router.post('/:id/change-destination', requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.post('/:id/long-pickup-fee', requireSupabaseAuth, async (req: Request, res: Response) => {
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
}
