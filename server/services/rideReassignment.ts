/**
 * URBONT Ride Reassignment Service
 *
 * Handles all scenarios where a driver becomes unavailable mid-ride:
 *  - Phone dies / app closes after accepting (watchdog detection)
 *  - Driver disconnects during in_progress trip
 *  - Manual admin override
 *
 * On reassignment:
 *  1. Ride is reset to "searching" (driver_id cleared)
 *  2. Passenger is notified instantly via Socket.IO
 *  3. Push notification sent (fire-and-forget)
 *  4. Event logged to ride_logs for audit trail
 */

import { createContextLogger } from '../lib/logger';
import { viajesVarados } from './staleRides';
import { supabaseAdmin } from '../db/client';
import { broadcastRideStatus } from './socketService';
import { sendToToken } from './fcm';
import { recordDriverRelease } from './driverRideHistory';

const log = createContextLogger('REASSIGN');

export type ReassignReason =
  | 'driver_inactive'       // GPS silent for too long after acceptance
  | 'driver_disconnected'   // Socket disconnected, grace period expired
  | 'driver_no_location'    // Driver never sent a location update after accepting
  | 'admin_override';       // Manually triggered

export interface ReassignResult {
  reassigned: boolean;
  rideId: string;
  reason: string;
}

/**
 * Core reassignment function.
 * Safe to call multiple times — idempotent via ride_status guard.
 */
export async function reassignRide(
  rideId: string,
  reason: ReassignReason,
  oldDriverId: string,
): Promise<ReassignResult> {
  try {
    // Only reassign if still in a reassignable status (guard against double-fire)
    const { data: updated, error } = await supabaseAdmin
      .from('rides')
      .update({
        ride_status: 'searching',
        driver_id: null,
        // Mismo reloj que una cancelación del chofer: si nadie lo toma en unos
        // minutos, el cron lo cancela y avisa (services/reassignTimeout.ts).
        reassigning_since: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', rideId)
      .in('ride_status', ['confirmed', 'in_progress'])
      .eq('driver_id', oldDriverId)
      .select('id, passenger_id')
      .maybeSingle();

    if (error) {
      log.error({ err: error.message, rideId }, '[reassign] DB update failed');
      return { reassigned: false, rideId, reason: error.message };
    }

    if (!updated) {
      // Either already reassigned, completed, or cancelled — no-op
      log.info({ rideId, reason }, '[reassign] Skipped — ride no longer in reassignable state');
      return { reassigned: false, rideId, reason: 'already_resolved' };
    }

    log.info({ rideId, reason, oldDriverId }, '[reassign] Ride reset to searching');
    recordDriverRelease(rideId, oldDriverId, 'reassigned', reason);

    // Broadcast to all room listeners (passenger's SearchingScreen will update instantly)
    broadcastRideStatus(rideId, 'searching', {
      reassigned: true,
      reason,
      message: "Your driver became unavailable. We're finding a new one right now.",
    });

    // Audit log (fire-and-forget)
    void (async () => {
      try {
        await supabaseAdmin.from('ride_logs').insert({
          ride_id: rideId,
          event: 'driver_reassigned',
          metadata: { reason, old_driver_id: oldDriverId },
          created_at: new Date().toISOString(),
        });
      } catch { /* fire-and-forget */ }
    })();

    // Push notification to passenger (fire-and-forget)
    if (updated.passenger_id) {
      sendReassignPush(rideId, updated.passenger_id as string).catch(() => {});
    }

    return { reassigned: true, rideId, reason };
  } catch (err: any) {
    log.error({ err: err?.message, rideId }, '[reassign] Unexpected error');
    return { reassigned: false, rideId, reason: err?.message ?? 'unknown' };
  }
}

async function sendReassignPush(rideId: string, passengerId: string): Promise<void> {
  try {
    const { data: tokens } = await supabaseAdmin
      .from('push_subscriptions')
      .select('token')
      .eq('user_id', passengerId);

    if (!tokens?.length) return;

    const payload = {
      title: 'Finding your driver...',
      body: 'Your driver became unavailable. We are assigning a new chauffeur right now.',
      data: { type: 'ride_reassigned', ride_id: rideId, screen: 'ride_tracking' },
    };

    for (const sub of tokens) {
      if (sub.token) sendToToken(sub.token, payload).catch(() => {});
    }
  } catch { /* silent — push failure must not break the reassignment flow */ }
}

/**
 * Find all rides that are stuck in confirmed/in_progress with an inactive driver.
 * Returns array of { id, driver_id, ride_status } rows ready for reassignment.
 */
export async function findStaleRides(): Promise<Array<{
  id: string;
  driver_id: string;
  ride_status: string;
}>> {
  try {
    // confirmed rides: no driver GPS update for 5 min AND ride accepted > 4 min ago
    // in_progress rides: no driver GPS update for 12 min (longer grace — driver may be stopped)
    let data: unknown = null;
    let error: unknown = { message: 'RPC not available' };
    try {
      const result = await supabaseAdmin.rpc('find_stale_rides_fn');
      data = result.data;
      error = result.error;
    } catch { /* RPC not available, fall through to direct query */ }

    if (!error && data) return data as Array<{ id: string; driver_id: string; ride_status: string }>;

    // Fallback: direct query using Supabase filter
    // We query rides table and join against driver_locations for the updated_at check
    // Sólo se miran viajes que llevan un rato sin cambiar; el plazo por estado
    // lo aplica `viajesVarados`.
    const fourMinAgo = new Date(Date.now() - 4 * 60 * 1000).toISOString();

    const { data: confirmedRides } = await supabaseAdmin
      .from('rides')
      .select('id, driver_id, ride_status')
      .eq('ride_status', 'confirmed')
      .not('driver_id', 'is', null)
      .lt('updated_at', fourMinAgo);

    const { data: progressRides } = await supabaseAdmin
      .from('rides')
      .select('id, driver_id, ride_status')
      .eq('ride_status', 'in_progress')
      .not('driver_id', 'is', null)
      .lt('updated_at', fourMinAgo);

    const candidates = [
      ...(confirmedRides ?? []),
      ...(progressRides ?? []),
    ] as Array<{ id: string; driver_id: string; ride_status: string }>;

    if (!candidates.length) return [];

    // Cross-check driver_locations.updated_at for each unique driver
    const driverIds = [...new Set(candidates.map(r => r.driver_id))];
    const { data: locations } = await supabaseAdmin
      .from('driver_locations')
      .select('driver_id, updated_at')
      .in('driver_id', driverIds);

    const locationMap = new Map<string, string>(
      (locations ?? []).map((l: { driver_id: string; updated_at: string }) => [l.driver_id, l.updated_at])
    );

    // La decisión vive en services/staleRides.ts. Antes, un chofer SIN posición
    // guardada se daba por varado siempre, así que mientras las escrituras de
    // GPS fallaban se le quitaba el viaje a todo el mundo pasados cuatro
    // minutos: el pasajero iba a bordo y su viaje volvía a «buscando».
    return viajesVarados(
      candidates.map(r => ({ ...r, ultimaPosicion: locationMap.get(r.driver_id) ?? null })),
      new Date(),
    ).map(({ id, driver_id, ride_status }) => ({ id, driver_id, ride_status }));
  } catch (err: any) {
    log.error({ err: err?.message }, '[findStaleRides] Query failed');
    return [];
  }
}
