import cron from 'node-cron';
import { createContextLogger } from '../lib/logger';

const log = createContextLogger('CRON');
import { supabaseAdmin } from '../db/client';
import { findStaleRides, reassignRide } from '../services/rideReassignment';
import { notifyAvailableDrivers, getIo } from '../services/socketService';
import { notifyUser, sendMulticast } from '../services/fcm';
import { passengerNotif, driverNotif } from '../services/notificationTemplates';

async function anonymizeOldRides() {
  log.info('[CRON] Starting daily PII anonymization job...');
  // 30-day retention: allows support team to resolve disputes before PII is removed.
  // GDPR permits retention for legitimate interests (billing disputes, safety).
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const twentyFourHoursAgo = new Date(Date.now() - thirtyDaysMs).toISOString();

  const { data: oldRides, error } = await supabaseAdmin
    .from('rides')
    .select('id')
    .eq('ride_status', 'completed')
    .lt('completed_at', twentyFourHoursAgo);

  if (error) {
    log.error({ err: error }, '[CRON] Failed to fetch rides for anonymization');
    return;
  }

  if (!oldRides || oldRides.length === 0) {
    log.info('[CRON] No rides to anonymize.');
    return;
  }

  const ids = oldRides.map(r => r.id);
  // Redact only the actual PII fields (street addresses, personal notes).
  // Keep passenger_id and driver_id — they are internal UUIDs needed for
  // ride history queries and analytics, not human-identifiable PII.
  // Batch in groups of 100 to avoid large IN clause timeouts and allow
  // partial success if one batch fails.
  const ANONYMIZE_BATCH = 100;
  let anonymized = 0;
  let failures = 0;
  for (let i = 0; i < ids.length; i += ANONYMIZE_BATCH) {
    const batch = ids.slice(i, i + ANONYMIZE_BATCH);
    const { error: batchErr } = await supabaseAdmin
      .from('rides')
      .update({
        pickup:  { address: '[REDACTED]', lat: 0, lng: 0 },
        dropoff: { address: '[REDACTED]', lat: 0, lng: 0 },
        notes:   null,
        updated_at: new Date().toISOString(),
      })
      .in('id', batch);
    if (batchErr) {
      log.error({ err: batchErr, batchStart: i }, '[CRON] Anonymization batch failed');
      failures += batch.length;
    } else {
      anonymized += batch.length;
    }
  }
  log.info(`[CRON] Job completed. Anonymized ${anonymized} rides. Failures: ${failures}.`);
}

/**
 * Cancel searching rides that have been waiting with no driver for more than 2 hours.
 * Immediate rides (no scheduled_at) expire after 2 hours.
 * Scheduled rides expire 30 minutes after their scheduled_at has passed.
 * This prevents old rides from surfacing as available in the driver app.
 */
async function cancelExpiredSearchingRides() {
  try {
    const twoHoursAgo   = new Date(Date.now() - 2  * 60 * 60 * 1000).toISOString();
    const thirtyMinsAgo = new Date(Date.now() - 30 *      60 * 1000).toISOString();

    // Cancel immediate rides older than 2 hours
    const { data: expiredImmediate, error: e1 } = await supabaseAdmin
      .from('rides')
      .update({ ride_status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('ride_status', 'searching')
      .is('driver_id', null)
      .is('scheduled_at', null)
      .lt('created_at', twoHoursAgo)
      .select('id, passenger_id');

    // Cancel scheduled rides whose scheduled_at has passed by more than 30 minutes
    const { data: expiredScheduled, error: e2 } = await supabaseAdmin
      .from('rides')
      .update({ ride_status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('ride_status', 'searching')
      .is('driver_id', null)
      .not('scheduled_at', 'is', null)
      .lt('scheduled_at', thirtyMinsAgo)
      .select('id, passenger_id');

    if (e1) log.error({ err: e1 }, '[CRON] Cancel expired immediate rides error');
    if (e2) log.error({ err: e2 }, '[CRON] Cancel expired scheduled rides error');

    // Notify passengers of cancelled rides (no driver found)
    const allExpired = [...(expiredImmediate ?? []), ...(expiredScheduled ?? [])];
    for (const ride of (allExpired ?? []) as Array<{ id: string; passenger_id: string | null }>) {
      if (ride.passenger_id) {
        notifyUser(String(ride.passenger_id), passengerNotif.rideCancelledNoDriver(ride.id)).catch(() => {});
      }
    }

    const n = allExpired.length;
    if (n > 0) log.info(`[CRON] Cancelled ${n} expired searching ride(s) — passengers notified.`);
  } catch (err: any) {
    log.error({ err: err }, '[CRON] cancelExpiredSearchingRides error');
  }
}

// In-memory set prevents double-processing if reassignRide takes longer than the cron interval
  const reassigningRideIds = new Set<string>();

  async function staleRideWatchdog() {
  try {
    const staleRides = await findStaleRides();
    if (!staleRides.length) return;

    // Filter out rides already being processed — prevents double-reassignment if a previous
    // cron tick is still in progress (the Set guard that was declared above but never used).
    const toProcess = staleRides.filter(r => !reassigningRideIds.has(r.id));
    if (!toProcess.length) return;

    toProcess.forEach(r => reassigningRideIds.add(r.id));
    log.info(`[CRON] Watchdog found ${toProcess.length} stale ride(s). Reassigning...`);

    let results: PromiseSettledResult<{ reassigned: boolean; rideId: string; reason: string }>[] = [];
    try {
      results = await Promise.allSettled(
        toProcess.map(r =>
          reassignRide(r.id, 'driver_inactive', r.driver_id)
        )
      );
    } finally {
      // Always release locks so future ticks can process these rides if needed
      toProcess.forEach(r => reassigningRideIds.delete(r.id));
    }

    const reassigned = results.filter(
      r => r.status === 'fulfilled' && (r as PromiseFulfilledResult<{ reassigned: boolean }>).value.reassigned
    ).length;
    log.info(`[CRON] Watchdog: ${reassigned}/${toProcess.length} rides reassigned.`);
  } catch (err: any) {
    log.error({ err: err }, '[CRON] Watchdog error');
  }
}

async function autoSurge() {
  try {
    // Count online drivers in last 5 minutes
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count: onlineDrivers } = await supabaseAdmin
      .from('driver_locations')
      .select('*', { count: 'exact', head: true })
      .gte('updated_at', fiveMinAgo);

    // Count active (searching/confirmed/in_progress) rides
    const { count: activeRides } = await supabaseAdmin
      .from('rides')
      .select('*', { count: 'exact', head: true })
      .in('ride_status', ['searching', 'confirmed', 'in_progress']);

    const drivers = onlineDrivers || 0;
    const rides = activeRides || 0;

    // Calculate demand ratio
    const ratio = drivers > 0 ? rides / drivers : rides;
    let surgeMultiplier = 1.0;

    if (ratio >= 3.0) surgeMultiplier = 2.0;
    else if (ratio >= 2.0) surgeMultiplier = 1.5;
    else if (ratio >= 1.5) surgeMultiplier = 1.3;
    else if (ratio >= 1.0) surgeMultiplier = 1.15;

    // Update surge config
    const { data: existing } = await supabaseAdmin
      .from('app_config')
      .select('value')
      .eq('key', 'surge_multiplier')
      .maybeSingle();

    const currentMultiplier = existing?.value ? parseFloat(existing.value) : 1.0;

    if (Math.abs(currentMultiplier - surgeMultiplier) >= 0.05) {
      await supabaseAdmin
        .from('app_config')
        .upsert({ key: 'surge_multiplier', value: String(surgeMultiplier), updated_at: new Date().toISOString() }, { onConflict: 'key' });
      log.info(`[CRON] Surge updated: ${currentMultiplier}x → ${surgeMultiplier}x (${rides} rides / ${drivers} drivers)`);

      // Broadcast surge change to all connected clients
      const ioInstance = getIo();
      if (ioInstance) {
        ioInstance.emit('surge:changed', {
          previous: currentMultiplier,
          current: surgeMultiplier,
          dropped: currentMultiplier > 1.0 && surgeMultiplier === 1.0,
        });
      }

      // Notify online drivers when surge activates or increases
      if (surgeMultiplier > 1.0 && surgeMultiplier > currentMultiplier) {
        notifyOnlineDriversOfSurge(surgeMultiplier).catch(() => {});
      }
    }
  } catch (err: any) {
    log.error({ err: err }, '[CRON] Auto-surge error');
  }
}

async function notifyOnlineDriversOfSurge(multiplier: number) {
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: onlineDrivers } = await supabaseAdmin
      .from('driver_locations')
      .select('driver_id')
      .eq('is_online', true)
      .gte('updated_at', fiveMinAgo);

    if (!onlineDrivers?.length) return;
    const driverIds = (onlineDrivers as Array<{ driver_id: string }>).map(d => d.driver_id);

    const { data: tokenRows } = await supabaseAdmin
      .from('user_push_tokens')
      .select('token')
      .in('user_id', driverIds)
      .eq('active', true);

    const tokens = (tokenRows as Array<{ token: string }> ?? []).map(r => r.token);
    if (!tokens.length) return;

    await sendMulticast(tokens, driverNotif.surgeActive(multiplier));
    log.info(`[CRON] Surge ${multiplier}x — notified ${tokens.length} online driver token(s).`);
  } catch (err: any) {
    log.error({ err: err }, '[CRON] notifyOnlineDriversOfSurge error');
  }
}

// ── T002: Driver Acceptance Timeout ──────────────────────────────────────────
// Rides that stay 'searching' for >5 min (immediate rides only) with no driver
// accepted are re-notified to other available drivers.
// IMPORTANT: Excludes scheduled rides that are more than 90 min in the future —
// those are handled by dispatchScheduledRides below.
async function driverAcceptanceTimeout() {
  try {
    const timeoutAgo       = new Date(Date.now() - 5  * 60 * 1000).toISOString();
    const ninetyMinsFromNow = new Date(Date.now() + 90 * 60 * 1000).toISOString();

    const { data: timedOutRides } = await supabaseAdmin
      .from('rides')
      .select('id, vehicle_type, pickup_address, pickup_lat, pickup_lng, scheduled_at')
      .eq('ride_status', 'searching')
      .lt('created_at', timeoutAgo)
      .is('accepted_at', null)
      // Only immediate rides OR scheduled rides already within the 90-min window
      .or(`scheduled_at.is.null,scheduled_at.lt.${ninetyMinsFromNow}`)
      .limit(10);

    if (!timedOutRides || timedOutRides.length === 0) return;

    log.info(`[CRON] Re-dispatching ${timedOutRides.length} unaccepted ride(s)...`);
    for (const ride of (timedOutRides ?? []) as Array<{ id: string; vehicle_type: string | null; pickup_address: string | null; pickup_lat: number | null; pickup_lng: number | null; scheduled_at: string | null }>) {
      notifyAvailableDrivers(
        ride.id,
        ride.vehicle_type || 'executive',
        ride.pickup_address || 'Miami, FL',
        ride.pickup_lat ?? null,
        ride.pickup_lng ?? null,
      );
    }
  } catch (err: any) {
    log.error({ err: err }, '[CRON] Acceptance timeout error');
  }
}

// ── Scheduled Ride Dispatch (Uber/Lyft T-30 model) ───────────────────────────
// Rides booked >30 min in advance have ride_status='scheduled'.
// This cron runs every 5 minutes and:
//  1. Transitions 'scheduled' rides to 'searching' when pickup is ≤35 min away
//     (5-min buffer so the notification arrives before the ride window opens)
//  2. Sends push + socket dispatch to all matching available drivers
//  3. Also cancels any 'scheduled' rides that are overdue (missed dispatch window)
//
// After transition → 'searching', driverAcceptanceTimeout handles re-dispatch
// every 5 min until a driver accepts.
async function dispatchScheduledRides() {
  try {
    const now                = new Date();
    const thirtyFiveMinsFromNow = new Date(now.getTime() + 35 * 60 * 1000).toISOString();
    const thirtyMinsAgo      = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

    // ── Step 1: Cancel overdue 'scheduled' rides ───────────────────────────
    // If scheduled_at has passed (pickup time already gone) and still in
    // 'scheduled' status, the server missed the dispatch window — auto-cancel.
    const { data: overdueRides } = await supabaseAdmin
      .from('rides')
      .update({ ride_status: 'cancelled', cancel_reason: 'no_driver_available', updated_at: now.toISOString() })
      .eq('ride_status', 'scheduled')
      .lt('scheduled_at', thirtyMinsAgo)
      .select('id, passenger_id');

    if (overdueRides?.length) {
      log.info(`[CRON] Auto-cancelled ${overdueRides.length} overdue scheduled ride(s) (missed dispatch window)`);
      for (const ride of (overdueRides ?? []) as Array<{ id: string; passenger_id: string | null }>) {
        if (ride.passenger_id) {
          notifyUser(String(ride.passenger_id), passengerNotif.rideCancelledNoDriver(ride.id)).catch(() => {});
        }
      }
    }

    // ── Step 2: Find 'scheduled' rides entering the T-35 min window ─────────
    const { data: readyRides, error } = await supabaseAdmin
      .from('rides')
      .select('id, vehicle_type, pickup_address, pickup_lat, pickup_lng, scheduled_at, passenger_id')
      .eq('ride_status', 'scheduled')
      .is('driver_id', null)
      .gte('scheduled_at', now.toISOString())
      .lte('scheduled_at', thirtyFiveMinsFromNow)
      .limit(20);

    if (error) {
      log.error({ err: error }, '[CRON] dispatchScheduledRides query error');
      return;
    }

    if (readyRides && readyRides.length > 0) {
      log.info(`[CRON] Dispatching ${readyRides.length} scheduled ride(s) - transitioning to 'searching'...`);

      for (const ride of readyRides as Array<{ id: string; vehicle_type: string | null; pickup_address: string | null; pickup_lat: number | null; pickup_lng: number | null; scheduled_at: string | null; passenger_id: string | null }>) {
        const minutesUntil = Math.round((new Date(ride.scheduled_at!).getTime() - now.getTime()) / 60000);

        // Transition: scheduled -> searching
        const { error: updateErr } = await supabaseAdmin
          .from('rides')
          .update({ ride_status: 'searching', updated_at: now.toISOString() })
          .eq('id', ride.id)
          .eq('ride_status', 'scheduled')
          .is('driver_id', null);

        if (updateErr) {
          log.error({ rideId: ride.id, err: updateErr.message }, '[CRON] Failed to transition ride to searching');
          continue;
        }

        log.info(`[CRON]   Ride ${ride.id} (in ${minutesUntil} min)   searching - dispatching to drivers`);

        // Dispatch to drivers
        notifyAvailableDrivers(
          ride.id,
          ride.vehicle_type || 'executive',
          ride.pickup_address || 'Miami, FL',
          ride.pickup_lat ?? null,
          ride.pickup_lng ?? null,
        );

        // Notify passenger that driver search has started
        if (ride.passenger_id) {
          try {
            await notifyUser(String(ride.passenger_id), passengerNotif.scheduled15min(ride.id, minutesUntil));
            await supabaseAdmin.from('rides').update({ dispatch_35m_sent: true }).eq('id', ride.id);
          } catch (e) {
            log.error({ err: e }, '[CRON] Failed to send dispatch notification to passenger');
          }
        }
      }
    }

    // Step 3: Retry missing notifications for rides already in searching state
    const { data: retryRides } = await supabaseAdmin
      .from('rides')
      .select('id, passenger_id, scheduled_at')
      .eq('ride_status', 'searching')
      .eq('dispatch_35m_sent', false)
      .is('driver_id', null)
      .gte('scheduled_at', now.toISOString())
      .lte('scheduled_at', thirtyFiveMinsFromNow)
      .limit(20);

    for (const ride of (retryRides ?? []) as Array<{ id: string; passenger_id: string | null; scheduled_at: string }>) {
      if (!ride.passenger_id) continue;
      const minutesUntil = Math.round((new Date(ride.scheduled_at).getTime() - now.getTime()) / 60000);
      try {
        await notifyUser(String(ride.passenger_id), passengerNotif.scheduled15min(ride.id, minutesUntil));
        await supabaseAdmin.from('rides').update({ dispatch_35m_sent: true }).eq('id', ride.id);
        log.info(`[CRON] Retried dispatch notification for ride ${ride.id}`);
      } catch (e) {
        log.error({ err: e, rideId: ride.id }, '[CRON] Retry failed to send dispatch notification');
      }
    }
  } catch (err: any) {
    log.error({ err: err }, '[CRON] dispatchScheduledRides error');
  }
}

// ── Scheduled ride reminders: 24h and 1h before ──────────────────────────────
// Queries rides still in 'scheduled' status and within reminder windows.
// Uses a 10-minute window per check; with a 5-min cron this is safe from doubles.
async function sendScheduledRideReminders() {
  try {
    const now = Date.now();

    // 24h window: scheduled_at between 23h55m and 24h5m from now
    const win24hLow  = new Date(now + 23 * 60 * 60 * 1000 + 55 * 60 * 1000).toISOString();
    const win24hHigh = new Date(now + 24 * 60 * 60 * 1000 +  5 * 60 * 1000).toISOString();

    // 1h window: scheduled_at between 55m and 65m from now
    const win1hLow  = new Date(now + 55 * 60 * 1000).toISOString();
    const win1hHigh = new Date(now + 65 * 60 * 1000).toISOString();

    const [res24h, res1h] = await Promise.all([
      supabaseAdmin
        .from('rides')
        .select('id, passenger_id, scheduled_at')
        .eq('ride_status', 'scheduled')
        .gte('scheduled_at', win24hLow)
        .lte('scheduled_at', win24hHigh),
      supabaseAdmin
        .from('rides')
        .select('id, passenger_id, scheduled_at')
        .eq('ride_status', 'scheduled')
        .gte('scheduled_at', win1hLow)
        .lte('scheduled_at', win1hHigh),
    ]);

    const format = (iso: string) =>
      new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    for (const ride of (res24h.data ?? []) as Array<{ id: string; passenger_id: string | null; scheduled_at: string }>) {
      if (!ride.passenger_id) continue;
      const timeLabel = format(ride.scheduled_at);
      notifyUser(String(ride.passenger_id), passengerNotif.scheduled24h(ride.id, timeLabel)).catch(() => {});
    }

    for (const ride of (res1h.data ?? []) as Array<{ id: string; passenger_id: string | null; scheduled_at: string }>) {
      if (!ride.passenger_id) continue;
      const timeLabel = format(ride.scheduled_at);
      notifyUser(String(ride.passenger_id), passengerNotif.scheduled1h(ride.id, timeLabel)).catch(() => {});
    }

    const total = (res24h.data?.length ?? 0) + (res1h.data?.length ?? 0);
    if (total > 0) log.info(`[CRON] Scheduled ride reminders sent: ${res24h.data?.length ?? 0} ×24h, ${res1h.data?.length ?? 0} ×1h`);
  } catch (err: any) {
    log.error({ err: err }, '[CRON] sendScheduledRideReminders error');
  }
}

// ── Rate reminder: 2h after completion, if ride still unrated ────────────────
async function sendRateReminders() {
  try {
    const twoHoursAgo  = new Date(Date.now() - 2  * 60 * 60 * 1000).toISOString();
    const threeHrsAgo  = new Date(Date.now() - 3  * 60 * 60 * 1000).toISOString();

    // Completed rides 2–3 hours ago with no passenger rating (30-min window)
    const { data: unratedRides, error } = await supabaseAdmin
      .from('rides')
      .select('id, passenger_id, rating')
      .eq('ride_status', 'completed')
      .is('rating', null)
      .lte('completed_at', twoHoursAgo)
      .gte('completed_at', threeHrsAgo)
      .not('passenger_id', 'is', null);

    if (error) return;

    for (const ride of (unratedRides ?? []) as Array<{ id: string; passenger_id: string | null }>) {
      notifyUser(String(ride.passenger_id), passengerNotif.rateReminder(ride.id)).catch(() => {});
    }

    if (unratedRides?.length) {
      log.info(`[CRON] Rate reminders sent to ${unratedRides.length} passenger(s).`);
    }
  } catch (err: any) {
    log.error({ err: err }, '[CRON] sendRateReminders error');
  }
}

// ── Weekly earnings summary: every Monday at 9 AM ────────────────────────────
async function sendWeeklyEarningsSummary() {
  try {
    const now = new Date();
    // Only run on Mondays
    if (now.getDay() !== 1) return;

    // Last week: Sunday–Saturday
    const lastSunday   = new Date(now);
    lastSunday.setDate(now.getDate() - now.getDay() - 7);
    lastSunday.setHours(0, 0, 0, 0);

    const lastSaturday = new Date(lastSunday);
    lastSaturday.setDate(lastSunday.getDate() + 6);
    lastSaturday.setHours(23, 59, 59, 999);

    const { data: rides, error } = await supabaseAdmin
      .from('rides')
      .select('driver_id, fare')
      .eq('ride_status', 'completed')
      .gte('completed_at', lastSunday.toISOString())
      .lte('completed_at', lastSaturday.toISOString())
      .not('driver_id', 'is', null);

    if (error || !rides?.length) return;

    // Aggregate by driver
    const byDriver: Record<string, { earnings: number; trips: number }> = {};
    for (const r of (rides ?? []) as Array<{ driver_id: string | null; fare: number | null }>) {
      if (!r.driver_id) continue;
      if (!byDriver[r.driver_id]) byDriver[r.driver_id] = { earnings: 0, trips: 0 };
      byDriver[r.driver_id].earnings += Number(r.fare ?? 0) * 0.9; // 90% cut
      byDriver[r.driver_id].trips    += 1;
    }

    const weekLabel = `${lastSunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${lastSaturday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

    let notified = 0;
    for (const [driverId, { earnings, trips }] of Object.entries(byDriver)) {
      if (trips === 0) continue;
      notifyUser(driverId, driverNotif.weeklyEarnings(earnings, trips, weekLabel)).catch(() => {});
      notified++;
    }

    if (notified > 0) log.info(`[CRON] Weekly earnings summary sent to ${notified} driver(s) for week ${weekLabel}.`);
  } catch (err: any) {
    log.error({ err: err }, '[CRON] sendWeeklyEarningsSummary error');
  }
}

// ── T007: Driver stats cleanup — reset consecutive trip streak if offline >12h ─
async function resetStaleStreaks() {
  try {
    const twelveHrsAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const { error } = await supabaseAdmin
      .from('driver_stats')
      .update({ consecutive_trips: 0, last_updated: new Date().toISOString() })
      .lt('last_updated', twelveHrsAgo)
      .gt('consecutive_trips', 0);
    if (!error) log.info('[CRON] Stale streaks reset');
  } catch (err: any) {
    log.error({ err: err }, '[CRON] Streak reset error');
  }
}

// ── Auto-flag dormant drivers (30+ days no activity) ─────────────────────────
async function flagInactiveDrivers() {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Find drivers whose most recent completed ride is older than 30 days
    const { data: inactiveDrivers, error } = await supabaseAdmin
      .from('profiles')
      .select('id, last_active_at')
      .eq('role', 'driver')
      .eq('needs_review', false)
      .not('last_active_at', 'is', null)
      .lt('last_active_at', thirtyDaysAgo);

    if (error || !inactiveDrivers?.length) return;

    const ids = inactiveDrivers.map(d => d.id);
    await supabaseAdmin
      .from('profiles')
      .update({ needs_review: true, updated_at: new Date().toISOString() })
      .in('id', ids);

    log.info(`[CRON] Flagged ${ids.length} inactive driver(s) for review (30+ days no activity).`);
  } catch (err: any) {
    log.error({ err: err }, '[CRON] flagInactiveDrivers error');
  }
}

// ── Driver cancellation pattern detection (>3 cancels in 7 days → flag) ──────
async function checkCancellationPatterns() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Count driver cancellations per driver in the last 7 days
    const { data: cancels, error } = await supabaseAdmin
      .from('rides')
      .select('driver_id')
      .eq('ride_status', 'cancelled')
      .eq('cancelled_by', 'driver')
      .gte('updated_at', sevenDaysAgo)
      .not('driver_id', 'is', null);

    if (error || !cancels?.length) return;

    // Aggregate by driver
    const counts: Record<string, number> = {};
    for (const r of cancels) {
      if (r.driver_id) counts[r.driver_id] = (counts[r.driver_id] ?? 0) + 1;
    }

    // Flag drivers with > 3 cancellations
    const flagged = Object.entries(counts).filter(([, cnt]) => cnt > 3).map(([id]) => id);
    if (!flagged.length) return;

    await supabaseAdmin
      .from('profiles')
      .update({ needs_review: true, updated_at: new Date().toISOString() })
      .in('id', flagged)
      .eq('needs_review', false);

    log.info(`[CRON] Cancellation pattern: flagged ${flagged.length} driver(s) for review (>3 cancels/7days).`);
  } catch (err: any) {
    log.error({ err: err }, '[CRON] checkCancellationPatterns error');
  }
}

export function startCronJobs() {
  // Run immediately on startup to clear any stale rides before the first driver connects
  cancelExpiredSearchingRides().catch(() => {});

  cron.schedule('0 0 * * *', () => {
    anonymizeOldRides();
  });
  log.info('[CRON] Daily anonymization job scheduled for 00:00.');

  cron.schedule('*/2 * * * *', () => {
    staleRideWatchdog();
  });
  log.info('[CRON] Stale ride watchdog scheduled every 2 minutes.');

  cron.schedule('*/15 * * * *', () => {
    cancelExpiredSearchingRides();
  });
  log.info('[CRON] Expired searching-ride cleanup scheduled every 15 minutes.');

  cron.schedule('*/5 * * * *', () => {
    autoSurge();
  });
  log.info('[CRON] Auto-surge pricing scheduled every 5 minutes.');

  // T002: Re-dispatch unaccepted rides every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    driverAcceptanceTimeout();
  });
  log.info('[CRON] Driver acceptance timeout check scheduled every 5 minutes.');

  // Dispatch scheduled rides when they enter the 90-min pickup window
  cron.schedule('*/5 * * * *', () => {
    dispatchScheduledRides();
  });
  // Run immediately on startup in case server restarted with scheduled rides already in window
  dispatchScheduledRides().catch(() => {});
  log.info('[CRON] Scheduled ride dispatch job running every 5 minutes.');

  // Scheduled ride reminders: 24h and 1h before pickup
  cron.schedule('*/5 * * * *', () => {
    sendScheduledRideReminders();
  });
  log.info('[CRON] Scheduled ride reminder job running every 5 minutes.');

  // Rate reminders: 2h after completed rides with no rating
  cron.schedule('*/30 * * * *', () => {
    sendRateReminders();
  });
  log.info('[CRON] Rate reminder job running every 30 minutes.');

  // Weekly earnings summary: every Monday at 9 AM
  cron.schedule('0 9 * * 1', () => {
    sendWeeklyEarningsSummary();
  });
  log.info('[CRON] Weekly earnings summary scheduled for Monday 09:00.');

  // T019: Reset stale streaks every hour (drivers offline >12h lose streak)
  cron.schedule('0 * * * *', () => {
    resetStaleStreaks();
  });
  log.info('[CRON] Driver streak reset scheduled every hour.');

  // Flag dormant drivers once daily at 03:00
  cron.schedule('0 3 * * *', () => {
    flagInactiveDrivers();
  });
  log.info('[CRON] Inactive driver flagging scheduled daily at 03:00.');

  // Check cancellation patterns every 6 hours
  cron.schedule('0 */6 * * *', () => {
    checkCancellationPatterns();
  });
  log.info('[CRON] Cancellation pattern check scheduled every 6 hours.');

  // Document expiry check daily at 08:00
  cron.schedule('0 8 * * *', () => {
    checkDocumentExpiry();
  });
  log.info('[CRON] Document expiry check scheduled daily at 08:00.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Document Expiry — alert at 30d/7d, auto-suspend at 0d
// ─────────────────────────────────────────────────────────────────────────────
async function checkDocumentExpiry() {
  log.info('[CRON] Running document expiry check...');
  try {
    const now       = new Date();
    const in30days  = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const in7days   = new Date(now.getTime() +  7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const today     = now.toISOString().slice(0, 10);

    const { data: docs } = await supabaseAdmin
      .from('driver_documents')
      .select('id, driver_id, document_type, expiry_date, notified_30d, notified_7d')
      .not('expiry_date', 'is', null)
      .lte('expiry_date', in30days);

    if (!docs?.length) {
      log.info('[CRON] No expiring documents found.');
      return;
    }

    for (const doc of docs) {
      const expiry     = (doc as Record<string,unknown>).expiry_date as string;
      const driverId   = (doc as Record<string,unknown>).driver_id  as string;
      const docType    = ((doc as Record<string,unknown>).document_type as string) || 'document';
      const docId      = (doc as Record<string,unknown>).id as string;
      const n30        = (doc as Record<string,unknown>).notified_30d as boolean;
      const n7         = (doc as Record<string,unknown>).notified_7d  as boolean;

      if (expiry <= today) {
        // Expired — suspend driver
        await supabaseAdmin.from('profiles').update({
          is_online:       false,
          needs_review:    true,
          updated_at:      now.toISOString(),
        }).eq('id', driverId);

        notifyUser(driverId, {
          title: '⚠️ Document Expired — Account Suspended',
          body:  `Your ${docType} has expired. Your account has been temporarily suspended. Please upload a valid document to resume driving.`,
          data:  { type: 'document_expired', doc_id: docId, screen: 'driver_documents' },
        }).catch(() => {});

        log.info(`[CRON] Driver ${driverId} suspended — ${docType} expired on ${expiry}`);

      } else if (expiry <= in7days && !n7) {
        // 7-day warning
        notifyUser(driverId, {
          title: '⚠️ Document Expiring in 7 Days',
          body:  `Your ${docType} expires on ${expiry}. Upload a renewal now to avoid suspension.`,
          data:  { type: 'document_expiring_7d', doc_id: docId, screen: 'driver_documents' },
        }).catch(() => {});

        await supabaseAdmin.from('driver_documents')
          .update({ notified_7d: true, updated_at: now.toISOString() })
          .eq('id', docId);

        log.info(`[CRON] Driver ${driverId} notified — ${docType} expires ${expiry} (7d warning)`);

      } else if (expiry <= in30days && !n30) {
        // 30-day warning
        notifyUser(driverId, {
          title: '📋 Document Expiring in 30 Days',
          body:  `Your ${docType} expires on ${expiry}. Please renew it soon to continue driving.`,
          data:  { type: 'document_expiring_30d', doc_id: docId, screen: 'driver_documents' },
        }).catch(() => {});

        await supabaseAdmin.from('driver_documents')
          .update({ notified_30d: true, updated_at: now.toISOString() })
          .eq('id', docId);

        log.info(`[CRON] Driver ${driverId} notified — ${docType} expires ${expiry} (30d warning)`);
      }
    }
  } catch (err: any) {
    log.error({ err: err }, '[CRON] Document expiry check failed');
  }
}
