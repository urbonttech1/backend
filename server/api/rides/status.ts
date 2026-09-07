import { Router, Request, Response } from "express";
import { requireSupabaseAuth, validateBody } from "../../middleware";
import { supabaseAdmin } from "../../db/client";
import { pool } from "../../db/pool";
import { sendRideReceipt } from "../../services/email";
import { isEmailConfigured } from "../../services/mailer";
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
import { calculateRideMetrics } from "../../services/rideMetrics";
import type { PickupDropoff, RideRow, DriverStats } from './types';

export function registerStatusRoutes(router: Router): void {
router.get("/:id", requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.patch("/:id/status", requireSupabaseAuth, async (req: Request, res: Response) => {
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
        stripe.paymentIntents.retrieve(r.payment_intent_id as string).then(async (retrievedPi) => {
          let pi = retrievedPi;
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
                logger.warn(`[RIDES] Could not update PI amount for wait_fee: ${errMsg(updateErr)}`);
              }
            }
            pi = await stripe.paymentIntents.capture(r.payment_intent_id as string);
            logger.info(`[RIDES] Captured payment ${r.payment_intent_id} for completed ride ${req.params.id}`);
          }

          // Distribute driver payout and valet commission once payment is settled
          if (pi.status === 'succeeded') {
            const capturedAmountCents = pi.amount_received ?? pi.amount;
            const fareUSD = capturedAmountCents / 100;
            const metrics = calculateRideMetrics({ totalFareUSD: Math.max(1, fareUSD) });
            const driverPayoutUSD = metrics.driverPayoutCents / 100;
            const platformFeeUSD = metrics.applicationFeeCents / 100;
            const assignedDriverId = String(r.driver_id || updates.driver_id || (isDriver ? uid : ''));

            let driverTransferId: string | null = null;
            if (assignedDriverId) {
              const { data: driverProfile } = await supabaseAdmin
                .from('profiles')
                .select('stripe_account_id, stripe_connect_status')
                .eq('id', assignedDriverId)
                .maybeSingle();

              const driverAccountId = driverProfile?.stripe_account_id;
              const isConnectActive = driverProfile?.stripe_connect_status === 'active';

              if (driverAccountId && isConnectActive) {
                try {
                  const latestCharge = typeof pi.latest_charge === 'string' ? pi.latest_charge : undefined;
                  const transfer = await stripe.transfers.create({
                    amount: metrics.driverPayoutCents,
                    currency: 'usd',
                    destination: driverAccountId,
                    source_transaction: latestCharge,
                    description: `Driver payout (90%) for completed ride ${req.params.id}`,
                    metadata: {
                      ride_id: req.params.id,
                      driver_id: assignedDriverId,
                      type: 'driver_ride_payout',
                      total_fare_cents: String(metrics.totalCents),
                      driver_payout_cents: String(metrics.driverPayoutCents),
                      platform_fee_cents: String(metrics.applicationFeeCents),
                    },
                  }, {
                    idempotencyKey: `driver_payout_${req.params.id}_${pi.id}`,
                  });
                  driverTransferId = transfer.id;
                  logger.info(`[RIDES] Dispersed driver payout $${driverPayoutUSD} (90%) to ${driverAccountId} (transfer: ${transfer.id}) for ride ${req.params.id}`);
                } catch (transferErr: unknown) {
                  logger.error(`[RIDES] Failed to transfer driver payout for ride ${req.params.id}: ${errMsg(transferErr)}`);
                }
              } else {
                logger.warn(`[RIDES] Driver ${assignedDriverId} has no active Stripe Connect account (status: ${driverProfile?.stripe_connect_status || 'not_connected'}). Payout of $${driverPayoutUSD} logged as pending.`);
              }
            }

            // Always update ride record with financial breakdown and transfer ID
            await supabaseAdmin.from('rides').update({
              driver_earnings: driverPayoutUSD,
              platform_fee: platformFeeUSD,
              ...(driverTransferId ? { stripe_transfer_id: driverTransferId } : {}),
              updated_at: new Date().toISOString(),
            }).eq('id', req.params.id);

            // Valet commission: if ride was referred/assisted by a valet and hasn't been paid yet
            const valetUserId = (r as Record<string, unknown>).valet_user_id as string | undefined;
            const valetCommissionPaid = (r as Record<string, unknown>).valet_commission_paid as boolean | undefined;
            if (valetUserId && !valetCommissionPaid) {
              try {
                const { data: valetProfile } = await supabaseAdmin
                  .from('profiles')
                  .select('stripe_account_id, stripe_connect_status')
                  .eq('id', valetUserId)
                  .maybeSingle();

                if (valetProfile?.stripe_account_id && valetProfile?.stripe_connect_status === 'active') {
                  const valetTransfer = await stripe.transfers.create({
                    amount: Math.round(VALET_COMMISSION_USD * 100),
                    currency: 'usd',
                    destination: valetProfile.stripe_account_id,
                    description: `Valet commission ($${VALET_COMMISSION_USD}) for ride ${req.params.id}`,
                    metadata: {
                      ride_id: req.params.id,
                      valet_user_id: valetUserId,
                      type: 'valet_commission',
                    },
                  }, {
                    idempotencyKey: `valet_payout_${req.params.id}_${pi.id}`,
                  });

                  await supabaseAdmin.from('rides').update({
                    valet_commission_paid: true,
                    valet_commission_transfer_id: valetTransfer.id,
                  }).eq('id', req.params.id);

                  logger.info(`[RIDES] Valet commission $${VALET_COMMISSION_USD} transferred to valet ${valetUserId} (transfer: ${valetTransfer.id}) for ride ${req.params.id}`);
                } else {
                  logger.warn(`[RIDES] Valet ${valetUserId} has no active Stripe Connect account; commission pending.`);
                }
              } catch (valetErr: unknown) {
                logger.error(`[RIDES] Failed to transfer valet commission for ride ${req.params.id}: ${errMsg(valetErr)}`);
              }
            }
          }
        }).catch((err: unknown) => {
          logger.error(`[RIDES] Stripe capture/transfer failed for ride ${req.params.id}: ${(err as Error)?.message}`);
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

router.post('/:id/send-receipt', requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data: ride, error } = await supabaseAdmin
      .from('rides')
      .select(`
        id, created_at, pickup_address, dropoff_address, fare, tip_amount, promo_discount,
        distance_miles, duration_minutes, vehicle_type, ride_status, stops,
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

    if (!isEmailConfigured()) {
      return res.status(503).json({ error: 'Email not configured' });
    }

    // Same template as the automatic receipt (services/email.ts). This endpoint
    // used to carry a second, divergent copy, so the layout a passenger got
    // depended on whether the receipt was automatic or resent from the panel.
    const rideRec = ride as Record<string, unknown>;
    const sent = await sendRideReceipt({
      passengerEmail: email,
      passengerName:  passenger ? `${passenger.first_name || ''} ${passenger.last_name || ''}`.trim() || 'Passenger' : 'Passenger',
      driverName:     driver ? `${driver.first_name || ''} ${driver.last_name || ''}`.trim() : 'Your Chauffeur',
      vehicleType:    String(rideRec.vehicle_type || 'Sedan'),
      pickupAddress:  String(rideRec.pickup_address || ''),
      dropoffAddress: String(rideRec.dropoff_address || ''),
      distanceMiles:  parseFloat(String(rideRec.distance_miles ?? 0)),
      durationMin:    Math.round(Number(rideRec.duration_minutes ?? 0)),
      fare:           Number(rideRec.fare ?? 0),
      tip:            rideRec.tip_amount    != null ? Number(rideRec.tip_amount)    : undefined,
      discount:       rideRec.promo_discount != null ? Number(rideRec.promo_discount) : undefined,
      paymentMethod:  'Card on file',
      rideDate:       new Date(String(rideRec.created_at)).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      rideId:         String(rideRec.id),
      stops:          (rideRec.stops as string[]) || [],
    });

    if (!sent) return res.status(502).json({ error: 'Failed to send receipt' });
    res.json({ success: true });
  } catch (err: any) {
    logger.error(`[RIDES] receipt email error:: ${err.message}`);
    res.status(500).json({ error: 'Failed to send receipt' });
  }
});

// ── NEW: POST /api/rides/ride/start — Protocolo PIN ──────────────────────────
// The driver submits the verification PIN given by the passenger.
// The ride status only advances to in_progress if the PIN is correct.

router.post("/ride-check", requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.post('/:id/rating', requireSupabaseAuth, async (req: Request, res: Response) => {
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

router.get('/:id/public', async (req: Request, res: Response) => {
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
}
