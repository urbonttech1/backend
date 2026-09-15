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
import { recordDriverRelease } from "../../services/driverRideHistory";
import { sendSmsTwilio } from "../../services/twilio";
import { checkRideDeviation } from "../../services/rideCheck";
import { logger } from '../../lib/logger';
import { randomInt } from 'crypto';
import { getStripe, updateDriverStreak, pinAttemptTracker, MAX_PIN_ATTEMPTS, PIN_LOCKOUT_MS, VALET_COMMISSION_USD, errMsg } from './helpers';
import type { PickupDropoff, RideRow, DriverStats } from './types';

export function registerCancelRoutes(router: Router): void {
router.post("/cancel/:id", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { reason, cancelledBy } = req.body;
    const { data: ride, error: fetchErr } = await supabaseAdmin.from('rides')
      .select('fare, scheduled_at, ride_status, payment_intent_id, passenger_id, driver_id, updated_at, accepted_at')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchErr || !ride) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    const rideStatus = (ride as any).ride_status;
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

      const passengerIdStr = String((ride as any).passenger_id || '');
      const driverIdStr    = String((ride as any).driver_id || '');

      // El viaje acaba de perder su driver_id: se guarda para que el conductor
      // lo siga viendo como cancelado en su historial.
      recordDriverRelease(req.params.id, driverIdStr, 'driver_cancelled', reason || 'driver_cancelled');

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
          (ride as any).vehicle_type || 'executive',
          (ride as any).pickup_address || 'Miami, FL',
          (ride as any).pickup_lat ?? null,
          (ride as any).pickup_lng ?? null,
        );
      } catch {}

      logger.info(`[RIDES] Driver ${driverIdStr} cancelled ride ${req.params.id} — reset to searching for reassignment`);
      return res.json({ success: true, reassigning: true, cancellationFee: 0 });
    }

    const stripe = getStripe();
    const piId = (ride as any).payment_intent_id ?? undefined;
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
          const acceptedTimestamp = (ride as any).accepted_at || (ride as any).updated_at || Date.now();
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

    let { error: cancelErr, data: cancelledRows } = await supabaseAdmin.from('rides').update({
      ride_status: 'cancelled',
      cancel_reason: reason || null,
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id)
      .eq('ride_status', rideStatus) // Atomic check: only cancel if status hasn't changed since we read it above
      .select('id');

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
      }).eq('id', req.params.id)
        .eq('ride_status', rideStatus)
        .select('id');
      cancelErr = baseCancel.error;
      cancelledRows = baseCancel.data;
    }

    if (cancelErr) throw cancelErr;

    // If 0 rows were updated, the ride's status changed between our initial read and
    // this write (e.g. a driver accepted at the same moment). Any Stripe refund/charge
    // above was already computed off the state we read, so it may no longer match — log
    // loudly for manual reconciliation and tell the client to re-check rather than
    // silently reporting success against a ride state that no longer exists.
    if (!cancelledRows || cancelledRows.length === 0) {
      logger.warn(`[RIDES] Cancel had no effect for ${req.params.id}: expected status ${rideStatus}, but it changed before the cancel write landed. Stripe action (fee=${fee}) was already applied against the stale state — needs manual reconciliation if fee/refund looks wrong.`);
      const { data: current } = await supabaseAdmin.from('rides').select('ride_status').eq('id', req.params.id).maybeSingle();
      return res.status(409).json({
        error: 'Ride status changed while cancelling — please refresh and try again.',
        currentStatus: (current as Record<string, unknown> | null)?.ride_status ?? null,
      });
    }

    const ridePassengerId = String((ride as any).passenger_id || '');
    const rideDriverId    = String((ride as any).driver_id || '');

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

router.post('/:rideId/cancel-and-credit', requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.post('/:id/dispute', requireSupabaseAuth, async (req: Request, res: Response) => {
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
router.post('/:id/no-show', requireSupabaseAuth, async (req: Request, res: Response) => {
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

    // Cancel the ride and flag it as no-show.
    //
    // El resultado SE COMPROBA: `no_show` y `no_show_fee` no existían en la tabla,
    // así que PostgREST rechazaba el update completo y el viaje quedaba activo
    // pese a haberle cobrado ya el cargo al pasajero — y sin error en el log,
    // porque este update se ignoraba. Las columnas ya existen (ver migrations.ts),
    // pero si esto vuelve a fallar hay dinero cobrado sin contraparte y tiene que
    // quedar registrado con el importe para poder conciliarlo con Stripe.
    const { error: cancelErr } = await supabaseAdmin.from('rides').update({
      ride_status:  'cancelled',
      no_show:       true,
      no_show_fee:   noShowCharged ? NO_SHOW_FEE : 0,
      updated_at:    new Date().toISOString(),
      cancelled_at:  new Date().toISOString(),
      cancel_reason: 'passenger_no_show',
    }).eq('id', req.params.id);

    if (cancelErr) {
      logger.error(
        `[RIDES] No-show cancel FAILED for ride ${req.params.id}: ${cancelErr.message}. ` +
        `Charged=${noShowCharged} fee=${noShowCharged ? NO_SHOW_FEE : 0}. Ride left ACTIVE — needs manual review.`,
      );
      return res.status(500).json({ error: 'Could not cancel the ride. Support has been notified.' });
    }

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
}
