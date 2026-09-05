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

export function registerValetRoutes(router: Router): void {
router.get("/valet-pending", requireSupabaseAuth, async (req: Request, res: Response) => {
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
router.get("/valet-history", requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.post("/valet-dispatch", requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.post('/:id/valet-card-checkout', requireSupabaseAuth, async (req: Request, res: Response) => {
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
}
