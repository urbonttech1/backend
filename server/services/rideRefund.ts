import type Stripe from 'stripe';
import { getStripe } from '../api/rides/helpers';
import { createContextLogger } from '../lib/logger';
import { eventoDesdeReembolso, registrarEvento } from './paymentEvents';

const log = createContextLogger('REFUND');

/**
 * Libera el cobro retenido, o lo reembolsa entero si ya se había capturado.
 *
 * El reembolso queda registrado aquí porque este es el camino común de las
 * devoluciones automáticas —cancelaciones, viajes que nadie tomó, reasignación
 * vencida—. El webhook `charge.refunded` escribe la misma fila por el mismo
 * `re_…`, así que si uno de los dos falla el movimiento no se pierde.
 */
export async function liberarCobro(stripe: Stripe, pi: Stripe.PaymentIntent, rideId?: string): Promise<void> {
  if (pi.status === 'requires_capture') {
    await stripe.paymentIntents.cancel(pi.id);
  } else if (pi.status === 'succeeded') {
    const refund = await stripe.refunds.create({ payment_intent: pi.id });
    await registrarEvento(
      eventoDesdeReembolso(refund, { origin: 'auto', createdBy: 'sistema' }),
      rideId ?? null,
    );
  }
}

/**
 * Devuelve lo pagado por un viaje que el sistema canceló sin prestarse (no
 * apareció chofer, venció la reasignación…). El pago se captura al reservar,
 * así que liberar sólo las retenciones —lo que se hacía— dejaba cobrado al
 * pasajero mientras el push le decía "You haven't been charged".
 * Nunca lanza: un fallo aquí no debe frenar el resto de cancelaciones del cron.
 */
export async function devolverCobroDelViaje(paymentIntentId: string | null | undefined, rideId: string): Promise<void> {
  if (!paymentIntentId) return;
  const stripe = getStripe();
  if (!stripe) return;
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    await liberarCobro(stripe, pi, rideId);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), rideId, paymentIntentId }, 'no se pudo devolver el cobro del viaje cancelado');
  }
}
