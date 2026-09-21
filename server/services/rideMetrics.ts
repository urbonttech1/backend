/**
 * URBONT Ride Metrics — Stripe Connect commission engine
 *
 * Platform commission: flat 10% on every ride.
 *
 * All monetary output is in cents (integer) for direct use with Stripe:
 *   - application_fee_amount → platform cut (10%)
 *   - transfer_data.amount   → driver payout (90%)
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

const COMMISSION_RATE = 0.10;

/**
 * calculateRideMetrics
 *
 * Commission: flat 10% to URBONT, 90% to driver.
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
}

export interface RepartoResult {
  /** Lo que se le cobra a la tarjeta: precio + impuesto. */
  chargeCents: number;
  /** Lo que retiene la plataforma: su 10 % MÁS el impuesto. */
  applicationFeeCents: number;
  /** Lo que le queda al chofer: el 90 % del precio, sin tocar el impuesto. */
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
export function calcularReparto({ fareCents, taxCents = 0 }: RepartoInput): RepartoResult {
  if (fareCents < 0 || taxCents < 0) throw new RangeError('los importes no pueden ser negativos');

  const comision = Math.round(fareCents * COMMISSION_RATE);
  return {
    chargeCents:         fareCents + taxCents,
    applicationFeeCents: comision + taxCents,
    driverPayoutCents:   fareCents - comision,
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
