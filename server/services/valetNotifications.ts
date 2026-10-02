/**
 * Push de los viajes que despacha un valet.
 *
 * El viaje de un valet se guarda con el valet como `passenger_id`, así que las
 * notificaciones de estado le llegaban con el texto del pasajero —«Your chauffeur
 * is heading to you»— sin decir de qué huésped ni de qué reserva hablaban, y al
 * tocarlas la app abría pantallas de pasajero. Aquí se reescriben para el valet.
 *
 * `paraValet` es pura para poder probarla; `notifyRidePassenger` es la que se usa
 * en las rutas y deja el mensaje intacto si el viaje no lo despachó un valet.
 */
import { supabaseAdmin } from '../db/client';
import { notifyUser, type PushPayload } from './fcm';

export interface ContextoValet {
  guest?: string | null;
  ref?: string | null;
}

/** Evento del viaje (`data.type` original) → texto para el valet. */
const TEXTOS: Record<string, { title: string; body: (quien: string) => string }> = {
  ride_confirmed:               { title: 'Driver on the way',        body: q => `A driver accepted ${q} and is heading to the pickup.` },
  ride_scheduled_started:       { title: 'Driver on the way',        body: q => `The driver for ${q} started the scheduled trip.` },
  driver_arrived:               { title: 'Driver has arrived',       body: q => `The driver for ${q} is at the pickup location.` },
  ride_started:                 { title: 'Trip started',             body: q => `${q} is now on the way.` },
  ride_completed:               { title: 'Trip completed',           body: q => `The trip for ${q} was completed.` },
  driver_cancelled_reassigning: { title: 'Looking for a new driver', body: q => `The driver for ${q} cancelled. We're searching for another one.` },
  ride_cancelled_by_driver:     { title: 'Trip cancelled',           body: q => `The driver ended the trip for ${q}.` },
  ride_scheduled:               { title: 'Driver changed',           body: q => `The reserved driver for ${q} can no longer make it. We're offering it to others.` },
  no_driver_available:          { title: 'No driver available',      body: q => `We couldn't match a driver for ${q}.` },
  ride_no_show:                 { title: 'Trip cancelled — no-show', body: q => `The driver waited but could not find ${q}.` },
};

/**
 * Reescribe el push para el valet. Los tipos que no conoce se dejan tal cual,
 * salvo la pantalla a la que lleva, que siempre es el dashboard del valet.
 */
export function paraValet(payload: PushPayload, ctx: ContextoValet = {}): PushPayload {
  const original = payload.data?.type ?? '';
  const texto = TEXTOS[original];
  const huesped = ctx.guest?.trim() || 'your guest';
  const quien = ctx.ref ? `${huesped} (${ctx.ref})` : huesped;

  const title = texto ? texto.title : payload.title;
  const body  = texto ? texto.body(quien) : payload.body;
  return {
    ...payload,
    title,
    body,
    data: {
      ...(payload.data ?? {}),
      type: 'valet_ride_update',
      event: original,
      screen: 'valet-dashboard',
      // La app pinta el aviso en pantalla a partir de `data`, no del título del push.
      title,
      body,
    },
  };
}

/** Como `notifyUser`, pero adaptando el mensaje cuando el viaje lo despachó un valet. */
export async function notifyRidePassenger(rideId: string, userId: string, payload: PushPayload): Promise<void> {
  let final = payload;
  try {
    const { data } = await supabaseAdmin.from('rides')
      .select('dispatched_by_valet, guest_name, valet_booking_ref').eq('id', rideId).maybeSingle();
    if (data?.dispatched_by_valet) {
      final = paraValet(payload, { guest: data.guest_name as string | null, ref: data.valet_booking_ref as string | null });
    }
  } catch { /* si falla la consulta, se envía el mensaje original */ }
  return notifyUser(userId, final);
}
