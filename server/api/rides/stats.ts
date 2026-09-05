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
import { getStripe, updateDriverStreak, pinAttemptTracker, MAX_PIN_ATTEMPTS, PIN_LOCKOUT_MS, VALET_COMMISSION_USD, errMsg } from './helpers';
import type { PickupDropoff, RideRow, DriverStats } from './types';

export function registerStatsRoutes(router: Router): void {
router.get("/", requireSupabaseAuth, async (req: Request, res: Response) => {
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
router.get("/my", requireSupabaseAuth, async (req: Request, res: Response) => {
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
router.patch("/:id/hide", requireSupabaseAuth, async (req: Request, res: Response) => {
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
router.post("/hide-all", requireSupabaseAuth, async (req: Request, res: Response) => {
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
router.post("/restore-all", requireSupabaseAuth, async (req: Request, res: Response) => {
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
router.get("/driver-history", requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.get("/driver-active", requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.get('/heatmap', requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.get('/export', requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.get('/:id/earnings-breakdown', requireSupabaseAuth, async (req: Request, res: Response) => {
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
router.post('/:id/adjust-tip', requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.get('/favorites', requireSupabaseAuth, async (req: Request, res: Response) => {
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
router.post('/:id/favorite', requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.post('/:id/tip', requireSupabaseAuth, async (req: Request, res: Response) => {
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
}
