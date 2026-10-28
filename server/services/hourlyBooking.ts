/**
 * Reserva por hora: las cuentas, sin base de datos.
 *
 * El pasajero reserva un bloque de horas con unas millas incluidas. Al terminar
 * se cobra aparte lo que pase del bloque: el tiempo extra, por bloques de 15
 * minutos con 5 de cortesía, y las millas por encima de las incluidas.
 *
 * Las millas las mide el servidor con el GPS del chofer (hourlyTracking.ts).
 * Aquí sólo se decide qué punto cuenta y cuánto vale cada cosa, para que las
 * reglas que tocan dinero tengan tests sin levantar nada.
 */
import {
  HOURLY_OVERTIME_GRACE_MINUTES,
  HOURLY_OVERTIME_INCREMENT_MINUTES,
  type FareClass,
} from '../config/pricing';

export const METROS_POR_MILLA = 1609.344;

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r1 = (n: number): number => Math.round(n * 10) / 10;

// ── Condiciones de la reserva ────────────────────────────────────────────────

/**
 * Lo que el pasajero aceptó al reservar. Se congela en `rides.hourly_terms`:
 * si el admin cambia la tabla después, esta reserva se cobra como se vendió.
 */
export interface TerminosPorHora {
  booked_hours:               number;
  per_hour:                   number;
  miles_per_hour:             number;
  extra_mile_fee:             number;
  /** El recargo de la reserva. Multiplica la hora, también la extra; nunca la milla. */
  surge_multiplier:           number;
  overtime_increment_minutes: number;
  overtime_grace_minutes:     number;
}

export function terminosDeReserva(rule: FareClass, horas: number, surge = 1): TerminosPorHora {
  return {
    booked_hours:               Math.max(rule.minHours, horas),
    per_hour:                   rule.perHour,
    miles_per_hour:             rule.milesPerHour,
    extra_mile_fee:             rule.extraMileFee,
    surge_multiplier:           Number.isFinite(surge) && surge > 0 ? surge : 1,
    overtime_increment_minutes: HOURLY_OVERTIME_INCREMENT_MINUTES,
    overtime_grace_minutes:     HOURLY_OVERTIME_GRACE_MINUTES,
  };
}

/** Lee lo guardado en la base, que puede llegar como texto. `null` si no sirve. */
export function leerTerminos(raw: unknown): TerminosPorHora | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' ? v : Number(v));
  const t: TerminosPorHora = {
    booked_hours:               n(o.booked_hours),
    per_hour:                   n(o.per_hour),
    miles_per_hour:             n(o.miles_per_hour),
    extra_mile_fee:             n(o.extra_mile_fee),
    surge_multiplier:           n(o.surge_multiplier ?? 1),
    overtime_increment_minutes: n(o.overtime_increment_minutes ?? HOURLY_OVERTIME_INCREMENT_MINUTES),
    overtime_grace_minutes:     n(o.overtime_grace_minutes ?? HOURLY_OVERTIME_GRACE_MINUTES),
  };
  const valido = Object.values(t).every((v) => Number.isFinite(v) && v >= 0)
    && t.booked_hours > 0 && t.overtime_increment_minutes > 0;
  return valido ? t : null;
}

export const millasIncluidas = (t: TerminosPorHora): number => r2(t.booked_hours * t.miles_per_hour);

/** Un bloque de tiempo extra, con el recargo de la reserva. */
export const precioBloqueExtra = (t: TerminosPorHora): number =>
  r2(t.per_hour * t.surge_multiplier * t.overtime_increment_minutes / 60);

// ── Horas que se pueden pedir ────────────────────────────────────────────────

export type ValidacionHoras =
  | { ok: true; hours: number }
  | { ok: false; errorCode: 'HOURS_OUT_OF_RANGE' | 'HOURLY_DISABLED'; minHours: number; maxHours: number };

/** Horas enteras entre el mínimo y el máximo de la clase, y la clase con la reserva activa. */
export function validarHoras(rule: FareClass, raw: unknown): ValidacionHoras {
  const minHours = rule.minHours;
  const maxHours = Math.max(rule.minHours, rule.maxHours);
  if (!rule.hourlyEnabled) return { ok: false, errorCode: 'HOURLY_DISABLED', minHours, maxHours };
  const horas = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(horas) || horas < minHours || horas > maxHours) {
    return { ok: false, errorCode: 'HOURS_OUT_OF_RANGE', minHours, maxHours };
  }
  return { ok: true, hours: horas };
}

/** El cuerpo del 400 cuando las horas no valen. El mismo al cotizar y al reservar. */
export function errorDeHoras(validacion: ValidacionHoras) {
  const v = validacion as Extract<ValidacionHoras, { ok: false }>;
  return v.errorCode === 'HOURLY_DISABLED'
    ? { error: 'Hourly booking is not available for this vehicle.', errorCode: v.errorCode }
    : {
        error: `hours must be a whole number between ${v.minHours} and ${v.maxHours}`,
        errorCode: v.errorCode,
        minHours: v.minHours,
        maxHours: v.maxHours,
      };
}

// ── El reloj ─────────────────────────────────────────────────────────────────

const ms = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Cuándo empieza a correr el tiempo reservado.
 *
 * A la hora reservada, aunque el pasajero tarde en bajar: ese tiempo es suyo y
 * no paga espera aparte. Si el chofer llegó tarde, desde que llegó: su retraso
 * no se le descuenta al pasajero. Y si el pasajero subió antes de la hora, desde
 * que subió. Sin `startedAt` el servicio no empezó y no hay reloj.
 */
export function inicioDelReloj(opts: { scheduledAt?: unknown; arrivedAt?: unknown; startedAt?: unknown }): number | null {
  const subio = ms(opts.startedAt);
  if (subio === null) return null;
  let inicio = ms(opts.scheduledAt) ?? subio;
  const llego = ms(opts.arrivedAt);
  if (llego !== null && llego > inicio) inicio = llego;
  return Math.min(inicio, subio);
}

// ── Lo que se cobra aparte ───────────────────────────────────────────────────

export interface ExtrasPorHora {
  elapsed_minutes:     number;
  overtime_minutes:    number;
  overtime_increments: number;
  overtime_charge:     number;
  /** Lo que midió el GPS, con un decimal. */
  miles_measured:      number;
  /** Las que se cobran: millas completas, redondeando hacia abajo. */
  miles_used:          number;
  included_miles:      number;
  extra_miles:         number;
  extra_miles_charge:  number;
  extras_subtotal:     number;
}

/**
 * El tiempo se cuenta en minutos empezados: 3 h 5 min 1 s son 186 minutos, 6 de
 * exceso, y eso ya pasa la cortesía. Así el número que ve el pasajero y el que
 * se cobra son el mismo.
 *
 * Las millas se cobran completas y hacia abajo: 82.9 son 82. El GPS mete ruido
 * y, cuando hay huecos, mide en línea recta; redondear a favor del pasajero
 * evita cobrarle una milla que quizá no recorrió.
 */
export function calcularExtras(t: TerminosPorHora, uso: { elapsedMs: number; meters: number }): ExtrasPorHora {
  const elapsed = Math.max(0, Math.ceil(Math.max(0, uso.elapsedMs) / 60000));
  const exceso = Math.max(0, elapsed - Math.round(t.booked_hours * 60));
  const bloques = exceso <= t.overtime_grace_minutes ? 0 : Math.ceil(exceso / t.overtime_increment_minutes);
  const overtime_charge = r2(bloques * precioBloqueExtra(t));

  const medidas = Math.max(0, uso.meters) / METROS_POR_MILLA;
  const cobradas = Math.floor(medidas);
  const incluidas = millasIncluidas(t);
  const extra = Math.max(0, Math.floor(cobradas - incluidas));
  const extra_miles_charge = r2(extra * t.extra_mile_fee);

  return {
    elapsed_minutes:     elapsed,
    overtime_minutes:    exceso,
    overtime_increments: bloques,
    overtime_charge,
    miles_measured:      r1(medidas),
    miles_used:          cobradas,
    included_miles:      incluidas,
    extra_miles:         extra,
    extra_miles_charge,
    extras_subtotal:     r2(overtime_charge + extra_miles_charge),
  };
}

// ── GPS ──────────────────────────────────────────────────────────────────────

/** Un punto con peor precisión que esto no se usa. */
export const PRECISION_MAXIMA_M = 50;
/** Moverse menos que esto es ruido: no se suma y el último punto no cambia. */
export const PASO_MINIMO_M = 15;
/** ~215 km/h. Más rápido que esto entre dos puntos es un salto del GPS. */
export const VELOCIDAD_MAXIMA_MPS = 60;
/** Un hueco así sin puntos marca la medición como degradada. */
export const HUECO_DEGRADADO_MS = 10 * 60 * 1000;

export interface PuntoGps { lat: number; lng: number; at: number; accuracy?: number | null }
export interface UltimoPunto { lat: number; lng: number; at: number }

export type DecisionPunto =
  | { accion: 'primero' }
  | { accion: 'descartar'; motivo: 'precision' | 'viejo' | 'salto' }
  | { accion: 'esperar' }
  | { accion: 'sumar'; metros: number; huecoMs: number; degradado: boolean };

export function haversineMetros(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Qué hacer con un punto nuevo.
 *
 * Entre dos puntos se suma la línea recta. Con el socket cada 3 s eso es casi
 * el trayecto real; tras un hueco sin red queda por debajo, nunca por encima.
 */
export function evaluarPunto(ultimo: UltimoPunto | null, p: PuntoGps): DecisionPunto {
  if (p.accuracy != null && Number.isFinite(p.accuracy) && p.accuracy > PRECISION_MAXIMA_M) {
    return { accion: 'descartar', motivo: 'precision' };
  }
  if (!ultimo) return { accion: 'primero' };
  // Llega tarde un punto anterior al último (el HTTP de 30 s detrás del socket):
  // contarlo sería ir y volver.
  if (p.at <= ultimo.at) return { accion: 'descartar', motivo: 'viejo' };

  const metros = haversineMetros(ultimo, p);
  const umbral = Math.max(PASO_MINIMO_M, p.accuracy ?? 0);
  if (metros < umbral) return { accion: 'esperar' };

  const huecoMs = p.at - ultimo.at;
  if (metros / (huecoMs / 1000) > VELOCIDAD_MAXIMA_MPS) return { accion: 'descartar', motivo: 'salto' };
  return { accion: 'sumar', metros, huecoMs, degradado: huecoMs > HUECO_DEGRADADO_MS };
}

// ── Lo que ven las apps ──────────────────────────────────────────────────────

export type EstadoExtras = 'none' | 'pending' | 'charged' | 'failed' | 'requires_action';

/** Lo que se guarda en `rides.hourly_extras` al terminar. */
export interface ResumenPorHora extends ExtrasPorHora {
  starts_at:       string | null;
  ended_at:        string;
  extras_tax:      number;
  extras_total:    number;
  gps_quality:     'good' | 'degraded';
  /** Lo que le toca al chofer del extra, sin impuesto y tras la comisión. */
  driver_share:    number;
}

export interface FilaPorHora {
  ride_status:          string;
  scheduled_at:         unknown;
  wait_started_at:      unknown;
  started_at:           unknown;
  completed_at:         unknown;
  meters:               number | null;
  degraded:             boolean | null;
  hourly_extras:        unknown;
  hourly_extras_status: string | null;
}

const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());

function leerResumen(raw: unknown): ResumenPorHora | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  return obj && typeof obj === 'object' ? (obj as ResumenPorHora) : null;
}

/**
 * El objeto `hourly` de un viaje. Terminado, sale de lo que se cobró; en curso,
 * de la medición hasta ahora; antes de empezar, sólo las condiciones.
 */
export function vistaPorHora(t: TerminosPorHora, fila: FilaPorHora, ahora = Date.now()) {
  const condiciones = {
    booked_hours:               t.booked_hours,
    per_hour:                   t.per_hour,
    miles_per_hour:             t.miles_per_hour,
    included_miles:             millasIncluidas(t),
    extra_mile_fee:             t.extra_mile_fee,
    surge_multiplier:           t.surge_multiplier,
    overtime_increment_minutes: t.overtime_increment_minutes,
    overtime_grace_minutes:     t.overtime_grace_minutes,
    overtime_increment_price:   precioBloqueExtra(t),
  };

  const resumen = leerResumen(fila.hourly_extras);
  if (resumen) {
    return {
      ...condiciones,
      starts_at:           resumen.starts_at,
      ends_at:             resumen.starts_at ? iso(ms(resumen.starts_at)! + t.booked_hours * 3600_000) : null,
      ended_at:            resumen.ended_at,
      elapsed_minutes:     resumen.elapsed_minutes,
      overtime_minutes:    resumen.overtime_minutes,
      overtime_increments: resumen.overtime_increments,
      overtime_charge:     resumen.overtime_charge,
      miles_measured:      resumen.miles_measured,
      miles_used:          resumen.miles_used,
      extra_miles:         resumen.extra_miles,
      extra_miles_charge:  resumen.extra_miles_charge,
      extras_subtotal:     resumen.extras_subtotal,
      extras_tax:          resumen.extras_tax,
      extras_total:        resumen.extras_total,
      extras_status:       (fila.hourly_extras_status as EstadoExtras | null) ?? 'none',
      gps_quality:         resumen.gps_quality,
    };
  }

  const inicio = inicioDelReloj({ scheduledAt: fila.scheduled_at, arrivedAt: fila.wait_started_at, startedAt: fila.started_at });
  const enCurso = fila.ride_status === 'in_progress' && inicio !== null;
  const uso = enCurso
    ? calcularExtras(t, { elapsedMs: ahora - inicio!, meters: Number(fila.meters ?? 0) })
    : null;

  return {
    ...condiciones,
    starts_at:           iso(inicio),
    ends_at:             inicio === null ? null : iso(inicio + t.booked_hours * 3600_000),
    ended_at:            null,
    elapsed_minutes:     uso?.elapsed_minutes ?? null,
    overtime_minutes:    uso?.overtime_minutes ?? null,
    overtime_increments: uso?.overtime_increments ?? null,
    overtime_charge:     uso?.overtime_charge ?? null,
    miles_measured:      uso?.miles_measured ?? null,
    miles_used:          uso?.miles_used ?? null,
    extra_miles:         uso?.extra_miles ?? null,
    extra_miles_charge:  uso?.extra_miles_charge ?? null,
    extras_subtotal:     uso?.extras_subtotal ?? null,
    extras_tax:          null,
    extras_total:        null,
    // Mientras dura el servicio el extra todavía no se ha calculado.
    extras_status:       (fila.hourly_extras_status as EstadoExtras | null) ?? null,
    gps_quality:         uso ? (fila.degraded ? 'degraded' : 'good') : null,
  };
}

/** El contador en vivo: `GET /api/rides/:id/hourly-usage` y el socket `ride:hourly_usage`. */
export function usoEnVivo(rideId: string, t: TerminosPorHora, fila: FilaPorHora, ahora = Date.now()) {
  const v = vistaPorHora(t, fila, ahora);
  const restantesMin = v.ends_at && fila.ride_status === 'in_progress'
    ? Math.max(0, Math.floor((ms(v.ends_at)! - ahora) / 60000))
    : null;
  return {
    rideId,
    ride_status:          fila.ride_status,
    booked_hours:         v.booked_hours,
    starts_at:            v.starts_at,
    ends_at:              v.ends_at,
    elapsed_minutes:      v.elapsed_minutes,
    remaining_minutes:    restantesMin,
    overtime_minutes:     v.overtime_minutes,
    overtime_increments:  v.overtime_increments,
    overtime_charge:      v.overtime_charge,
    miles_used:           v.miles_measured,
    included_miles:       v.included_miles,
    remaining_miles:      v.miles_measured === null ? null : r1(Math.max(0, v.included_miles - v.miles_measured)),
    extra_miles:          v.extra_miles,
    extra_miles_charge:   v.extra_miles_charge,
    estimated_extras:     v.extras_subtotal,
    extras_status:        v.extras_status,
    gps_quality:          v.gps_quality,
    updated_at:           new Date(ahora).toISOString(),
  };
}
