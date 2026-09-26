import type Stripe from 'stripe';

import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';
import { notifyUser } from './fcm';
import { estadoConnectAlDia } from './payoutRecovery';

/**
 * La propina de un viaje: cobrarla y hacérsela llegar al chofer.
 *
 * Había tres implementaciones de esto, cada una rota de una forma distinta, y
 * ninguna transfería nada:
 *
 *   - `/api/rides/:id/tip` cobraba y transfería, pero se fiaba de la columna de
 *     estado de Connect, que suele quedarse desactualizada.
 *   - `/api/rides/:id/adjust-tip` -la que llamaba la pantalla de viaje
 *     terminado- creaba el cobro sin `payment_method` ni `off_session`, así que
 *     fallaba antes de crear nada; y aunque hubiera cobrado, no transfería.
 *   - `/api/tips/:rideId` -la del historial- cobraba y tampoco transfería.
 *
 * En Stripe no hay ni un solo cobro de propina en toda la cuenta: la función
 * nunca ha funcionado. Aquí vive ahora la única versión.
 *
 * La propina va entera al chofer; Urbont no cobra comisión sobre ella.
 */

export interface PropinaCobrada {
  paymentIntentId: string;
  transferId?: string;
  monto: number;
}

export interface PropinaRechazada {
  /** Para el pasajero. */
  motivo: string;
  /** Para distinguir el caso desde el cliente. */
  codigo: 'IMPORTE_INVALIDO' | 'VIAJE_NO_VALIDO' | 'NO_ES_TU_VIAJE' | 'YA_TIENE_PROPINA'
        | 'SIN_TARJETA' | 'CHOFER_NO_COBRABLE' | 'COBRO_FALLIDO';
  estado: number;
}

export type ResultadoPropina = PropinaCobrada | PropinaRechazada;

/** El proyecto no usa strict mode: se distingue por campo, no por booleano. */
export const fueRechazada = (r: ResultadoPropina): r is PropinaRechazada => 'motivo' in r;

const MAXIMO_USD = 200;

export async function cobrarPropina(opts: {
  stripe: Stripe;
  rideId: string;
  passengerId: string;
  amount: number;
}): Promise<ResultadoPropina> {
  const { stripe, rideId, passengerId, amount } = opts;

  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > MAXIMO_USD) {
    return { motivo: `Tip amount must be between $0.01 and $${MAXIMO_USD}`, codigo: 'IMPORTE_INVALIDO', estado: 400 };
  }

  const { data: ride } = await supabaseAdmin
    .from('rides')
    .select('id, ride_status, passenger_id, driver_id, tip_amount, payment_method')
    .eq('id', rideId)
    .maybeSingle();

  if (!ride) return { motivo: 'Ride not found', codigo: 'VIAJE_NO_VALIDO', estado: 404 };
  const r = ride as Record<string, unknown>;

  if (String(r.passenger_id) !== passengerId) {
    return { motivo: 'Not your ride', codigo: 'NO_ES_TU_VIAJE', estado: 403 };
  }
  if (r.ride_status !== 'completed') {
    return { motivo: 'Can only tip completed rides', codigo: 'VIAJE_NO_VALIDO', estado: 400 };
  }
  if (r.payment_method === 'cash') {
    return { motivo: 'Cash rides cannot be tipped via card', codigo: 'VIAJE_NO_VALIDO', estado: 400 };
  }
  if (Number(r.tip_amount) > 0) {
    return { motivo: 'Tip already recorded for this ride', codigo: 'YA_TIENE_PROPINA', estado: 409 };
  }

  const { data: passenger } = await supabaseAdmin
    .from('profiles').select('stripe_customer_id').eq('id', passengerId).maybeSingle();
  const customerId = (passenger as { stripe_customer_id?: string } | null)?.stripe_customer_id;
  if (!customerId) {
    return { motivo: 'No saved payment method on file. Please add a card first.', codigo: 'SIN_TARJETA', estado: 400 };
  }

  const { data: driverProfile } = await supabaseAdmin
    .from('profiles').select('stripe_account_id, stripe_connect_status').eq('id', String(r.driver_id)).maybeSingle();
  const perfil = driverProfile as { stripe_account_id?: string; stripe_connect_status?: string } | null;
  const driverAccountId = perfil?.stripe_account_id;

  // Se comprueba ANTES de cobrar que la propina puede llegarle al chofer.
  //
  // Antes se cobraba primero y se miraba después: si no podía transferirse, el
  // dinero se quedaba en Urbont sin quedar registrado como deuda, y al chofer le
  // llegaba igualmente el aviso de que tenía propina. Es el mismo agujero que
  // dejó $169 sin pagar en los viajes.
  //
  // Y no se mira la columna a secas: se le pregunta a Stripe cuando está
  // desactualizada, con la misma regla que el pago de los viajes.
  const estadoChofer = await estadoConnectAlDia({
    stripe,
    driverId: String(r.driver_id),
    accountId: driverAccountId,
    estadoGuardado: perfil?.stripe_connect_status,
  });

  if (estadoChofer !== 'active') {
    logger.warn(`[PROPINA] Viaje ${rideId}: no se cobra, el chofer no puede recibirla (${estadoChofer}).`);
    return {
      motivo: 'Your chauffeur cannot receive tips yet. Please try again later.',
      codigo: 'CHOFER_NO_COBRABLE',
      estado: 409,
    };
  }

  const tipCents = Math.round(amount * 100);

  const metodos = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
  if (!metodos.data.length) {
    return { motivo: 'No saved card found. Please add a card first.', codigo: 'SIN_TARJETA', estado: 400 };
  }

  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create({
      amount:               tipCents,
      currency:             'usd',
      customer:             customerId,
      payment_method:       metodos.data[0].id,
      payment_method_types: ['card'],
      confirm:              true,
      // El pasajero ya cerró la pantalla: el cobro va sin él delante.
      off_session:          true,
      metadata:             { ride_id: rideId, type: 'tip' },
    }, {
      idempotencyKey: `tip_${rideId}_${passengerId}`,
    });
  } catch (err: unknown) {
    logger.error(`[PROPINA] Viaje ${rideId}: el cobro falló: ${(err as Error)?.message}`);
    return { motivo: 'Could not charge the tip. Please try again.', codigo: 'COBRO_FALLIDO', estado: 502 };
  }

  // Crear el PaymentIntent no es cobrarlo. Stripe puede devolverlo en
  // `requires_payment_method` o `requires_action` sin lanzar ningún error, y eso
  // es exactamente lo que pasó el 26/09 a las 18:21: el código viejo dio por
  // buena la propina, escribió `tip_amount` y la app le enseñó al chofer $10 que
  // ningún pasajero había pagado.
  if (pi.status !== 'succeeded') {
    logger.error(`[PROPINA] Viaje ${rideId}: el cobro quedó en '${pi.status}' (${pi.id}); no se registra.`);
    return { motivo: 'Could not charge the tip. Please try again.', codigo: 'COBRO_FALLIDO', estado: 502 };
  }

  // La propina entera al chofer. `source_transaction` la ata a este cobro, así
  // que sale aunque el saldo de la plataforma esté en cero por el barrido.
  let transferId: string | undefined;
  try {
    const transfer = await stripe.transfers.create({
      amount:             tipCents,
      currency:           'usd',
      destination:        driverAccountId!,
      source_transaction: typeof pi.latest_charge === 'string' ? pi.latest_charge : undefined,
      metadata:           { ride_id: rideId, type: 'tip' },
    }, {
      idempotencyKey: `tip_transfer_${rideId}`,
    });
    transferId = transfer.id;
  } catch (err: unknown) {
    // El cobro ya salió. Se registra con detalle para poder repararlo a mano:
    // callarlo dejaría al pasajero cobrado y al chofer sin su propina.
    logger.error(
      `[PROPINA] Viaje ${rideId}: cobrados ${tipCents} centavos (${pi.id}) pero la ` +
      `transferencia a ${driverAccountId} falló: ${(err as Error)?.message}`,
    );
  }

  await supabaseAdmin.from('rides').update({
    tip_amount: amount,
    updated_at: new Date().toISOString(),
  }).eq('id', rideId);

  // El aviso va aquí y no en cada ruta: antes se le decía al chofer que tenía
  // propina aunque el dinero no hubiera salido de Urbont.
  if (transferId) {
    notifyUser(String(r.driver_id), {
      title: '💰 You received a tip!',
      body:  `Your passenger left you a $${amount.toFixed(2)} tip. Great service!`,
      data:  { type: 'tip_received', ride_id: rideId, screen: 'driver_earnings' },
    }).catch(() => {});
  }

  return { paymentIntentId: pi.id, transferId, monto: amount };
}
