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
  WAIT_TIME_FREE_MINUTES,
  LONG_PICKUP_FEE, LONG_PICKUP_THRESHOLD_MINS,
  CONSECUTIVE_TRIP_BONUS,
} from "../../config/pricing";
import { broadcastRideStatus, notifyAvailableDrivers, normalizeVehicleCategory } from "../../services/socketService";
import { sendSmsTwilio } from "../../services/twilio";
import { checkRideDeviation } from "../../services/rideCheck";
import { logger } from '../../lib/logger';
import { randomInt } from 'crypto';
import { getStripe, updateDriverStreak, pinAttemptTracker, MAX_PIN_ATTEMPTS, PIN_LOCKOUT_MS, VALET_COMMISSION_USD, errMsg, haversineKm } from './helpers';
import type { PickupDropoff, RideRow, DriverStats } from './types';

export function registerAcceptRoutes(router: Router): void {
router.get("/available", requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.post("/:id/verify-pin", requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.post('/:id/prefer-driver', requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.get('/airport-queue', requireSupabaseAuth, async (req: Request, res: Response) => {
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
router.post('/airport-queue/join', requireSupabaseAuth, async (req: Request, res: Response) => {
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
router.post('/airport-queue/leave', requireSupabaseAuth, async (req: Request, res: Response) => {
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
}
