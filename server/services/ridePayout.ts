/**
 * Pago al chofer de un viaje ya cobrado.
 *
 * Vivía dentro de la ruta que completa el viaje (`rides/status.ts`). Se saca
 * aquí porque ahora hay un segundo caso que tiene que pagar al chofer igual: el
 * no-show de una reserva, en el que se cobra el 100 % del viaje y el chofer
 * recibe lo acordado. Duplicar el bloque habría dejado dos lugares donde se
 * decide cuánto cobra un chofer.
 */

import type Stripe from 'stripe';
import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';
import { calculateRideMetrics } from './rideMetrics';
import { estadoConnectAlDia } from './payoutRecovery';
import { puedeCobrar } from './connectStatus';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export interface PagoChofer {
  fareUSD:          number;
  driverPayoutUSD:  number;
  platformFeeUSD:   number;
  driverTransferId: string | null;
}

/**
 * Transfiere al chofer su parte (90 %) de un PaymentIntent ya capturado y
 * registra el resultado financiero en el viaje.
 *
 * Nunca lanza: un fallo de transferencia se registra y el viaje queda con
 * `driver_earnings` escrito, que es lo que usa el webhook `account.updated`
 * para pagar después a un chofer que active Stripe Connect tarde.
 */
export async function pagarChoferPorViaje(opts: {
  stripe:    Stripe;
  pi:        Stripe.PaymentIntent;
  rideId:    string;
  driverId:  string;
  /** Para la descripción de la transferencia: 'completed ride', 'scheduled no-show'… */
  concepto?: string;
}): Promise<PagoChofer> {
  const { stripe, pi, rideId, driverId } = opts;
  const concepto = opts.concepto ?? 'completed ride';

  const capturedAmountCents = pi.amount_received ?? pi.amount;
  const fareUSD = capturedAmountCents / 100;
  const metrics = calculateRideMetrics({ totalFareUSD: Math.max(1, fareUSD) });
  const driverPayoutUSD = metrics.driverPayoutCents / 100;
  const platformFeeUSD = metrics.applicationFeeCents / 100;

  let driverTransferId: string | null = null;
  if (driverId) {
    const { data: driverProfile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_account_id, stripe_connect_status')
      .eq('id', driverId)
      .maybeSingle();

    const driverAccountId = driverProfile?.stripe_account_id;
    // La columna es una caché del webhook `account.updated`, que puede no haber
    // llegado nunca. Si dice que no, se le pregunta a Stripe antes de dejar al
    // chofer sin cobrar. Ver `connectStatus.ts`.
    const estadoConnect = await estadoConnectAlDia({
      stripe,
      driverId,
      accountId: driverAccountId,
      estadoGuardado: driverProfile?.stripe_connect_status,
    });

    if (driverAccountId && puedeCobrar(estadoConnect)) {
      try {
        const latestCharge = typeof pi.latest_charge === 'string' ? pi.latest_charge : undefined;
        const transfer = await stripe.transfers.create({
          amount: metrics.driverPayoutCents,
          currency: 'usd',
          destination: driverAccountId,
          source_transaction: latestCharge,
          description: `Driver payout (90%) for ${concepto} ${rideId}`,
          metadata: {
            ride_id: rideId,
            driver_id: driverId,
            type: 'driver_ride_payout',
            concept: concepto,
            total_fare_cents: String(metrics.totalCents),
            driver_payout_cents: String(metrics.driverPayoutCents),
            platform_fee_cents: String(metrics.applicationFeeCents),
          },
        }, {
          idempotencyKey: `driver_payout_${rideId}_${pi.id}`,
        });
        driverTransferId = transfer.id;
        logger.info(`[PAYOUT] $${driverPayoutUSD} (90%) a ${driverAccountId} (transfer ${transfer.id}) por ${concepto} ${rideId}`);
      } catch (transferErr: unknown) {
        logger.error(`[PAYOUT] Falló la transferencia al chofer por ${concepto} ${rideId}: ${errMsg(transferErr)}`);
      }
    } else {
      logger.warn(`[PAYOUT] Chofer ${driverId} sin Stripe Connect activo (${estadoConnect}). Pago de $${driverPayoutUSD} queda pendiente.`);
    }
  }

  // Siempre se registra el desglose y la transferencia.
  //
  // `payment_status` sólo lo escribía el webhook de Stripe, así que un webhook
  // que no llegaba dejaba un viaje cobrado en 'pending' para siempre. La captura
  // ya ocurrió, así que se registra aquí; que el webhook escriba 'paid' otra vez
  // después es inocuo.
  //
  // `driver_earnings` es lo que le corresponde al chofer, se haya transferido o
  // no: el webhook `account.updated` busca viajes con `driver_earnings > 0` y
  // `stripe_transfer_id` nulo para pagarlos cuando el chofer activa su cuenta.
  const { error: finErr } = await supabaseAdmin.from('rides').update({
    payment_status: 'paid',
    total_price: Math.round(fareUSD * 100) / 100,
    platform_fee_amount: platformFeeUSD,
    driver_earnings: driverPayoutUSD,
    ...(driverTransferId ? { stripe_transfer_id: driverTransferId } : {}),
    updated_at: new Date().toISOString(),
  }).eq('id', rideId);
  if (finErr) {
    logger.error(`[PAYOUT] No se pudo registrar el resultado del pago de ${rideId}: ${finErr.message}`);
  }

  return { fareUSD, driverPayoutUSD, platformFeeUSD, driverTransferId };
}
