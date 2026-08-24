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
