/**
 * URBONT Pricing Configuration
 * All monetary values in USD. Change these to adjust prices without touching business logic.
 * Authoritative pricing: see VEHICLE_FARE_RULES below.
 */

// ── Platform fees ────────────────────────────────────────────────────────────
export const BOOKING_FEE        = 2.50;    // Platform booking fee (always added) — must match frontend src/screens/booking/utils.ts
export const PLATFORM_COMMISSION = 0.10;   // 10% URBONT app service fee on subtotal

// ── Uber-parity extra fees ───────────────────────────────────────────────────
export const WAIT_TIME_FREE_MINUTES = 5;      // Free waiting period before meter starts
export const WAIT_TIME_FEE_PER_MIN  = 0.50;  // $0.50 per minute after free period
export const LONG_PICKUP_FEE        = 5.00;  // Added when driver is >15 min away from pickup
export const LONG_PICKUP_THRESHOLD_MINS = 15; // Minutes threshold for long pickup fee
export const NO_SHOW_FEE            = 10.00; // Charged to passenger if no-show after arrival
export const CANCELLATION_FEE       = 10.00; // Late cancellation fee (after 2 min grace)
export const CANCELLATION_GRACE_MINS = 2;    // Free cancellation window after driver assigned
export const CONSECUTIVE_TRIP_BONUS: Record<number, number> = {
  5:  3.00,   // $3 bonus after 5 consecutive trips
  10: 7.00,   // $7 bonus after 10 consecutive trips
  20: 15.00,  // $15 bonus after 20 consecutive trips
};

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Surge ────────────────────────────────────────────────────────────────────
/**
 * Zona horaria de operación. El surge por franja horaria debe decidirse con la
 * hora de la ciudad, no con la del servidor ni con la del teléfono del pasajero.
 * Mismo valor que usa el reporte de ingresos por hora (admin.ts:835).
 */
export const OPERATING_TIMEZONE = 'America/New_York';

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Día de la semana y hora en la zona de operación, sin depender del TZ del proceso. */
function localParts(now: Date): { dow: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: OPERATING_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const hourRaw = parts.find((p) => p.type === 'hour')?.value ?? '0';
  // Algunas implementaciones devuelven "24" para medianoche.
  return { dow: DOW[weekday] ?? 0, hour: parseInt(hourRaw, 10) % 24 };
}

/**
 * Recargo por franja horaria.
 *
 * Portado de la app móvil (`src/screens/booking/utils.ts`, `getDynamicMultiplier`),
 * donde se calculaba con `new Date()` en el teléfono del pasajero: el recargo
 * dependía de la hora que tuviera configurada el dispositivo. Acá se decide con
 * la hora de la ciudad de operación.
 *
 * Las noches de viernes y sábado se extienden hasta las 02:00 del día siguiente,
 * así que la franja alta cubre también sábado y domingo de madrugada.
 */
export function getTimeSurge(now: Date = new Date()): number {
  const { dow, hour } = localParts(now);

  const fridayOrSaturdayNight =
    ((dow === 5 || dow === 6) && hour >= 22) ||  // vie/sáb 22:00–23:59
    ((dow === 6 || dow === 0) && hour < 2);      // la madrugada siguiente
  if (fridayOrSaturdayNight) return 1.35;

  const weekday = dow >= 1 && dow <= 5;
  if (weekday && hour >= 7  && hour < 10) return 1.25;  // pico de la mañana
  if (weekday && hour >= 16 && hour < 20) return 1.22;  // pico de la tarde
  if (hour >= 2 && hour < 4)              return 1.15;  // madrugada, poca oferta

  return 1.0;
}

// ── Clases de tarifa ─────────────────────────────────────────────────────────
/**
 * Una clase de vehículo con todo lo que se le puede cobrar.
 *
 * Antes esto vivía repartido en tres sitios que no se hablaban: `VEHICLE_FARE_RULES`
 * (lo que cobraba), `DEFAULT_FARES` en admin.ts (lo que el panel editaba, con
 * `businessClass` en vez de `sedan`) y `FARE_RULES`/`HOURLY_RATES` dentro del APK.
 * Los valores coincidían porque alguien los copió a mano en los tres lados.
 *
 * Ahora hay un solo tipo, y `fares_config` en la base manda sobre estos valores,
 * que quedan como semilla y como red si la base no responde.
 */
export interface FareClass {
  name:            string;
  /** Tarifa mínima, cubre las millas incluidas. */
  minFare:         number;
  includedMiles:   number;
  /** Precio por milla pasadas las incluidas. */
  perMile:         number;
  /** Precio por minuto de espera o tráfico. Se llamaba `waitPerMin`. */
  perMin:          number;
  /** Cargo fijo de reserva. Era la constante global BOOKING_FEE. */
  serviceFee:      number;
  /** Penalización por cancelar tarde. Era la constante global CANCELLATION_FEE. */
  cancellationFee: number;
  /** Chofer a disposición: precio por hora y bloque mínimo. */
  perHour:         number;
  minHours:        number;
}

/** Valores por defecto. Los pisa `fares_config` cuando existe en la base. */
export const DEFAULT_FARE_CLASSES: Record<string, FareClass> = {
  sedan: { name: 'Standard (Sedan)', minFare: 25.00, includedMiles: 3, perMile: 4.00, perMin: 1.00, serviceFee: 2.50, cancellationFee: 10.00, perHour: 110.00, minHours: 2 },
  suv:   { name: 'Premier (SUV)',    minFare: 38.00, includedMiles: 3, perMile: 5.50, perMin: 1.25, serviceFee: 2.50, cancellationFee: 10.00, perHour: 145.00, minHours: 2 },
  van:   { name: 'Executive Van',    minFare: 65.00, includedMiles: 3, perMile: 8.00, perMin: 1.75, serviceFee: 2.50, cancellationFee: 10.00, perHour: 185.00, minHours: 2 },
};

/**
 * Tarifas vigentes. Arranca con los defaults y `setFareClasses()` la reemplaza
 * cuando se cargan las de la base.
 *
 * Es una variable de módulo a propósito: los ocho archivos que calculan precios
 * importan estas funciones de forma síncrona, y volverlas asíncronas obligaría a
 * refactorizar todo el camino del cobro. La carga desde la base ocurre una vez al
 * arrancar y cada vez que un admin guarda.
 */
let activeFareClasses: Record<string, FareClass> = { ...DEFAULT_FARE_CLASSES };

/** Reemplaza las tarifas vigentes. La llama el cargador, no el código de negocio. */
export function setFareClasses(classes: Record<string, FareClass>): void {
  activeFareClasses = { ...DEFAULT_FARE_CLASSES, ...classes };
}

/** Vuelve a los valores por defecto. Sólo para tests. */
export function resetFareClasses(): void {
  activeFareClasses = { ...DEFAULT_FARE_CLASSES };
}

/** Todas las clases vigentes — para el editor del panel y para la app. */
export function getFareClasses(): Record<string, FareClass> {
  return { ...activeFareClasses };
}

/** La clase que corresponde a un nombre de vehículo, resolviendo alias. */
export function getFareClass(vehicleType: string): FareClass | null {
  const key = VEHICLE_ALIAS[String(vehicleType ?? '').toLowerCase()];
  return key ? (activeFareClasses[key] ?? null) : null;
}

/** Penalización por cancelar tarde, según la clase. Cae al global si no la resuelve. */
export function getCancellationFee(vehicleType?: string): number {
  const cls = vehicleType ? getFareClass(vehicleType) : null;
  return cls?.cancellationFee ?? CANCELLATION_FEE;
}

// Normalized alias map: vehicle names/IDs that the server may receive → canonical FARE_RULES key
export const VEHICLE_ALIAS: Record<string, string> = {
  'sedan':         'sedan',
  'business class':'sedan',
  'executive':     'sedan',
  'standard':      'sedan',
  'suv':           'suv',
  'premium suv':   'suv',
  'premier':       'suv',
  'luxury':        'suv',
  'van':           'van',
  'van & sprinter':'van',
  'sprinter':      'van',
  'max':           'van',
};

export interface FareRulesBreakdown {
  base_fare:        number;
  distance_charge:  number;
  time_charge:      number;
  booking_fee:      number;
  ride_fare:        number;
  platform_fee:     number;
  total:            number;
  /** Recargo aplicado a base, distancia y espera. 1.0 = sin recargo. */
  surge_multiplier: number;
  distance_miles:   number;
  extra_miles:      number;
  included_miles:   number;
  duration_minutes: number;
  currency:         string;
}

/**
 * Calculate fare using the FARE_RULES model — matches frontend calculateFareBreakdown exactly.
 * Use this for all receipt/breakdown storage to ensure consistency with what was shown to the user.
 */
export function calculateFareFromRules(opts: {
  vehicleType:      string;
  distanceMiles:    number;
  durationMinutes:  number;
  bookingType?:     string;
  /** Recargo por demanda. Se ignora si es menor a 1: nunca abarata el viaje. */
  surgeMultiplier?: number;
}): FareRulesBreakdown | null {
  const rule = getFareClass(opts.vehicleType);
  if (!rule) return null;

  // El surge multiplica base, distancia y espera — NUNCA los cargos fijos.
  // Antes esta función no recibía surge y no lo aplicaba en ningún término: la
  // app mostraba un precio con recargo, el servidor recalculaba sin él y pisaba
  // el valor, así que las noches de viernes y sábado se cobraba de menos.
  const surge          = Math.max(1, opts.surgeMultiplier ?? 1);
  const extraMiles     = Math.max(0, opts.distanceMiles - rule.includedMiles);
  const base_fare      = r2(rule.minFare * surge);
  const distance_charge = r2(extraMiles * rule.perMile * surge);
  // Time charge: duration × perMin × 0.25 (matches frontend 25% factor for estimated time)
  const time_charge    = opts.durationMinutes > 0 ? r2(opts.durationMinutes * rule.perMin * 0.25 * surge) : 0;
  const schedulingFee  = opts.bookingType === 'scheduled' ? 5.00 : 0;
  const booking_fee    = r2(rule.serviceFee + schedulingFee);
  const ride_fare      = r2(base_fare + distance_charge + time_charge + booking_fee);
  const platform_fee   = r2(ride_fare * PLATFORM_COMMISSION);
  const total          = r2(ride_fare + platform_fee);

  return {
    base_fare, distance_charge, time_charge, booking_fee,
    ride_fare, platform_fee, total,
    surge_multiplier: surge,
    distance_miles:   r2(opts.distanceMiles),
    extra_miles:      r2(extraMiles),
    included_miles:   rule.includedMiles,
    duration_minutes: r2(opts.durationMinutes),
    currency: 'USD',
  };
}

export interface HourlyFareBreakdown {
  hourly_charge:    number;
  booking_fee:      number;
  ride_fare:        number;
  platform_fee:     number;
  total:            number;
  surge_multiplier: number;
  /** Horas efectivamente cobradas: nunca menos que el mínimo de la clase. */
  billed_hours:     number;
  requested_hours:  number;
  per_hour:         number;
  min_hours:        number;
  currency:         string;
}

/**
 * Tarifa por hora (chofer a disposición). Portado de
 * `calculateHourlyFareBreakdown` de la app móvil — anexo A.3.
 *
 * Misma estructura que la tarifa por distancia: el surge multiplica el cargo
 * variable y nunca el fijo, y la comisión se calcula sobre el subtotal.
 *
 * Se cobra siempre el mínimo de la clase, aunque se pidan menos horas: es un
 * bloque reservado, no un consumo medido.
 */
export function calculateHourlyFare(opts: {
  vehicleType:      string;
  hours:            number;
  surgeMultiplier?: number;
}): HourlyFareBreakdown | null {
  const rule = getFareClass(opts.vehicleType);
  if (!rule) return null;
  if (!Number.isFinite(opts.hours) || opts.hours < 0) return null;

  const surge         = Math.max(1, opts.surgeMultiplier ?? 1);
  const billedHours   = Math.max(rule.minHours, opts.hours);
  const hourly_charge = r2(billedHours * rule.perHour * surge);
  const booking_fee   = r2(rule.serviceFee);   // sin recargo, igual que por distancia
  const ride_fare     = r2(hourly_charge + booking_fee);
  const platform_fee  = r2(ride_fare * PLATFORM_COMMISSION);
  const total         = r2(ride_fare + platform_fee);

  return {
    hourly_charge, booking_fee, ride_fare, platform_fee, total,
    surge_multiplier: surge,
    billed_hours:     billedHours,
    requested_hours:  opts.hours,
    per_hour:         rule.perHour,
    min_hours:        rule.minHours,
    currency: 'USD',
  };
}

export interface ComisionResult {
  /** Porcentaje aplicado: siempre 0.10 (10%) */
  porcentaje: number;
  /** Monto de comisión en USD */
  montoUSD: number;
  /** Monto en centavos — usar directamente en application_fee_amount de Stripe */
  centavos: number;
}

/**
 * Calcula la comisión de URBONT sobre un viaje.
 * Comisión fija: 10% sobre el precio total.
 *
 * @param precioViaje - Precio total del viaje en USD (ej. 45.50)
 * @returns ComisionResult con el monto en centavos listo para Stripe
 *
 * @example
 *   const { centavos } = calcularComisionDinamica(45.50);
 *   // Stripe: application_fee_amount: centavos
 */
export function calcularComisionDinamica(precioViaje: number): ComisionResult {
  if (precioViaje < 0) throw new RangeError('precioViaje no puede ser negativo');

  const porcentaje = PLATFORM_COMMISSION;
  const montoUSD = r2(precioViaje * porcentaje);
  const centavos = Math.round(montoUSD * 100);

  return { porcentaje, montoUSD, centavos };
}

/**
 * Normaliza el método de pago a los dos únicos valores que el sistema distingue.
 *
 * `rides.payment_method` lleva un CHECK que sólo admite 'card' o 'cash', pero el
 * cliente lo manda como string libre: validation.ts lo tipa `z.string()` y
 * create.ts lo pasa tal cual al insert. Sin normalizar, un 'apple_pay' o un
 * 'google_pay' de la app tumbaría la reserva entera con un error de constraint.
 *
 * La regla no es nueva: accept.ts:260 ya asume que todo lo que no es 'cash' se
 * cobra como tarjeta, porque Apple Pay y Google Pay son tarjetas vía Stripe.
 * Aquí sólo se hace explícita esa suposición.
 */
export function normalizePaymentMethod(value: unknown): 'card' | 'cash' {
  return String(value ?? '').trim().toLowerCase() === 'cash' ? 'cash' : 'card';
}
