/**
 * El dinero que sale: reembolsos, contracargos y cobros rechazados.
 *
 * Las reglas de aquí son puras —sin base de datos ni Stripe— para poder
 * probarlas. La única función que toca la base es `registrarEvento`, al final,
 * y nunca lanza: un fallo registrando no puede tumbar un cobro ni devolver un
 * 500 a un webhook de Stripe, que reintentaría el evento entero.
 */

import type Stripe from 'stripe';
import { supabaseAdmin } from '../db/client';
import { createContextLogger } from '../lib/logger';

const log = createContextLogger('PAYMENT_EVENTS');

export type TipoEvento = 'refund' | 'chargeback' | 'payment_failed';
export type EstadoEvento = 'pending' | 'succeeded' | 'failed' | 'won' | 'lost' | 'warning_closed';
export type OrigenEvento = 'panel' | 'stripe' | 'auto';

/** Una fila de `payment_events` lista para escribir. */
export interface EventoDePago {
  kind: TipoEvento;
  status: EstadoEvento;
  amount_usd: number;
  currency: string;
  reason: string | null;
  stripe_object_id: string;
  payment_intent_id: string | null;
  charge_id: string | null;
  origin: OrigenEvento;
  created_by: string | null;
  metadata: Record<string, unknown>;
  opened_at: string;
  resolved_at: string | null;
}

/** Centavos de Stripe a dólares, redondeando a dos decimales. */
export function centavosADolares(centavos: number | null | undefined): number {
  if (typeof centavos !== 'number' || !Number.isFinite(centavos)) return 0;
  return Math.round(centavos) / 100;
}

/**
 * Los motivos que manda Stripe, en castellano. Se devuelve el original cuando
 * no está en la tabla: un motivo nuevo de Stripe debe verse crudo en el panel,
 * no desaparecer.
 */
const MOTIVOS: Record<string, string> = {
  // Reembolsos
  duplicate:                      'Cobro duplicado',
  fraudulent:                     'Fraude',
  requested_by_customer:          'Lo pidió el cliente',
  expired_uncaptured_charge:      'Retención vencida',
  // Contracargos
  credit_not_processed:           'No se procesó el reembolso',
  customer_initiated:             'Lo inició el cliente',
  debit_not_authorized:           'Cargo no autorizado',
  general:                        'Sin especificar',
  incorrect_account_details:      'Datos de cuenta incorrectos',
  insufficient_funds:             'Fondos insuficientes',
  product_not_received:           'Servicio no recibido',
  product_unacceptable:           'Servicio no aceptable',
  subscription_canceled:          'Suscripción cancelada',
  unrecognized:                   'No reconoce el cargo',
};

export function motivoLegible(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return MOTIVOS[reason] ?? reason;
}

/** El id del charge o del PaymentIntent, que Stripe manda como string o expandido. */
function idDe(valor: unknown): string | null {
  if (typeof valor === 'string') return valor;
  if (valor && typeof valor === 'object' && 'id' in valor) {
    const id = (valor as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

function aIso(segundos: number | null | undefined): string {
  const ms = typeof segundos === 'number' && Number.isFinite(segundos) ? segundos * 1000 : Date.now();
  return new Date(ms).toISOString();
}

/**
 * Un reembolso de Stripe como fila de la tabla.
 *
 * `status` sigue al de Stripe: un reembolso puede fallar después de creado
 * (`failed`), y entonces el dinero no salió aunque la fila ya exista.
 */
export function eventoDesdeReembolso(
  refund: Stripe.Refund,
  opts: { origin?: OrigenEvento; createdBy?: string | null; reasonOverride?: string | null } = {},
): EventoDePago {
  const fallido = refund.status === 'failed' || refund.status === 'canceled';
  return {
    kind: 'refund',
    status: fallido ? 'failed' : refund.status === 'pending' ? 'pending' : 'succeeded',
    amount_usd: centavosADolares(refund.amount),
    currency: refund.currency ?? 'usd',
    reason: opts.reasonOverride ?? motivoLegible(refund.reason),
    stripe_object_id: refund.id,
    payment_intent_id: idDe(refund.payment_intent),
    charge_id: idDe(refund.charge),
    origin: opts.origin ?? 'stripe',
    created_by: opts.createdBy ?? null,
    metadata: {},
    opened_at: aIso(refund.created),
    // Un reembolso no tiene ciclo de vida: nace resuelto salvo que quede pendiente.
    resolved_at: refund.status === 'pending' ? null : aIso(refund.created),
  };
}

/** Los estados de disputa de Stripe que ya no esperan nada de nosotros. */
const DISPUTA_CERRADA: Record<string, EstadoEvento> = {
  won:            'won',
  lost:           'lost',
  warning_closed: 'warning_closed',
};

/**
 * Una disputa de Stripe como fila de la tabla.
 *
 * Mientras esté abierta queda `pending` y sin `resolved_at`, que es lo que el
 * panel usa para ponerla arriba: una disputa abierta tiene plazo para responder
 * y perderlo cuesta el dinero.
 */
export function eventoDesdeDisputa(
  dispute: Stripe.Dispute,
  opts: { origin?: OrigenEvento } = {},
): EventoDePago {
  const cerrada = DISPUTA_CERRADA[dispute.status];
  return {
    kind: 'chargeback',
    status: cerrada ?? 'pending',
    amount_usd: centavosADolares(dispute.amount),
    currency: dispute.currency ?? 'usd',
    reason: motivoLegible(dispute.reason),
    stripe_object_id: dispute.id,
    payment_intent_id: idDe(dispute.payment_intent),
    charge_id: idDe(dispute.charge),
    origin: opts.origin ?? 'stripe',
    created_by: null,
    metadata: {
      stripe_status: dispute.status,
      ...(dispute.evidence_details?.due_by
        ? { due_by: aIso(dispute.evidence_details.due_by) }
        : {}),
    },
    opened_at: aIso(dispute.created),
    resolved_at: cerrada ? new Date().toISOString() : null,
  };
}

/**
 * Un cobro rechazado como fila de la tabla. Se guarda el PaymentIntent porque
 * un intento fallido no deja ni reembolso ni disputa con los que identificarlo.
 */
export function eventoDesdeCobroFallido(
  pi: Stripe.PaymentIntent,
  opts: { origin?: OrigenEvento; motivo?: string | null } = {},
): EventoDePago {
  return {
    kind: 'payment_failed',
    status: 'failed',
    amount_usd: centavosADolares(pi.amount),
    currency: pi.currency ?? 'usd',
    reason: opts.motivo ?? pi.last_payment_error?.message ?? null,
    stripe_object_id: pi.id,
    payment_intent_id: pi.id,
    charge_id: idDe(pi.latest_charge),
    origin: opts.origin ?? 'stripe',
    created_by: null,
    metadata: {
      ...(pi.last_payment_error?.code ? { error_code: pi.last_payment_error.code } : {}),
      ...(pi.metadata?.type ? { flow: String(pi.metadata.type) } : {}),
    },
    opened_at: new Date().toISOString(),
    resolved_at: new Date().toISOString(),
  };
}

/** Lo que el panel pone abajo, bajo el separador de resueltos. */
export function esResuelto(evento: Pick<EventoDePago, 'resolved_at'>): boolean {
  return evento.resolved_at != null;
}

/**
 * Deja el evento en la base, creándolo o actualizándolo.
 *
 * El upsert va por `(kind, stripe_object_id)`, el índice único de la tabla:
 * cuando el panel crea un reembolso y después llega el webhook del mismo
 * `re_…`, la segunda escritura actualiza la primera en vez de duplicar el
 * dinero en la lista.
 *
 * Nunca lanza.
 */
export async function registrarEvento(
  evento: EventoDePago,
  rideId?: string | null,
): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from('payment_events')
      .upsert(
        { ...evento, ride_id: rideId ?? null, updated_at: new Date().toISOString() },
        { onConflict: 'kind,stripe_object_id' },
      );
    if (error) throw new Error(error.message);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), kind: evento.kind, id: evento.stripe_object_id },
      'no se pudo registrar el movimiento de pago',
    );
  }
}

/**
 * El viaje al que pertenece un cobro, buscando por su PaymentIntent.
 *
 * Devuelve `null` sin ruido si no hay viaje: un contracargo de algo que no es
 * un viaje —una suscripción, un cobro suelto— se registra igual.
 */
export async function viajeDelPago(paymentIntentId: string | null): Promise<string | null> {
  if (!paymentIntentId) return null;
  try {
    const { data } = await supabaseAdmin
      .from('rides')
      .select('id')
      .eq('payment_intent_id', paymentIntentId)
      .maybeSingle();
    return (data as { id?: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}
