/**
 * URBONT Notification Templates
 * Uber-style: short titles, action-oriented body, deep-link data.
 * All push notifications go through these templates for consistency.
 *
 * Cada plantilla lleva el texto en inglés y en español, y `notifyUser` le manda
 * a cada teléfono el suyo (ver `pushLanguage.ts`). `push()` exige los dos: una
 * plantilla nueva sin español no compila. El test de este archivo comprueba
 * además que ninguna quede vacía.
 *
 * Fechas y horas se reciben como instante (ISO) y se formatean aquí, en cada
 * idioma y en la zona del servicio. Antes llegaban ya escritas en inglés y con
 * la hora del servidor, que en producción es UTC.
 */
import { ZONA_SERVICIO } from './scheduledAt';
import { textoBilingue, type Bilingue, type Idioma, type Texto } from './pushLanguage';

export interface PushTemplate extends Texto {
  es?: Texto;
  data?: Record<string, string>;
}

/** Lo que tiene que devolver toda plantilla de este archivo: con español. */
export type Plantilla = PushTemplate & { es: Texto };
type Plantillas = Record<string, (...args: never[]) => Plantilla>;

function push(en: Texto, es: Texto, data: Record<string, string>): Plantilla {
  return { ...en, es, data };
}

// ── Fechas ───────────────────────────────────────────────────────────────────
const LOCALE: Record<Idioma, string> = { en: 'en-US', es: 'es-US' };

/** `3:00 PM` / `3:00 p.m.` */
function hora(iso: string, idioma: Idioma): string {
  return new Date(iso).toLocaleTimeString(LOCALE[idioma], { timeZone: ZONA_SERVICIO, hour: 'numeric', minute: '2-digit' });
}

/** `at 3:00 PM` / `a las 3:00 p.m.` (`a la 1:00 p.m.`) */
function aLaHora(iso: string, idioma: Idioma): string {
  const h = hora(iso, idioma);
  if (idioma === 'en') return `at ${h}`;
  return h.startsWith('1:') ? `a la ${h}` : `a las ${h}`;
}

/** `Wed, Nov 4 at 3:00 PM` / `mié, 4 de nov a las 3:00 p.m.` */
function diaYHora(iso: string, idioma: Idioma): string {
  const dia = new Date(iso).toLocaleDateString(LOCALE[idioma], {
    timeZone: ZONA_SERVICIO, weekday: 'short', month: 'short', day: 'numeric',
  });
  return `${dia} ${aLaHora(iso, idioma)}`;
}

/**
 * `Nov 2–Nov 8` / `2 nov–8 nov`. Sin zona a propósito: el cron arma la semana
 * con días del reloj del servidor, y en la del servicio se correría un día.
 */
function rango(desde: Date, hasta: Date, idioma: Idioma): string {
  const f = (d: Date) => d.toLocaleDateString(LOCALE[idioma], { month: 'short', day: 'numeric' });
  return `${f(desde)}–${f(hasta)}`;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

// ─────────────────────────────────────────────────────────────────────────────
// Passenger
// ─────────────────────────────────────────────────────────────────────────────
export const passengerNotif = {
  welcome(firstName?: string): Plantilla {
    return push(
      { title: "You're in!", body: `${firstName ? `${firstName}, ` : ''}your premium chauffeur is one tap away. Book your first ride now.` },
      { title: '¡Ya estás dentro!', body: `${firstName ? `${firstName}, ` : ''}tu chofer premium está a un toque. Reserva tu primer viaje ahora.` },
      { type: 'welcome', screen: 'home' },
    );
  },

  chauffeurReserved(rideId: string, driverName: string | undefined, scheduledAt: string | null): Plantilla {
    return push(
      {
        title: 'Chauffeur reserved',
        body: scheduledAt
          ? `${driverName || 'Your chauffeur'} will pick you up on ${diaYHora(scheduledAt, 'en')}.`
          : `${driverName || 'Your chauffeur'} will pick you up at your reserved time.`,
      },
      {
        title: 'Chofer reservado',
        body: scheduledAt
          ? `${driverName || 'Tu chofer'} te recogerá el ${diaYHora(scheduledAt, 'es')}.`
          : `${driverName || 'Tu chofer'} te recogerá a la hora reservada.`,
      },
      { type: 'ride_scheduled_assigned', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  rideScheduled(rideId: string): Plantilla {
    return push(
      { title: 'Ride booked ✓', body: "Nearby chauffeurs can reserve it now. You'll see who is picking you up as soon as one accepts." },
      { title: 'Viaje reservado ✓', body: 'Los choferes cercanos ya pueden tomarlo. Verás quién te recoge en cuanto uno acepte.' },
      { type: 'ride_scheduled', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  rideSearching(rideId: string): Plantilla {
    return push(
      { title: 'Finding your chauffeur', body: "You're on the list — a driver will confirm any moment now." },
      { title: 'Buscando tu chofer', body: 'Ya estás en la lista: un chofer confirmará en cualquier momento.' },
      { type: 'ride_searching', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  scheduled24h(rideId: string, scheduledAt: string): Plantilla {
    return push(
      { title: 'Ride tomorrow', body: `Your URBONT ride is set for tomorrow ${aLaHora(scheduledAt, 'en')}. We've got your chauffeur ready.` },
      { title: 'Viaje mañana', body: `Tu viaje URBONT está programado para mañana ${aLaHora(scheduledAt, 'es')}. Tu chofer ya está listo.` },
      { type: 'scheduled_reminder_24h', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  scheduled1h(rideId: string, scheduledAt: string): Plantilla {
    return push(
      { title: 'Ride in 1 hour', body: `Head to your pickup point — chauffeur assignment starts shortly. Pickup ${aLaHora(scheduledAt, 'en')}.` },
      { title: 'Viaje en 1 hora', body: `Ve a tu punto de recogida: en breve asignamos a tu chofer. Recogida ${aLaHora(scheduledAt, 'es')}.` },
      { type: 'scheduled_reminder_1h', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  scheduled15min(rideId: string, minutes: number): Plantilla {
    return push(
      { title: `Pickup in ${minutes} min`, body: "Your reservation is coming up. We're dispatching your chauffeur now." },
      { title: `Recogida en ${minutes} min`, body: 'Tu reserva está por empezar. Estamos enviando a tu chofer.' },
      { type: 'scheduled_reminder_15m', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  driverConfirmed(rideId: string, driverName?: string): Plantilla {
    return push(
      { title: "You're picked up! 🚗", body: `${driverName ? driverName : 'Your chauffeur'} accepted your ride and is on the way.` },
      { title: '¡Chofer confirmado! 🚗', body: `${driverName ? driverName : 'Tu chofer'} aceptó tu viaje y va en camino.` },
      { type: 'ride_confirmed', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  driverArrivingSoon(rideId: string, etaMin: number): Plantilla {
    return push(
      { title: `${etaMin} min away`, body: 'Your chauffeur is almost there — head to the pickup point now.' },
      { title: `A ${etaMin} min`, body: 'Tu chofer está por llegar: ve al punto de recogida.' },
      { type: 'driver_arriving_soon', ride_id: rideId, eta_min: String(etaMin), screen: 'ride_tracking' },
    );
  },

  driverArrived(rideId: string): Plantilla {
    return push(
      { title: 'Your ride is here!', body: 'Your chauffeur is waiting at pickup. Head to the vehicle.' },
      { title: '¡Tu chofer llegó!', body: 'Tu chofer te espera en el punto de recogida. Dirígete al vehículo.' },
      { type: 'driver_arrived', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  rideStarted(rideId: string): Plantilla {
    return push(
      { title: "You're on your way", body: 'Sit back, relax, and enjoy the ride.' },
      { title: 'Vas en camino', body: 'Relájate y disfruta el viaje.' },
      { type: 'ride_started', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  safetyCheckin(rideId: string): Plantilla {
    return push(
      { title: "How's the ride?", body: 'Tap here anytime to reach support or alert your emergency contact.' },
      { title: '¿Cómo va el viaje?', body: 'Toca aquí cuando quieras para hablar con soporte o avisar a tu contacto de emergencia.' },
      { type: 'safety_checkin', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  rideCompleted(rideId: string): Plantilla {
    return push(
      { title: "You've arrived!", body: 'Thanks for riding with URBONT. Rate your experience.' },
      { title: '¡Llegaste!', body: 'Gracias por viajar con URBONT. Califica tu experiencia.' },
      { type: 'ride_completed', ride_id: rideId, screen: 'ride_summary' },
    );
  },

  rateReminder(rideId: string): Plantilla {
    return push(
      { title: 'Rate your chauffeur', body: 'Got a second? Your feedback keeps URBONT premium.' },
      { title: 'Califica a tu chofer', body: '¿Tienes un segundo? Tu opinión mantiene a URBONT premium.' },
      { type: 'rate_reminder', ride_id: rideId, screen: 'ride_summary' },
    );
  },

  driverCancelledReassigning(rideId: string): Plantilla {
    return push(
      { title: 'Finding you a new chauffeur', body: "Your driver had to cancel — we're on it. Searching now." },
      { title: 'Buscando otro chofer', body: 'Tu chofer tuvo que cancelar. Ya estamos buscando otro.' },
      { type: 'driver_cancelled_reassigning', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  rideCancelledNoDriver(rideId: string): Plantilla {
    return push(
      { title: 'No chauffeur available', body: "We couldn't match a driver this time. You haven't been charged." },
      { title: 'No hay choferes disponibles', body: 'Esta vez no encontramos chofer. No se te cobró nada.' },
      { type: 'no_driver_available', ride_id: rideId, screen: 'home' },
    );
  },

  noShowFee(rideId: string, fee: number): Plantilla {
    return push(
      { title: 'Ride cancelled — no-show', body: `Your driver waited but couldn't find you. A ${usd(fee)} no-show fee applies.` },
      { title: 'Viaje cancelado: no te presentaste', body: `Tu chofer esperó, pero no te encontró. Se aplica un cargo de ${usd(fee)} por no presentarte.` },
      { type: 'ride_no_show', ride_id: rideId, screen: 'ride_summary' },
    );
  },

  // Stripe told us the charge failed and the ride row was flagged, but nobody
  // told the passenger — so the first they knew was a blocked next booking.
  paymentFailed(rideId: string): Plantilla {
    return push(
      { title: 'Payment failed', body: "We couldn't charge your card for this ride. Update your payment method to keep riding." },
      { title: 'El pago falló', body: 'No pudimos cobrar este viaje a tu tarjeta. Actualiza tu método de pago para seguir viajando.' },
      { type: 'payment_failed', ride_id: rideId, screen: 'payment_methods' },
    );
  },

  subscriptionPastDue(): Plantilla {
    return push(
      { title: 'Membership payment failed', body: 'We could not renew your URBONT membership. Update your card to keep your benefits.' },
      { title: 'Falló el pago de tu membresía', body: 'No pudimos renovar tu membresía URBONT. Actualiza tu tarjeta para conservar tus beneficios.' },
      { type: 'subscription_past_due', screen: 'subscription' },
    );
  },

  promoApplied(rideId: string, discount: number, code: string): Plantilla {
    return push(
      { title: `${usd(discount)} saved!`, body: `Promo code ${code} is applied. Enjoy the ride.` },
      { title: `¡Ahorraste ${usd(discount)}!`, body: `Se aplicó el código ${code}. Disfruta el viaje.` },
      { type: 'promo_applied', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  // ── Reserva por hora ──────────────────────────────────────────────────────
  hourlyEndingSoon(rideId: string, minutes: number): Plantilla {
    return push(
      { title: `${minutes} minutes left`, body: `Your hourly booking ends in ${minutes} minutes. Extra time is charged in 15-minute blocks.` },
      { title: `Quedan ${minutes} minutos`, body: `Tu reserva por hora termina en ${minutes} minutos. El tiempo extra se cobra en bloques de 15 minutos.` },
      { type: 'hourly_ending_soon', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  hourlyOvertimeStarted(rideId: string, blockPrice: number, blockMinutes: number): Plantilla {
    return push(
      { title: 'Your booked time is over', body: `Extra time is now ${usd(blockPrice)} every ${blockMinutes} minutes.` },
      { title: 'Terminó tu tiempo reservado', body: `Desde ahora, el tiempo extra cuesta ${usd(blockPrice)} cada ${blockMinutes} minutos.` },
      { type: 'hourly_overtime_started', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  hourlyMilesReached(rideId: string, includedMiles: number, extraMileFee: number): Plantilla {
    return push(
      { title: 'Included miles used', body: `You have used the ${includedMiles} miles included. Each extra mile is ${usd(extraMileFee)}.` },
      { title: 'Usaste las millas incluidas', body: `Ya usaste las ${includedMiles} millas incluidas. Cada milla extra cuesta ${usd(extraMileFee)}.` },
      { type: 'hourly_miles_reached', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  hourlyExtrasCharged(rideId: string, amount: number): Plantilla {
    return push(
      { title: 'Extra time and miles charged', body: `${usd(amount)} for extra time and miles was charged to your card.` },
      { title: 'Se cobró el tiempo y las millas extra', body: `Se cobraron ${usd(amount)} a tu tarjeta por tiempo y millas extra.` },
      { type: 'hourly_extras_charged', ride_id: rideId, screen: 'ride_summary' },
    );
  },

  hourlyExtrasFailed(rideId: string, amount: number): Plantilla {
    return push(
      { title: 'Payment needed', body: `We could not charge ${usd(amount)} for extra time and miles. Tap to pay with another card.` },
      { title: 'Pago pendiente', body: `No pudimos cobrar ${usd(amount)} por tiempo y millas extra. Toca para pagar con otra tarjeta.` },
      { type: 'hourly_extras_failed', ride_id: rideId, screen: 'ride_summary' },
    );
  },
} satisfies Plantillas;

// ─────────────────────────────────────────────────────────────────────────────
// Chat — either direction
// ─────────────────────────────────────────────────────────────────────────────
const CHAT_PREVIEW_MAX = 120;

/**
 * A message the other party sent during a ride.
 *
 * Chat only travelled over the socket before, so a backgrounded app received
 * nothing at all — the most common way to miss a driver asking where you are.
 *
 * El mensaje va tal cual lo escribió el otro: sólo se traduce el remitente
 * cuando no hay nombre.
 */
export function chatMessage(
  rideId: string,
  fromRole: 'chauffeur' | 'passenger',
  preview: string,
  senderName?: string,
): Plantilla {
  const nombre = senderName?.trim();
  const body = preview.length > CHAT_PREVIEW_MAX
    ? `${preview.slice(0, CHAT_PREVIEW_MAX - 1)}…`
    : preview;

  return push(
    { title: nombre || (fromRole === 'chauffeur' ? 'Your chauffeur' : 'Your passenger'), body },
    { title: nombre || (fromRole === 'chauffeur' ? 'Tu chofer' : 'Tu pasajero'), body },
    { type: 'chat_message', ride_id: rideId, from_role: fromRole, screen: 'ride_chat' },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Driver / Chauffeur
// ─────────────────────────────────────────────────────────────────────────────

const recortar = (address: string) => (address.length > 55 ? address.slice(0, 52) + '...' : address);

const RECOMPENSAS_RACHA: Record<number, Bilingue> = {
  3:  { en: 'Keep the momentum going!',                        es: '¡Sigue así!' },
  5:  { en: 'You earned a $10 bonus.',                         es: 'Ganaste un bono de $10.' },
  7:  { en: 'One full week — you earned a $20 bonus!',         es: 'Una semana completa: ¡ganaste un bono de $20!' },
  10: { en: 'Amazing consistency — $30 bonus earned.',         es: 'Constancia increíble: ganaste un bono de $30.' },
  14: { en: 'Two weeks strong — $50 bonus earned!',            es: 'Dos semanas seguidas: ¡ganaste un bono de $50!' },
  21: { en: 'Three weeks — you are a URBONT Elite driver.',    es: 'Tres semanas: eres un chofer URBONT Elite.' },
  30: { en: 'Legendary! 30-day streak — $100 bonus unlocked.', es: '¡Legendario! Racha de 30 días: desbloqueaste un bono de $100.' },
};

export const driverNotif = {
  welcome(firstName?: string): Plantilla {
    return push(
      { title: "You're ready to drive!", body: `${firstName ? `Welcome, ${firstName}! ` : ''}Go online to start earning on premium ride requests.` },
      { title: '¡Listo para conducir!', body: `${firstName ? `¡Bienvenido, ${firstName}! ` : ''}Conéctate para empezar a ganar con viajes premium.` },
      { type: 'driver_welcome', screen: 'driver_home' },
    );
  },

  // A chauffeur who accepted a reservation days ago needs the same lead time a
  // passenger gets. Before this, the first thing they heard was "leave now".
  reservationTomorrow(rideId: string, scheduledAt: string): Plantilla {
    return push(
      { title: 'Reservation tomorrow', body: `You have a reserved ride tomorrow ${aLaHora(scheduledAt, 'en')}. Plan your day around it.` },
      { title: 'Reserva mañana', body: `Tienes un viaje reservado mañana ${aLaHora(scheduledAt, 'es')}. Organiza tu día.` },
      { type: 'driver_reminder_24h', ride_id: rideId, screen: 'driver_home' },
    );
  },

  reservationInOneHour(rideId: string, scheduledAt: string): Plantilla {
    return push(
      { title: 'Reservation in 1 hour — confirm now', body: `Your reserved pickup is ${aLaHora(scheduledAt, 'en')}. Tap to confirm you are taking it.` },
      { title: 'Reserva en 1 hora: confirma ahora', body: `Tu recogida reservada es ${aLaHora(scheduledAt, 'es')}. Toca para confirmar que la tomas.` },
      // Pide la confirmación explícitamente: si no llega en unos minutos se
      // avisa al dispatcher y la reserva se ofrece a otros choferes.
      // `ride_id` lleva la app directo a esa reserva, no al tablero: el chofer
      // tiene pocos minutos para responder.
      { type: 'driver_reminder_1h', ride_id: rideId, screen: 'driver_reservation' },
    );
  },

  scheduledRideOffer(
    rideId: string,
    vehicleType: string,
    address: string,
    scheduledAt: string,
    childSeatLine?: string | Bilingue,
  ): Plantilla {
    const short = recortar(address);
    const requisito = (idioma: Idioma) => {
      const texto = childSeatLine ? textoBilingue(childSeatLine, idioma) : '';
      return texto ? ` ${texto}.` : '';
    };
    return push(
      { title: 'Scheduled ride', body: `${diaYHora(scheduledAt, 'en')} — ${vehicleType} at ${short}.${requisito('en')}` },
      { title: 'Viaje programado', body: `${diaYHora(scheduledAt, 'es')}: ${vehicleType} en ${short}.${requisito('es')}` },
      { type: 'scheduled_ride_offer', ride_id: rideId, vehicle_type: vehicleType, screen: 'ride_offer' },
    );
  },

  newRideRequest(rideId: string, vehicleType: string, address: string): Plantilla {
    const short = recortar(address);
    return push(
      { title: 'New ride request', body: `${vehicleType} — Pickup: ${short}` },
      { title: 'Nueva solicitud de viaje', body: `${vehicleType}. Recogida: ${short}` },
      { type: 'new_ride', ride_id: rideId, vehicle_type: vehicleType, screen: 'ride_offer' },
    );
  },

  tripEarnings(rideId: string, earnings: number): Plantilla {
    return push(
      { title: 'Trip complete — nice work!', body: earnings > 0 ? `You earned ${usd(earnings)} on this trip.` : 'Trip completed successfully.' },
      { title: 'Viaje completado: ¡buen trabajo!', body: earnings > 0 ? `Ganaste ${usd(earnings)} en este viaje.` : 'El viaje se completó correctamente.' },
      { type: 'trip_earnings', ride_id: rideId, screen: 'driver_earnings' },
    );
  },

  hourlyEndingSoon(rideId: string, minutes: number): Plantilla {
    return push(
      { title: `${minutes} minutes left on this booking`, body: `The hourly booking ends in ${minutes} minutes. Check with your passenger before the time runs out.` },
      { title: `Quedan ${minutes} minutos de esta reserva`, body: `La reserva por hora termina en ${minutes} minutos. Habla con tu pasajero antes de que se acabe el tiempo.` },
      { type: 'hourly_ending_soon', ride_id: rideId, screen: 'driver_home' },
    );
  },

  rideCancelledByPassenger(rideId: string): Plantilla {
    return push(
      { title: 'Ride cancelled', body: 'The passenger cancelled this ride.' },
      { title: 'Viaje cancelado', body: 'El pasajero canceló este viaje.' },
      { type: 'ride_cancelled', ride_id: rideId, screen: 'driver_home' },
    );
  },

  tipUpdated(rideId: string, tip: number): Plantilla {
    return push(
      { title: 'Tip updated 💰', body: `Your passenger bumped their tip to ${usd(tip)}.` },
      { title: 'Propina actualizada 💰', body: `Tu pasajero subió la propina a ${usd(tip)}.` },
      { type: 'tip_updated', ride_id: rideId, screen: 'driver_earnings' },
    );
  },

  stopAdded(rideId: string, address: string): Plantilla {
    return push(
      { title: 'New stop added', body: `Passenger added a stop: ${address}` },
      { title: 'Nueva parada', body: `El pasajero agregó una parada: ${address}` },
      { type: 'stop_added', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  destinationChanged(rideId: string, address: string, fare: number): Plantilla {
    return push(
      { title: 'Destination changed', body: `New drop-off: ${address}. Updated fare: ${usd(fare)}` },
      { title: 'Cambió el destino', body: `Nuevo destino: ${address}. Tarifa actualizada: ${usd(fare)}` },
      { type: 'destination_changed', ride_id: rideId, screen: 'ride_tracking' },
    );
  },

  streakMilestone(days: number, reward?: string): Plantilla {
    const msg = (idioma: Idioma) =>
      reward ?? (RECOMPENSAS_RACHA[days] ? RECOMPENSAS_RACHA[days][idioma] : idioma === 'es' ? '¡Sigue así!' : 'Keep it up!');
    return push(
      { title: `${days}-day streak! 🔥`, body: `You've driven ${days} days in a row. ${msg('en')}` },
      { title: `¡Racha de ${days} días! 🔥`, body: `Llevas ${days} días seguidos conduciendo. ${msg('es')}` },
      { type: 'streak_milestone', streak: String(days), screen: 'driver_quests' },
    );
  },

  questProgress(questTitle: string | Bilingue, progress: number, target: number, reward: string | Bilingue): Plantilla {
    return push(
      { title: 'Quest progress', body: `${progress} of ${target} — "${textoBilingue(questTitle, 'en')}". Finish to earn ${textoBilingue(reward, 'en')}.` },
      { title: 'Avance del reto', body: `${progress} de ${target}: «${textoBilingue(questTitle, 'es')}». Complétalo para ganar ${textoBilingue(reward, 'es')}.` },
      { type: 'quest_progress', screen: 'driver_quests' },
    );
  },

  questComplete(questTitle: string | Bilingue, reward: string | Bilingue): Plantilla {
    return push(
      { title: 'Quest complete! 🎉', body: `You completed "${textoBilingue(questTitle, 'en')}" and earned ${textoBilingue(reward, 'en')}!` },
      { title: '¡Reto completado! 🎉', body: `Completaste «${textoBilingue(questTitle, 'es')}» y ganaste ${textoBilingue(reward, 'es')}.` },
      { type: 'quest_complete', screen: 'driver_quests' },
    );
  },

  weeklyEarnings(earnings: number, trips: number, desde: Date, hasta: Date): Plantilla {
    return push(
      {
        title: `${usd(earnings)} earned last week`,
        body: `You completed ${trips} trip${trips !== 1 ? 's' : ''} ${rango(desde, hasta, 'en')}. New week, new goals!`,
      },
      {
        title: `Ganaste ${usd(earnings)} la semana pasada`,
        body: `Completaste ${trips} viaje${trips !== 1 ? 's' : ''} del ${rango(desde, hasta, 'es')}. ¡Nueva semana, nuevas metas!`,
      },
      { type: 'weekly_earnings', screen: 'driver_earnings' },
    );
  },

  surgeActive(multiplier: number): Plantilla {
    return push(
      { title: `${multiplier}x surge is on`, body: 'High demand near you — go online now and earn significantly more per trip!' },
      { title: `Tarifa dinámica x${multiplier}`, body: 'Hay mucha demanda cerca de ti: conéctate y gana bastante más por viaje.' },
      { type: 'surge_active', multiplier: String(multiplier), screen: 'driver_home' },
    );
  },

  surgeEnded(): Plantilla {
    return push(
      { title: 'Surge pricing ended', body: 'Demand has stabilized. Standard rates are back in effect.' },
      { title: 'Terminó la tarifa dinámica', body: 'La demanda se estabilizó. Vuelven las tarifas normales.' },
      { type: 'surge_ended', screen: 'driver_home' },
    );
  },

  backToBackBonus(count: number): Plantilla {
    return push(
      { title: `${count} rides back-to-back!`, body: 'Great run — keep accepting rides to maximize your streak.' },
      { title: `¡${count} viajes seguidos!`, body: 'Gran racha: sigue aceptando viajes para aprovecharla al máximo.' },
      { type: 'back_to_back', count: String(count), screen: 'driver_home' },
    );
  },

  // ── Revisión de limpieza del vehículo ──────────────────────────────────────
  inspectionDueSoon(dueAt: string): Plantilla {
    return push(
      { title: 'Vehicle check due soon', body: `Take your vehicle cleanliness photos before ${diaYHora(dueAt, 'en')} to keep accepting rides.` },
      { title: 'Tu revisión de limpieza vence pronto', body: `Toma las fotos de limpieza de tu vehículo antes del ${diaYHora(dueAt, 'es')} para seguir aceptando viajes.` },
      { type: 'vehicle_inspection_due_soon', screen: 'vehicle_inspection' },
    );
  },

  inspectionRequired(): Plantilla {
    return push(
      { title: 'Vehicle check required', body: 'Your cleanliness check is due. Take the photos to go back online.' },
      { title: 'Revisión de limpieza pendiente', body: 'Venció tu revisión de limpieza. Toma las fotos para volver a conectarte.' },
      { type: 'vehicle_inspection_due', screen: 'vehicle_inspection' },
    );
  },

  inspectionRejected(reason?: string | null): Plantilla {
    const motivo = reason?.trim();
    return push(
      { title: 'Vehicle photos rejected', body: `${motivo ? `${motivo}. ` : ''}Take new photos to keep accepting rides.` },
      { title: 'Fotos del vehículo rechazadas', body: `${motivo ? `${motivo}. ` : ''}Toma fotos nuevas para seguir aceptando viajes.` },
      { type: 'vehicle_inspection_rejected', screen: 'vehicle_inspection' },
    );
  },

  lowRatingWarning(rating: number): Plantilla {
    return push(
      { title: 'Rating alert', body: `Your current rating is ${rating.toFixed(2)} stars. Stay above 4.5 to keep good standing.` },
      { title: 'Alerta de calificación', body: `Tu calificación actual es de ${rating.toFixed(2)} estrellas. Mantente por encima de 4.5 para conservar tu buena reputación.` },
      { type: 'low_rating_warning', screen: 'driver_profile' },
    );
  },
} satisfies Plantillas;
