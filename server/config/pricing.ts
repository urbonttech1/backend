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

// ── FARE_RULES — matches frontend src/screens/booking/utils.ts exactly ──────
// These are the authoritative fares shown to passengers and valets.
export interface FareRule {
  minFare:       number;   // Base fare covering includedMiles
  includedMiles: number;   // Miles covered by minFare
  perMile:       number;   // Rate per mile after includedMiles
  waitPerMin:    number;   // Wait/traffic rate per minute
}

export const VEHICLE_FARE_RULES: Record<string, FareRule> = {
  sedan:    { minFare: 25.00, includedMiles: 3, perMile: 4.00, waitPerMin: 1.00 },
  suv:      { minFare: 38.00, includedMiles: 3, perMile: 5.50, waitPerMin: 1.25 },
  van:      { minFare: 65.00, includedMiles: 3, perMile: 8.00, waitPerMin: 1.75 },
};

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
  vehicleType:     string;
  distanceMiles:   number;
  durationMinutes: number;
  bookingType?:    string;
}): FareRulesBreakdown | null {
  const key = VEHICLE_ALIAS[opts.vehicleType.toLowerCase()];
  const rule = key ? VEHICLE_FARE_RULES[key] : null;
  if (!rule) return null;

  const extraMiles     = Math.max(0, opts.distanceMiles - rule.includedMiles);
  const base_fare      = r2(rule.minFare);
  const distance_charge = r2(extraMiles * rule.perMile);
  // Time charge: duration × waitPerMin × 0.25 (matches frontend 25% factor for estimated time)
  const time_charge    = opts.durationMinutes > 0 ? r2(opts.durationMinutes * rule.waitPerMin * 0.25) : 0;
  const schedulingFee  = opts.bookingType === 'scheduled' ? 5.00 : 0;
  const booking_fee    = r2(BOOKING_FEE + schedulingFee);
  const ride_fare      = r2(base_fare + distance_charge + time_charge + booking_fee);
  const platform_fee   = r2(ride_fare * PLATFORM_COMMISSION);
  const total          = r2(ride_fare + platform_fee);

  return {
    base_fare, distance_charge, time_charge, booking_fee,
    ride_fare, platform_fee, total,
    distance_miles:   r2(opts.distanceMiles),
    extra_miles:      r2(extraMiles),
    included_miles:   rule.includedMiles,
    duration_minutes: r2(opts.durationMinutes),
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
