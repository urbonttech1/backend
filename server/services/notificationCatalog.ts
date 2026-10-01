/**
 * Catálogo de notificaciones para el panel.
 *
 * Las plantillas de `notificationTemplates.ts` son funciones, así que no se
 * pueden listar sin invocarlas: aquí se renderizan con datos de ejemplo para
 * enseñar el texto exacto que recibe el usuario.
 *
 * `trigger` y `wiredIn` se mantienen a mano. `wiredIn` dice desde qué archivo
 * se envía hoy, y `null` significa que la plantilla existe pero **no la llama
 * nadie**: está definida y nunca se dispara. Esa distinción es el motivo de
 * esta pantalla, porque desde el código no se ve de un vistazo.
 * Revisado el 2026-09-30.
 */
import { passengerNotif, driverNotif, chatMessage, type PushTemplate } from './notificationTemplates';

export type Audience = 'passenger' | 'driver' | 'chat';

/**
 * - `template`: se envia usando esta plantilla.
 * - `inline`: la notificacion si sale, pero el texto esta escrito a mano en el
 *   sitio que la envia y esta plantilla no la usa nadie. El usuario la recibe
 *   con otras palabras.
 * - `none`: no la envia nadie. Esta escrita y nunca se dispara.
 */
export type CatalogStatus = 'template' | 'inline' | 'none';

export interface CatalogEntry {
  key:      string;
  audience: Audience;
  title:    string;
  body:     string;
  type:     string | null;
  screen:   string | null;
  trigger:  string;
  status:   CatalogStatus;
  sentFrom: string | null;
}

const RIDE = 'ride-0000';

function entry(
  key: string,
  audience: Audience,
  tpl: PushTemplate,
  trigger: string,
  status: CatalogStatus,
  sentFrom: string | null,
): CatalogEntry {
  return {
    key,
    audience,
    title:  tpl.title,
    body:   tpl.body,
    type:   tpl.data?.type   ?? null,
    screen: tpl.data?.screen ?? null,
    trigger,
    status,
    sentFrom,
  };
}

export function buildNotificationCatalog(): CatalogEntry[] {
  const p = passengerNotif;
  const d = driverNotif;

  return [
    // ── Pasajero ─────────────────────────────────────────────────────────────
    entry('welcome', 'passenger', p.welcome('Ana'),
      'Al completar el registro de un pasajero nuevo.', 'template', 'api/users.ts'),
    entry('chauffeurReserved', 'passenger', p.chauffeurReserved(RIDE, 'Carlos', 'mañana a las 9:00'),
      'Cuando un conductor reserva una carrera programada.', 'template', 'services/scheduledOffer.ts'),
    entry('rideScheduled', 'passenger', p.rideScheduled(RIDE),
      'Al crear una carrera programada, antes de que nadie la acepte.', 'inline', 'api/rides/create.ts, cancel.ts'),
    entry('rideSearching', 'passenger', p.rideSearching(RIDE),
      'Mientras se busca conductor para una carrera inmediata.', 'inline', 'api/rides/create.ts'),
    entry('driverConfirmed', 'passenger', p.driverConfirmed(RIDE, 'Carlos'),
      'Cuando un conductor acepta la carrera.', 'inline', 'api/rides/status.ts, services/scheduledOffer.ts'),
    entry('driverArrivingSoon', 'passenger', p.driverArrivingSoon(RIDE, 3),
      'Cuando el conductor está a pocos minutos del punto de recogida.', 'none', null),
    entry('driverArrived', 'passenger', p.driverArrived(RIDE),
      'Cuando el conductor llega al punto de recogida.', 'inline', 'api/rides/status.ts'),
    entry('rideStarted', 'passenger', p.rideStarted(RIDE),
      'Al iniciarse el trayecto.', 'inline', 'api/rides/status.ts'),
    entry('safetyCheckin', 'passenger', p.safetyCheckin(RIDE),
      'Comprobación de seguridad durante un trayecto largo.', 'none', null),
    entry('rideCompleted', 'passenger', p.rideCompleted(RIDE),
      'Al finalizar el trayecto.', 'inline', 'api/rides/status.ts'),
    entry('rateReminder', 'passenger', p.rateReminder(RIDE),
      'Recordatorio para puntuar un trayecto sin valorar.', 'template', 'jobs/cron.ts'),
    entry('driverCancelledReassigning', 'passenger', p.driverCancelledReassigning(RIDE),
      'Cuando el conductor cancela y se busca otro.', 'inline', 'api/driver-incidents.ts, api/rides/cancel.ts'),
    entry('rideCancelledNoDriver', 'passenger', p.rideCancelledNoDriver(RIDE),
      'Cuando se agota la búsqueda sin encontrar conductor.', 'template', 'jobs/cron.ts'),
    entry('noShowFee', 'passenger', p.noShowFee(RIDE, 12),
      'Al cobrar la penalización por no presentarse.', 'inline', 'api/rides/cancel.ts'),
    entry('paymentFailed', 'passenger', p.paymentFailed(RIDE),
      'Cuando Stripe rechaza el cobro de un trayecto.', 'template', 'api/integrations.ts'),
    entry('subscriptionPastDue', 'passenger', p.subscriptionPastDue(),
      'Cuando la suscripción queda impagada.', 'template', 'api/integrations.ts'),
    entry('promoApplied', 'passenger', p.promoApplied(RIDE, 20, 'FIRST20'),
      'Al aplicarse un código promocional.', 'none', null),

    // ── Chat ─────────────────────────────────────────────────────────────────
    entry('chatMessage', 'chat', chatMessage(RIDE, 'chauffeur', 'Estoy llegando'),
      'Cada mensaje de chat entre pasajero y conductor.', 'template', 'api/translation.ts'),

    // ── Conductor ────────────────────────────────────────────────────────────
    entry('welcome', 'driver', d.welcome('Carlos'),
      'Al completar el registro de un conductor nuevo.', 'template', 'api/users.ts'),
    entry('newRideRequest', 'driver', d.newRideRequest(RIDE, 'executive', 'Calle 82 #45'),
      'Oferta de carrera inmediata a los conductores conectados.', 'inline', 'services/fcm.ts'),
    entry('scheduledRideOffer', 'driver', d.scheduledRideOffer(RIDE, 'executive', 'Calle 82 #45', 'mañana a las 9:00'),
      'Oferta de carrera programada a los conductores cercanos.', 'template', 'services/scheduledOffer.ts'),
    entry('reservationTomorrow', 'driver', d.reservationTomorrow(RIDE, '9:00'),
      'Recordatorio la víspera de una reserva aceptada.', 'template', 'jobs/cron.ts'),
    entry('reservationInOneHour', 'driver', d.reservationInOneHour(RIDE, '9:00'),
      'Recordatorio una hora antes de una reserva aceptada.', 'template', 'jobs/cron.ts'),
    entry('tripEarnings', 'driver', d.tripEarnings(RIDE, 24.5),
      'Al cerrarse un trayecto, con lo ganado.', 'template', 'api/rides/status.ts'),
    entry('rideCancelledByPassenger', 'driver', d.rideCancelledByPassenger(RIDE),
      'Cuando el pasajero cancela una carrera ya aceptada.', 'inline', 'api/rides/status.ts, api/rides/cancel.ts'),
    entry('tipUpdated', 'driver', d.tipUpdated(RIDE, 5),
      'Cuando el pasajero añade o cambia la propina.', 'none', null),
    entry('stopAdded', 'driver', d.stopAdded(RIDE, 'Carrera 45 #80'),
      'Cuando el pasajero añade una parada durante el trayecto.', 'inline', 'api/rides/checkin.ts'),
    entry('destinationChanged', 'driver', d.destinationChanged(RIDE, 'Carrera 45 #80', 32),
      'Cuando el pasajero cambia el destino durante el trayecto.', 'inline', 'api/rides/checkin.ts'),
    entry('streakMilestone', 'driver', d.streakMilestone(7, '20 USD'),
      'Al encadenar varios días seguidos conectado.', 'template', 'api/drivers.ts'),
    entry('questProgress', 'driver', d.questProgress('25 viajes', 12, 25, '50 USD'),
      'Avance parcial de un reto semanal.', 'template', 'api/rides/status.ts'),
    entry('questComplete', 'driver', d.questComplete('25 viajes', '50 USD'),
      'Al completar un reto semanal.', 'template', 'api/rides/status.ts'),
    entry('weeklyEarnings', 'driver', d.weeklyEarnings(640, 38, 'esta semana'),
      'Resumen semanal de ingresos.', 'template', 'jobs/cron.ts'),
    entry('surgeActive', 'driver', d.surgeActive(1.6),
      'Cuando se activa un multiplicador de tarifa por demanda.', 'template', 'jobs/cron.ts'),
    entry('surgeEnded', 'driver', d.surgeEnded(),
      'Cuando termina el multiplicador por demanda.', 'none', null),
    entry('backToBackBonus', 'driver', d.backToBackBonus(3),
      'Bonus por encadenar trayectos sin pausa.', 'none', null),
    entry('lowRatingWarning', 'driver', d.lowRatingWarning(4.2),
      'Aviso cuando la valoración media baja del umbral.', 'none', null),
  ];
}
