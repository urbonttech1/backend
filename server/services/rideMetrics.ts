/**
 * URBONT Ride Metrics — Stripe Connect commission engine
 *
 * Platform commission: flat 15% on every ride, contained in the price.
 *
 * All monetary output is in cents (integer) for direct use with Stripe:
 *   - application_fee_amount → platform cut (15%)
 *   - transfer_data.amount   → driver payout (85%)
 */

export interface RideMetricsInput {
  totalFareUSD: number;
}

export interface RideMetricsResult {
  totalCents: number;
  applicationFeeCents: number;
  driverPayoutCents: number;
  commissionRate: number;
}

/**
 * Lo que se queda Urbont de cada viaje, contenido en el precio: el chofer cobra
 * el 85 %. Era el 10 % —y además el precio llevaba otro 10 % por encima—, así que
 * el chofer se llevaba prácticamente la tarifa entera. Mismo valor que
 * `PLATFORM_COMMISSION` en config/pricing.ts.
 */
const COMMISSION_RATE = 0.15;

/**
 * calculateRideMetrics
 *
 * Commission: flat 15% to URBONT, 85% to driver.
 *
 * @param input.totalFareUSD - Total trip fare in USD (e.g. 45.50)
 *
 * @example
 *   const m = calculateRideMetrics({ totalFareUSD: 45.50 });
 *   await stripe.paymentIntents.create({
 *     amount: m.totalCents,
 *     application_fee_amount: m.applicationFeeCents,
 *     transfer_data: { destination: driverStripeAccountId },
 *   });
 */
export interface RepartoInput {
  /** Precio del viaje en centavos, SIN impuesto: es lo que se reparte. */
  fareCents: number;
  /** Impuesto en centavos. Lo retiene la plataforma para declararlo. */
  taxCents?: number;
  /**
   * Comisión del valet en centavos, si el viaje lo despachó uno. Va dentro de
   * `fareCents` porque se le cobra al huésped, pero no es parte del servicio del
   * chofer: sin descontarla, el chofer se llevaba el 90 % de una comisión que es
   * de otro.
   */
  valetCents?: number;
}

export interface RepartoResult {
  /** Lo que se le cobra a la tarjeta: precio + impuesto. */
  chargeCents: number;
  /** Lo que retiene la plataforma: su 15 %, el impuesto y la comisión del valet. */
  applicationFeeCents: number;
  /** Lo que le queda al chofer: el 85 % del servicio, sin impuesto ni comisión ajena. */
  driverPayoutCents: number;
  commissionRate: number;
}

/**
 * El reparto de un cobro con Stripe Connect.
 *
 * En un destination charge se manda `application_fee_amount` y el resto va al
 * chofer. Antes se mandaban a la vez `application_fee_amount` y
 * `transfer_data.amount`, que Stripe rechaza, así que el primer chofer con
 * cuenta conectada no habría podido cobrar.
 *
 * El impuesto va DENTRO de la comisión: lo retiene la plataforma porque es
 * quien lo declara, y así al chofer le llega el 90 % del precio limpio.
 */
export function calcularReparto({ fareCents, taxCents = 0, valetCents = 0 }: RepartoInput): RepartoResult {
  if (fareCents < 0 || taxCents < 0 || valetCents < 0) throw new RangeError('los importes no pueden ser negativos');
  if (valetCents > fareCents) throw new RangeError('la comisión del valet no puede superar el precio');

  // El servicio del chofer es el precio sin la comisión del valet.
  const servicio = fareCents - valetCents;
  const comision = Math.round(servicio * COMMISSION_RATE);
  return {
    chargeCents:         fareCents + taxCents,
    applicationFeeCents: comision + taxCents + valetCents,
    driverPayoutCents:   servicio - comision,
    commissionRate:      COMMISSION_RATE,
  };
}

export function calculateRideMetrics(input: RideMetricsInput): RideMetricsResult {
  const { totalFareUSD } = input;

  if (totalFareUSD < 0) throw new RangeError('totalFareUSD cannot be negative');

  const totalCents = Math.round(totalFareUSD * 100);
  const applicationFeeCents = Math.round(totalCents * COMMISSION_RATE);
  const driverPayoutCents = totalCents - applicationFeeCents;

  return {
    totalCents,
    applicationFeeCents,
    driverPayoutCents,
    commissionRate: COMMISSION_RATE,
  };
}
