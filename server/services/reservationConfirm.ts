/**
 * Confirmación del chofer en una reserva, y alarma si no responde.
 *
 * El recordatorio de 1 h ya le llegaba al chofer asignado, pero era sólo
 * informativo: nadie sabía si lo había visto. Un chofer que no se presenta se
 * descubría a la hora del viaje, con el pasajero esperando.
 *
 * Ahora ese recordatorio pide una confirmación explícita. Si pasados unos
 * minutos no llega, se abre una alarma en el panel para que el dispatcher
 * llame, y la reserva se ofrece a otros choferes EN PARALELO: no se le quita
 * al asignado, pero el primero que confirme se la queda.
 *
 * Reglas puras, sin base de datos, para poder probarlas.
 */

/** Minutos que tiene el chofer para confirmar antes de que salte la alarma. */
export const MINUTOS_PARA_CONFIRMAR = 10;

/** Tipo de incidente con el que la alarma aparece en el panel. */
export const TIPO_ALARMA = 'reservation_unconfirmed';

export interface ReservaParaConfirmar {
  id: string;
  driverId: string | null;
  rideStatus: string;
  scheduledAt: string | Date | null;
  /** Cuándo se le pidió confirmar. */
  confirmRequestedAt: string | Date | null;
  /** Cuándo confirmó. */
  confirmedAt: string | Date | null;
  /** Cuándo se abrió la alarma; `null` si no hay ninguna. */
  alarmAt: string | Date | null;
}

export function confirmacionActiva(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.RESERVATION_CONFIRM ?? '').trim().toLowerCase() !== 'off';
}

const ms = (v: string | Date | null | undefined): number => (v ? new Date(v).getTime() : NaN);

/** Estados en los que la reserva sigue pendiente de que el chofer salga. */
const ESPERANDO = ['scheduled', 'confirmed'];

/**
 * Si hay que pedirle confirmación a este chofer. Se pide una sola vez, al
 * mandarle el recordatorio, y sólo si la reserva ya tiene dueño.
 */
export function debePedirConfirmacion(r: ReservaParaConfirmar): boolean {
  if (!confirmacionActiva()) return false;
  return !!r.driverId && !r.confirmRequestedAt && ESPERANDO.includes(r.rideStatus);
}

/**
 * Si hay que abrir la alarma: se le pidió, no respondió y ya pasó el plazo.
 * Una reserva sin chofer no entra: de ésa se encarga el despacho de los 30 min.
 */
export function debeAlarmar(
  r: ReservaParaConfirmar,
  ahora: number = Date.now(),
  minutos: number = MINUTOS_PARA_CONFIRMAR,
): boolean {
  if (!confirmacionActiva()) return false;
  if (!r.driverId || r.confirmedAt || r.alarmAt) return false;
  if (!ESPERANDO.includes(r.rideStatus)) return false;
  const pedido = ms(r.confirmRequestedAt);
  if (!Number.isFinite(pedido)) return false;
  // Pasada la hora del viaje ya no sirve alarmar: lo cubre el no-show.
  const cita = ms(r.scheduledAt);
  if (Number.isFinite(cita) && ahora > cita) return false;
  return ahora - pedido >= minutos * 60_000;
}

export type MotivoDeCierre = 'confirmada' | 'otro-chofer' | 'ya-no-espera' | null;

/**
 * Por qué una alarma abierta deja de tener sentido. `null` = sigue abierta.
 *
 * `driverIdOriginal` es el chofer que tenía la reserva cuando saltó la alarma:
 * si ahora es otro, alguien la tomó y el dispatcher ya no necesita llamar.
 */
export function motivoDeCierre(r: ReservaParaConfirmar, driverIdOriginal: string | null): MotivoDeCierre {
  if (r.confirmedAt) return 'confirmada';
  if (driverIdOriginal && r.driverId && r.driverId !== driverIdOriginal) return 'otro-chofer';
  if (!ESPERANDO.includes(r.rideStatus)) return 'ya-no-espera';
  return null;
}

/**
 * Si otro chofer puede quedarse una reserva que ya tiene dueño.
 *
 * Sólo mientras la alarma está abierta: el asignado no respondió, así que la
 * reserva está en juego. Fuera de ese caso sigue siendo suya.
 */
export function admiteRelevo(r: ReservaParaConfirmar): boolean {
  return confirmacionActiva() && !!r.alarmAt && !r.confirmedAt && ESPERANDO.includes(r.rideStatus);
}

/** Lo que lee el dispatcher en el panel. El teléfono va aquí porque es para llamar. */
export function textoDeAlarma(d: {
  driverName?: string | null;
  driverPhone?: string | null;
  scheduledAt?: string | null;
  pickupAddress?: string | null;
}): string {
  const partes = [
    `${d.driverName || 'El chofer'} no confirmó la reserva tras ${MINUTOS_PARA_CONFIRMAR} min.`,
    d.driverPhone ? `Teléfono: ${d.driverPhone}.` : 'Sin teléfono en el perfil.',
    d.scheduledAt ? `Recogida: ${new Date(d.scheduledAt).toISOString()}.` : null,
    d.pickupAddress ? `En: ${d.pickupAddress}.` : null,
    'La reserva se está ofreciendo a otros choferes.',
  ];
  return partes.filter(Boolean).join(' ');
}
