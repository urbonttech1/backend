/**
 * Cobro del cargo de limpieza, una vez que Urbont lo aprueba.
 *
 * Copia el camino de la propina: otro PaymentIntent en USD, fuera de sesión,
 * contra la tarjeta guardada, y la transferencia entera al chofer. No se suma
 * a la tarifa que ya se capturó al terminar el viaje.
 *
 * Si el viaje fue en efectivo o no hay tarjeta, no se finge un cobro.
 */

import type Stripe from 'stripe';
import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';
import { notifyUser } from './fcm';
import { estadoConnectAlDia } from './payoutRecovery';
import { MOTIVOS, type MotivoLimpieza } from './cleaningCharge';

export interface CobroListo {
  status: 'charged';
  paymentIntentId: string;
  transferId?: string;
  /** La tarjeta sí se cobró, pero el dinero no llegó al chofer. */
  chargeError?: 'TRANSFER_FAILED';
}

export interface CobroFallido {
  status: 'charge_failed';
  chargeError: 'CASH' | 'NO_CARD' | 'DRIVER_CANNOT_RECEIVE' | 'CHARGE_FAILED' | 'TRANSFER_FAILED';
  paymentIntentId?: string;
}

export type ResultadoCobro = CobroListo | CobroFallido;

export async function cobrarLimpieza(opts: {
  stripe: Stripe | null;
  chargeId: string;
  rideId: string;
  passengerId: string;
  driverId: string;
  motivo: MotivoLimpieza;
  amountUsd: number;
}): Promise<ResultadoCobro> {
  const { stripe, chargeId, rideId, passengerId, driverId, motivo, amountUsd } = opts;
  const etiqueta = MOTIVOS[motivo].label;
  const cents = Math.round(amountUsd * 100);

  const { data: ride } = await supabaseAdmin
    .from('rides')
    .select('payment_method')
    .eq('id', rideId)
    .maybeSingle();
  const metodo = String((ride as { payment_method?: string } | null)?.payment_method ?? '');
  if (metodo === 'cash') {
    return { status: 'charge_failed', chargeError: 'CASH' };
  }
  if (!stripe) {
    return { status: 'charge_failed', chargeError: 'CHARGE_FAILED' };
  }

  const { data: passenger } = await supabaseAdmin
    .from('profiles').select('stripe_customer_id').eq('id', passengerId).maybeSingle();
  const customerId = (passenger as { stripe_customer_id?: string } | null)?.stripe_customer_id;
  if (!customerId) return { status: 'charge_failed', chargeError: 'NO_CARD' };

  const metodos = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
  if (!metodos.data.length) return { status: 'charge_failed', chargeError: 'NO_CARD' };

  const { data: driverProfile } = await supabaseAdmin
    .from('profiles').select('stripe_account_id, stripe_connect_status').eq('id', driverId).maybeSingle();
  const perfil = driverProfile as { stripe_account_id?: string; stripe_connect_status?: string } | null;
  const estadoChofer = await estadoConnectAlDia({
    stripe,
    driverId,
    accountId: perfil?.stripe_account_id,
    estadoGuardado: perfil?.stripe_connect_status,
  });
  if (estadoChofer !== 'active' || !perfil?.stripe_account_id) {
    logger.warn(`[LIMPIEZA] ${chargeId}: no se cobra, el chofer no puede recibirlo (${estadoChofer}).`);
    return { status: 'charge_failed', chargeError: 'DRIVER_CANNOT_RECEIVE' };
  }

  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create({
      amount: cents,
      currency: 'usd',
      customer: customerId,
      payment_method: metodos.data[0].id,
      payment_method_types: ['card'],
      confirm: true,
      off_session: true,
      description: `URBONT cleaning charge — ${etiqueta}`,
      metadata: { ride_id: rideId, cleaning_charge_id: chargeId, type: 'cleaning', reason: motivo },
    }, { idempotencyKey: `cleaning_${chargeId}` });
  } catch (err: unknown) {
    logger.error(`[LIMPIEZA] ${chargeId}: el cobro falló: ${(err as Error)?.message}`);
    return { status: 'charge_failed', chargeError: 'CHARGE_FAILED' };
  }

  if (pi.status !== 'succeeded') {
    logger.error(`[LIMPIEZA] ${chargeId}: el cobro quedó en '${pi.status}' (${pi.id}).`);
    return { status: 'charge_failed', chargeError: 'CHARGE_FAILED', paymentIntentId: pi.id };
  }

  notifyUser(passengerId, {
    title: 'Cleaning charge',
    body: `A $${amountUsd.toFixed(2)} ${etiqueta.toLowerCase()} charge was applied to your card.`,
    data: { type: 'cleaning_charged', ride_id: rideId, screen: 'ride_history' },
  }).catch(() => {});

  let transferId: string | undefined;
  try {
    const transfer = await stripe.transfers.create({
      amount: cents,
      currency: 'usd',
      destination: perfil.stripe_account_id,
      source_transaction: typeof pi.latest_charge === 'string' ? pi.latest_charge : undefined,
      metadata: { ride_id: rideId, cleaning_charge_id: chargeId, type: 'cleaning' },
    }, { idempotencyKey: `cleaning_transfer_${chargeId}` });
    transferId = transfer.id;
  } catch (err: unknown) {
    logger.error(
      `[LIMPIEZA] ${chargeId}: cobrados ${cents} centavos (${pi.id}) pero la transferencia falló: ${(err as Error)?.message}`,
    );
    return {
      status: 'charged',
      paymentIntentId: pi.id,
      chargeError: 'TRANSFER_FAILED',
    };
  }

  notifyUser(driverId, {
    title: 'Cleaning charge paid',
    body: `$${amountUsd.toFixed(2)} for ${etiqueta.toLowerCase()} was sent to your account.`,
    data: { type: 'cleaning_paid', ride_id: rideId, screen: 'driver_earnings' },
  }).catch(() => {});

  return { status: 'charged', paymentIntentId: pi.id, transferId };
}
