import { pool } from '../db/pool';
import { supabaseAdmin } from '../db/client';
import { createContextLogger } from '../lib/logger';
import { notifyUser, sendMulticast } from './fcm';
import { broadcastScheduledOffer, SCHEDULED_OFFER_RADIUS_KM } from './socketService';
import { recordRideOffers } from './driverRideHistory';
import { driverNotif, passengerNotif } from './notificationTemplates';

const log = createContextLogger('SCHEDULED');

const DEFAULT_LEAD_MINUTES = 30;

/** Minutes before pickup when an unclaimed reservation becomes a live request. Editable from the admin panel. */
export async function scheduledClaimLeadMinutes(): Promise<number> {
  try {
    const { rows } = await pool.query<{ value: string }>(
      `SELECT value FROM app_config WHERE key = 'scheduled_claim_lead_minutes'`,
    );
    const n = parseInt(String(rows[0]?.value ?? ''), 10);
    if (Number.isFinite(n) && n >= 5 && n <= 240) return n;
  } catch { /* missing table or key: keep the default */ }
  return DEFAULT_LEAD_MINUTES;
}

function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** Tell every nearby chauffeur, at once, that a passenger reserved a future pickup. */
export async function offerScheduledRide(args: {
  rideId: string;
  vehicleType: string;
  pickupAddress: string;
  pickupLat?: number | null;
  pickupLng?: number | null;
  scheduledAt: string;
}): Promise<void> {
  const driverIds = await broadcastScheduledOffer({
    ...args,
    radiusKm: SCHEDULED_OFFER_RADIUS_KM,
  });
  if (driverIds.length === 0) {
    log.info({ rideId: args.rideId }, 'no nearby chauffeurs for scheduled offer — it stays open');
    return;
  }

  const { data: tokenRows } = await supabaseAdmin
    .from('user_push_tokens')
    .select('user_id, token')
    .in('user_id', driverIds)
    .eq('active', true);

  const tokens = (tokenRows ?? []).map((r: { token: string }) => r.token);
  if (tokens.length === 0) return;

  const note = driverNotif.scheduledRideOffer(args.rideId, args.vehicleType, args.pickupAddress, whenLabel(args.scheduledAt));
  await sendMulticast(tokens, note);
  recordRideOffers(
    args.rideId,
    (tokenRows ?? []).map((r: { user_id: string }) => r.user_id),
    'push',
  );
}

export type ClaimResult =
  | { ok: true; ride_status: 'scheduled' | 'confirmed'; reserved: boolean; driver_id: string }
  | { ok: false; http: number; error: string; currentStatus?: string };

export function claimFailed(result: ClaimResult): result is Extract<ClaimResult, { ok: false }> {
  return result.ok === false;
}

/**
 * First chauffeur to claim a reservation keeps it.
 * Far pickups stay `scheduled` on that chauffeur's agenda.
 * Inside the lead window the same call confirms the trip so they can head out.
 */
export async function claimScheduledRide(rideId: string, driverId: string): Promise<ClaimResult> {
  const { data: row, error } = await supabaseAdmin
    .from('rides')
    .select('id, ride_status, driver_id, scheduled_at, passenger_id, vehicle_type, pickup')
    .eq('id', rideId)
    .maybeSingle();

  if (error || !row) return { ok: false, http: 404, error: 'Ride not found' };

  const ride = row as {
    id: string;
    ride_status: string;
    driver_id: string | null;
    scheduled_at: string | null;
    passenger_id: string | null;
    vehicle_type: string | null;
    pickup: { address?: string } | string | null;
  };

  if (ride.driver_id && ride.driver_id === driverId && (ride.ride_status === 'scheduled' || ride.ride_status === 'confirmed')) {
    return {
      ok: true,
      ride_status: ride.ride_status === 'confirmed' ? 'confirmed' : 'scheduled',
      reserved: ride.ride_status === 'scheduled',
      driver_id: driverId,
    };
  }
  if (ride.driver_id && ride.driver_id !== driverId) {
    return { ok: false, http: 409, error: 'Another chauffeur already reserved this ride', currentStatus: ride.ride_status };
  }
  if (ride.ride_status !== 'scheduled' && ride.ride_status !== 'searching') {
    return { ok: false, http: 409, error: 'Ride is no longer available', currentStatus: ride.ride_status };
  }

  const lead = await scheduledClaimLeadMinutes();
  const minsUntil = ride.scheduled_at
    ? (new Date(ride.scheduled_at).getTime() - Date.now()) / 60000
    : 0;
  const keepScheduled = ride.ride_status === 'scheduled' && minsUntil > lead;
  const nextStatus = keepScheduled ? 'scheduled' : 'confirmed';
  const now = new Date().toISOString();

  const { data: claimed, error: updateErr } = await supabaseAdmin
    .from('rides')
    .update({
      driver_id: driverId,
      ride_status: nextStatus,
      accepted_at: now,
      updated_at: now,
    })
    .eq('id', rideId)
    .is('driver_id', null)
    .in('ride_status', ['scheduled', 'searching'])
    .select('id, ride_status, driver_id');

  if (updateErr) {
    log.error({ err: updateErr.message, rideId }, 'claim update failed');
    return { ok: false, http: 500, error: 'Could not reserve this ride' };
  }
  if (!claimed || claimed.length === 0) {
    return { ok: false, http: 409, error: 'Another chauffeur already reserved this ride', currentStatus: ride.ride_status };
  }

  if (ride.passenger_id) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('first_name, last_name')
      .eq('id', driverId)
      .maybeSingle();
    const name = [`${profile?.first_name || ''}`, `${profile?.last_name || ''}`].join(' ').trim() || 'Your chauffeur';
    const when = ride.scheduled_at ? whenLabel(ride.scheduled_at) : 'your pickup';
    notifyUser(
      ride.passenger_id,
      keepScheduled
        ? passengerNotif.chauffeurReserved(rideId, name, when)
        : {
            title: 'Driver on the way!',
            body: `${name} accepted and is heading to you.`,
            data: { type: 'ride_confirmed', ride_id: rideId, screen: 'ride_tracking' },
          },
    ).catch(() => {});
  }

  log.info({ rideId, driverId, nextStatus, minsUntil: Math.round(minsUntil) }, 'scheduled ride claimed');
  return { ok: true, ride_status: nextStatus, reserved: keepScheduled, driver_id: driverId };
}
