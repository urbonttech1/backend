/**
 * Cancelar los viajes de una cuenta antes de borrarla desde el panel.
 *
 * El borrado se niega si la cuenta tiene un viaje activo o programado, porque
 * ese viaje se quedaría sin pasajero o sin conductor. Pero el panel no tenía
 * forma de cancelarlos, así que esas cuentas no se podían borrar. Con la
 * opción "cancelar sus viajes", primero se cancelan como lo haría el sistema
 * —se libera o se devuelve el cobro y se avisa a la otra persona— y después se
 * borra la cuenta como siempre.
 *
 * Un viaje en curso (pasajero a bordo) no se cancela: dejaría a alguien a
 * mitad de camino. En ese caso no se toca nada y el panel lo dice.
 */
import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';
import { devolverCobroDelViaje } from './rideRefund';
import { broadcastRideStatus } from './socketService';
import { notifyUser } from './fcm';
import { notifyRidePassenger } from './valetNotifications';
import { DUENO_BORRADO, ESTADOS_ACTIVOS, ROLES, filtroViajes, type Tipo } from './accountDeletion';

/** Los que se pueden cancelar: nadie va todavía a bordo. */
export const CANCELABLES = ['scheduled', 'searching', 'confirmed', 'driver_arrived'] as const;

export const MOTIVO = 'account_deleted';

export interface ViajeDeCuenta {
  id: string;
  ride_status: string;
  passenger_id: string | null;
  driver_id: string | null;
  payment_intent_id: string | null;
}

export type ResultadoCancelacion =
  | { ok: true; cancelados: number }
  | { ok: false; status: number; error: string; errorCode: string };

/** Si se puede seguir: ningún viaje en curso. Regla pura. */
export function planDeCancelacion(viajes: readonly ViajeDeCuenta[]):
  { ok: true; cancelar: ViajeDeCuenta[] } | { ok: false; enCurso: number } {
  const enCurso = viajes.filter(v => !(CANCELABLES as readonly string[]).includes(v.ride_status));
  if (enCurso.length) return { ok: false, enCurso: enCurso.length };
  return { ok: true, cancelar: [...viajes] };
}

/** A quién se avisa de la cancelación: la otra parte, nunca la cuenta que se borra. */
export function aQuienAvisar(viaje: ViajeDeCuenta, uid: string): { pasajero: string | null; conductor: string | null } {
  const pasajero = viaje.passenger_id && viaje.passenger_id !== uid && viaje.passenger_id !== DUENO_BORRADO ? viaje.passenger_id : null;
  const conductor = viaje.driver_id && viaje.driver_id !== uid ? viaje.driver_id : null;
  return { pasajero, conductor };
}

/** Cancela los viajes activos y programados de la cuenta. No borra nada más. */
export async function cancelarViajesDeLaCuenta(uid: string, tipo: Tipo): Promise<ResultadoCancelacion> {
  // Mismo control que el borrado: sólo cuentas de este tipo, nunca el perfil sin dueño.
  const { data: perfil, error: errPerfil } = await supabaseAdmin
    .from('profiles').select('id, role').eq('id', uid).maybeSingle();
  if (errPerfil) throw errPerfil;
  if (uid === DUENO_BORRADO || !perfil || !ROLES[tipo].includes(String(perfil.role))) {
    return { ok: false, status: 404, error: 'Cuenta no encontrada.', errorCode: 'NOT_FOUND' };
  }

  const { data, error } = await supabaseAdmin
    .from('rides')
    .select('id, ride_status, passenger_id, driver_id, payment_intent_id')
    .or(filtroViajes(uid, tipo))
    .in('ride_status', [...ESTADOS_ACTIVOS]);
  if (error) throw error;

  const plan = planDeCancelacion((data ?? []) as ViajeDeCuenta[]);
  if ('enCurso' in plan) {
    return {
      ok: false, status: 409, errorCode: 'RIDE_IN_PROGRESS',
      error: 'Tiene un viaje en curso, con el pasajero a bordo. Espera a que termine antes de borrar la cuenta.',
    };
  }

  const ahora = new Date().toISOString();
  let cancelados = 0;
  for (const viaje of plan.cancelar) {
    // Sólo si sigue cancelable: entre la consulta y ahora pudo empezar.
    const { data: hecho, error: errCancel } = await supabaseAdmin
      .from('rides')
      .update({ ride_status: 'cancelled', cancel_reason: MOTIVO, cancelled_at: ahora, updated_at: ahora })
      .eq('id', viaje.id)
      .in('ride_status', [...CANCELABLES])
      .select('id')
      .maybeSingle();
    if (errCancel) throw errCancel;
    if (!hecho) continue;
    cancelados += 1;

    // Se libera la retención, o se devuelve si ya se cobró. Nunca lanza.
    await devolverCobroDelViaje(viaje.payment_intent_id, viaje.id);

    const { pasajero, conductor } = aQuienAvisar(viaje, uid);
    broadcastRideStatus(viaje.id, 'cancelled', {
      reason: MOTIVO,
      passengerId: viaje.passenger_id ?? undefined,
      driverId: viaje.driver_id ?? undefined,
    });
    if (pasajero) {
      notifyRidePassenger(viaje.id, pasajero, {
        title: 'Ride cancelled',
        body: "This ride was cancelled and you haven't been charged.",
        data: { type: 'ride_cancelled_by_driver', ride_id: viaje.id, screen: 'ride_tracking' },
      }).catch(() => {});
    }
    if (conductor) {
      notifyUser(conductor, {
        title: 'Ride cancelled',
        body: 'This ride was cancelled.',
        data: { type: 'ride_cancelled', ride_id: viaje.id, screen: 'driver_home' },
      }).catch(() => {});
    }
  }

  logger.info(`[BORRADO] ${cancelados} viaje(s) cancelados antes de borrar la cuenta ${uid} (${tipo})`);
  return { ok: true, cancelados };
}
