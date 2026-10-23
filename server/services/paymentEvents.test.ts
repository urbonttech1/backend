import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/client', () => ({ supabaseAdmin: {} }));

import type Stripe from 'stripe';
import {
  centavosADolares,
  motivoLegible,
  eventoDesdeReembolso,
  eventoDesdeDisputa,
  eventoDesdeCobroFallido,
  esResuelto,
} from './paymentEvents';

const reembolso = (extra: Partial<Stripe.Refund> = {}) => ({
  id: 're_1',
  amount: 3850,
  currency: 'usd',
  created: 1_700_000_000,
  status: 'succeeded',
  reason: 'requested_by_customer',
  payment_intent: 'pi_1',
  charge: 'ch_1',
  ...extra,
}) as Stripe.Refund;

const disputa = (extra: Partial<Stripe.Dispute> = {}) => ({
  id: 'dp_1',
  amount: 4047,
  currency: 'usd',
  created: 1_700_000_000,
  status: 'needs_response',
  reason: 'fraudulent',
  payment_intent: 'pi_1',
  charge: 'ch_1',
  ...extra,
}) as Stripe.Dispute;

describe('centavosADolares', () => {
  it('convierte a dos decimales', () => {
    expect(centavosADolares(3850)).toBe(38.5);
    expect(centavosADolares(4047)).toBe(40.47);
    expect(centavosADolares(0)).toBe(0);
  });

  it('no revienta con lo que no es un número', () => {
    for (const v of [null, undefined, NaN, Infinity]) expect(centavosADolares(v as number)).toBe(0);
  });
});

describe('motivoLegible', () => {
  it('traduce los motivos conocidos', () => {
    expect(motivoLegible('fraudulent')).toBe('Fraude');
    expect(motivoLegible('product_not_received')).toBe('Servicio no recibido');
  });

  it('devuelve crudo lo que Stripe invente después', () => {
    expect(motivoLegible('motivo_nuevo_de_stripe')).toBe('motivo_nuevo_de_stripe');
  });

  it('sin motivo, nulo', () => {
    expect(motivoLegible(null)).toBeNull();
    expect(motivoLegible(undefined)).toBeNull();
  });
});

describe('eventoDesdeReembolso', () => {
  it('un reembolso normal nace resuelto', () => {
    const e = eventoDesdeReembolso(reembolso());
    expect(e.kind).toBe('refund');
    expect(e.status).toBe('succeeded');
    expect(e.amount_usd).toBe(38.5);
    expect(e.stripe_object_id).toBe('re_1');
    expect(e.payment_intent_id).toBe('pi_1');
    expect(e.charge_id).toBe('ch_1');
    expect(e.reason).toBe('Lo pidió el cliente');
    expect(esResuelto(e)).toBe(true);
  });

  it('pendiente sigue abierto', () => {
    const e = eventoDesdeReembolso(reembolso({ status: 'pending' }));
    expect(e.status).toBe('pending');
    expect(esResuelto(e)).toBe(false);
  });

  it('un reembolso fallido no es dinero que salió', () => {
    expect(eventoDesdeReembolso(reembolso({ status: 'failed' })).status).toBe('failed');
    expect(eventoDesdeReembolso(reembolso({ status: 'canceled' })).status).toBe('failed');
  });

  it('el panel manda su origen, su autor y su motivo', () => {
    const e = eventoDesdeReembolso(reembolso(), {
      origin: 'panel',
      createdBy: 'Felipe',
      reasonOverride: 'El pasajero se quejó del aire',
    });
    expect(e.origin).toBe('panel');
    expect(e.created_by).toBe('Felipe');
    expect(e.reason).toBe('El pasajero se quejó del aire');
  });

  it('acepta el objeto expandido, no sólo el id', () => {
    const e = eventoDesdeReembolso(reembolso({
      payment_intent: { id: 'pi_exp' } as Stripe.PaymentIntent,
      charge: { id: 'ch_exp' } as Stripe.Charge,
    }));
    expect(e.payment_intent_id).toBe('pi_exp');
    expect(e.charge_id).toBe('ch_exp');
  });
});

describe('eventoDesdeDisputa', () => {
  it('una disputa abierta queda pendiente y sin resolver', () => {
    const e = eventoDesdeDisputa(disputa());
    expect(e.kind).toBe('chargeback');
    expect(e.status).toBe('pending');
    expect(e.resolved_at).toBeNull();
    expect(esResuelto(e)).toBe(false);
    expect(e.amount_usd).toBe(40.47);
    expect(e.reason).toBe('Fraude');
    expect(e.metadata.stripe_status).toBe('needs_response');
  });

  it('under_review sigue abierta', () => {
    expect(eventoDesdeDisputa(disputa({ status: 'under_review' })).status).toBe('pending');
  });

  it('cerrada toma su resultado y se marca resuelta', () => {
    for (const [stripe, nuestro] of [['won', 'won'], ['lost', 'lost'], ['warning_closed', 'warning_closed']] as const) {
      const e = eventoDesdeDisputa(disputa({ status: stripe }));
      expect(e.status).toBe(nuestro);
      expect(esResuelto(e)).toBe(true);
    }
  });

  it('guarda el plazo para responder cuando Stripe lo manda', () => {
    const e = eventoDesdeDisputa(disputa({
      evidence_details: { due_by: 1_700_600_000, has_evidence: false, past_due: false, submission_count: 0 } as Stripe.Dispute.EvidenceDetails,
    }));
    expect(e.metadata.due_by).toBe(new Date(1_700_600_000 * 1000).toISOString());
  });
});

describe('eventoDesdeCobroFallido', () => {
  const pi = {
    id: 'pi_2',
    amount: 4047,
    currency: 'usd',
    latest_charge: 'ch_2',
    last_payment_error: { message: 'Your card was declined.', code: 'card_declined' },
    metadata: { type: 'tap_to_pay' },
  } as unknown as Stripe.PaymentIntent;

  it('se identifica por el PaymentIntent, que es lo único que hay', () => {
    const e = eventoDesdeCobroFallido(pi);
    expect(e.kind).toBe('payment_failed');
    expect(e.status).toBe('failed');
    expect(e.stripe_object_id).toBe('pi_2');
    expect(e.payment_intent_id).toBe('pi_2');
    expect(e.amount_usd).toBe(40.47);
    expect(e.reason).toBe('Your card was declined.');
    expect(e.metadata.error_code).toBe('card_declined');
    expect(e.metadata.flow).toBe('tap_to_pay');
    expect(esResuelto(e)).toBe(true);
  });

  it('sin motivo de Stripe acepta el que le pasen', () => {
    const sinError = { id: 'pi_3', amount: 100, currency: 'usd' } as Stripe.PaymentIntent;
    expect(eventoDesdeCobroFallido(sinError, { motivo: 'Sin método de pago' }).reason).toBe('Sin método de pago');
    expect(eventoDesdeCobroFallido(sinError).reason).toBeNull();
  });
});
