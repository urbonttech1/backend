import { pool } from '../db/pool';
import { supabaseAdmin } from '../db/client';
import { createContextLogger } from '../lib/logger';
import { notifyUser, sendMulticast } from './fcm';
import { broadcastScheduledOffer, SCHEDULED_OFFER_RADIUS_KM } from './socketService';
import { recordRideOffers } from './driverRideHistory';
import { driverNotif, passengerNotif } from './notificationTemplates';
import type { Bilingue } from './pushLanguage';
import { admiteRelevo } from './reservationConfirm';

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

/**
 * How long after the reserved time the assigned chauffeur can still find and
 * start the reservation. Same margin the cron gives unclaimed reservations.
 */
export const SCHEDULED_START_GRACE_MINUTES = 30;

/**
 * Moment from which the chauffeur who reserved a ride may start it: the same
 * lead window in which the cron reminds them to head out. Starting earlier
 * would tell the passenger "on the way" days ahead and keep the chauffeur busy.
 * Null when the ride has no valid reserved time (nothing to hold back).
 */
export function scheduledStartableAt(scheduledAt: string | null | undefined, leadMinutes: number): Date | null {
  const ms = scheduledAt ? new Date(scheduledAt).getTime() : NaN;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - leadMinutes * 60 * 1000);
}

/** Tell every nearby chauffeur, at once, that a passenger reserved a future pickup. */
export async function offerScheduledRide(args: {
  rideId: string;
  vehicleType: string;
  pickupAddress: string;
  pickupLat?: number | null;
  pickupLng?: number | null;
  scheduledAt: string;
  childSeatLine?: string | Bilingue;
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

  const note = driverNotif.scheduledRideOffer(args.rideId, args.vehicleType, args.pickupAddress, args.scheduledAt, args.childSeatLine);
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
    .select('id, ride_status, driver_id, scheduled_at, passenger_id, vehicle_type, pickup, driver_confirmed_at, unconfirmed_alarm_at')
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
    driver_confirmed_at?: string | null;
    unconfirmed_alarm_at?: string | null;
  };

  if (ride.driver_id && ride.driver_id === driverId && (ride.ride_status === 'scheduled' || ride.ride_status === 'confirmed')) {
    return {
      ok: true,
      ride_status: ride.ride_status === 'confirmed' ? 'confirmed' : 'scheduled',
      reserved: ride.ride_status === 'scheduled',
      driver_id: driverId,
    };
  }
  // Si no es null, esta reserva se le quita a ese chofer por no confirmar.
  let relevoDe: string | null = null;
  if (ride.driver_id && ride.driver_id !== driverId) {
    // Relevo: el asignado no confirmó y la alarma está abierta, así que la
    // reserva está en juego y se la queda quien confirme primero. Fuera de ese
    // caso sigue siendo suya. Ver services/reservationConfirm.
    const enJuego = admiteRelevo({
      id: ride.id, driverId: ride.driver_id, rideStatus: ride.ride_status, scheduledAt: ride.scheduled_at,
      confirmRequestedAt: null, confirmedAt: ride.driver_confirmed_at ?? null, alarmAt: ride.unconfirmed_alarm_at ?? null,
    });
    if (!enJuego) {
      return { ok: false, http: 409, error: 'Another chauffeur already reserved this ride', currentStatus: ride.ride_status };
    }
    relevoDe = ride.driver_id;
    log.info({ rideId, anterior: ride.driver_id, nuevo: driverId }, 'relevo de reserva sin confirmar');
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

  // Quien toma una reserva la está confirmando con el acto mismo de tomarla,
  // así que no se le vuelve a pedir ni se le abre alarma.
  const cambios = {
    driver_id: driverId,
    ride_status: nextStatus,
    accepted_at: now,
    updated_at: now,
    driver_confirmed_at: now,
    unconfirmed_alarm_at: null,
    unconfirmed_alarm_driver_id: null,
  };
  const base = supabaseAdmin.from('rides').update(cambios).eq('id', rideId);
  // En un relevo el guardia es el chofer anterior: si ya cambió, se perdió la carrera.
  const { data: claimed, error: updateErr } = await (relevoDe ? base.eq('driver_id', relevoDe) : base.is('driver_id', null))
    .in('ride_status', ['scheduled', 'searching'])
    .select('id, ride_status, driver_id');

  if (updateErr) {
    log.error({ err: updateErr.message, rideId }, 'claim update failed');
    return { ok: false, http: 500, error: 'Could not reserve this ride' };
  }
  if (!claimed || claimed.length === 0) {
    return { ok: false, http: 409, error: 'Another chauffeur already reserved this ride', currentStatus: ride.ride_status };
  }

  if (relevoDe) {
    notifyUser(relevoDe, {
      title: 'Reservation reassigned',
      body: 'You did not confirm your reservation in time, so another chauffeur took it.',
      data: { type: 'ride_cancelled', ride_id: rideId, screen: 'driver_home' },
    }).catch(() => {});
  }

  if (ride.passenger_id) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('first_name, last_name')
      .eq('id', driverId)
      .maybeSingle();
    const fullName = [`${profile?.first_name || ''}`, `${profile?.last_name || ''}`].join(' ').trim();
    const name = fullName || 'Your chauffeur';
    notifyUser(
      ride.passenger_id,
      keepScheduled
        ? passengerNotif.chauffeurReserved(rideId, fullName || undefined, ride.scheduled_at ?? null)
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
