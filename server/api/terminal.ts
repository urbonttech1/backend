/**
 * Tap to Pay on iPhone con Stripe Terminal: el chofer cobra el viaje acercando
 * la tarjeta del pasajero a su iPhone.
 *
 * Mismo modelo que el pago con tarjeta en la app: Urbont cobra el total (con
 * Stripe Tax) y el chofer recibe su parte por transferencia con
 * `pagarChoferPorViaje`, que el webhook o la finalización del viaje disparan.
 * Así un viaje nunca se le paga dos veces al chofer.
 */
import { Router, Request, Response } from 'express';
import type Stripe from 'stripe';
import { requireSupabaseAuth } from '../middleware';
import { supabaseAdmin } from '../db/client';
import { createContextLogger } from '../lib/logger';
import { getStripe } from './rides/helpers';
import { calculateStripeTax } from './integrations';
import { codigoPostalDelViaje } from '../services/taxLocation';
import { decidirCobroPresencial } from '../services/tapToPay';
import { sendEmail, isEmailConfigured } from '../services/mailer';
import { emailShell, section, row, totalRow, badge, brand } from '../services/emailLayout';

const log = createContextLogger('TERMINAL');
export const terminalRouter = Router();

const ROLES_CHOFER = new Set(['driver', 'chauffeur']);

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

function soloChofer(req: Request, res: Response): boolean {
  if (ROLES_CHOFER.has(req.supabaseRole ?? '')) return true;
  res.status(403).json({ error: 'Only drivers can collect in-person payments.', errorCode: 'NOT_A_DRIVER' });
  return false;
}

function stripeOError(res: Response): Stripe | null {
  const stripe = getStripe();
  if (!stripe) res.status(503).json({ error: 'Stripe not configured.', errorCode: 'STRIPE_NOT_CONFIGURED' });
  return stripe;
}

// GET /api/terminal/config — la location a la que se conecta el lector del iPhone.
// Se crea una vez en el panel de Stripe (Terminal → Locations) con la dirección de Urbont.
terminalRouter.get('/config', requireSupabaseAuth, (req: Request, res: Response) => {
  if (!soloChofer(req, res)) return;
  const locationId = process.env.STRIPE_TERMINAL_LOCATION_ID;
  if (!locationId) {
    return res.status(503).json({ error: 'Tap to Pay is not configured yet.', errorCode: 'TERMINAL_NOT_CONFIGURED' });
  }
  res.json({ locationId });
});

// POST /api/terminal/connection-token — el SDK lo pide cada vez que se conecta.
terminalRouter.post('/connection-token', requireSupabaseAuth, async (req: Request, res: Response) => {
  if (!soloChofer(req, res)) return;
  const stripe = stripeOError(res);
  if (!stripe) return;
  try {
    const location = process.env.STRIPE_TERMINAL_LOCATION_ID;
    const token = await stripe.terminal.connectionTokens.create(location ? { location } : {});
    res.json({ secret: token.secret });
  } catch (e) {
    log.error({ err: errMsg(e) }, 'connection token');
    res.status(500).json({ error: 'Could not start Tap to Pay.', errorCode: 'CONNECTION_TOKEN_FAILED' });
  }
});

// POST /api/terminal/rides/:rideId/payment-intent — crea el cobro presencial del viaje.
// Body: { checkoutToken } — uno por intento de cobro; reintentar el mismo intento
// devuelve el mismo PaymentIntent en vez de crear otro.
terminalRouter.post('/rides/:rideId/payment-intent', requireSupabaseAuth, async (req: Request, res: Response) => {
  if (!soloChofer(req, res)) return;
  const stripe = stripeOError(res);
  if (!stripe) return;

  const { rideId } = req.params;
  const checkoutToken = typeof req.body?.checkoutToken === 'string' ? req.body.checkoutToken.slice(0, 100) : '';
  if (!checkoutToken) {
    return res.status(400).json({ error: 'checkoutToken is required.', errorCode: 'MISSING_CHECKOUT_TOKEN', field: 'checkoutToken' });
  }

  try {
    const { data: viaje } = await supabaseAdmin
      .from('rides')
      .select('id, driver_id, ride_status, payment_status, payment_intent_id, locked_fare, fare, wait_fee, pickup, dropoff')
      .eq('id', rideId)
      .maybeSingle();

    const decision = decidirCobroPresencial(viaje, req.supabaseUid!);
    if ('errorCode' in decision) {
      return res.status(decision.status).json({ error: decision.error, errorCode: decision.errorCode });
    }
    const fareCents = decision.fareCents;

    const postal = codigoPostalDelViaje(viaje as { pickup?: { address?: unknown } | null; dropoff?: { address?: unknown } | null });
    const tax = await calculateStripeTax(stripe, fareCents, `tap-${rideId}`, postal);

    const params: Stripe.PaymentIntentCreateParams = {
      amount: tax.taxedAmountCents,
      currency: 'usd',
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      metadata: {
        type: 'tap_to_pay',
        ride_id: rideId,
        driver_id: req.supabaseUid!,
        fare_cents: String(fareCents),
        tax_amount_cents: String(tax.taxAmountCents),
        ...(tax.taxCalculationId ? { tax_calculation_id: tax.taxCalculationId } : {}),
      },
    };
    const pi = await stripe.paymentIntents.create(params, {
      idempotencyKey: `tap_to_pay_${rideId}_${checkoutToken}`,
    });

    res.json({
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      amountCents: tax.taxedAmountCents,
      fareCents,
      taxCents: tax.taxAmountCents,
      currency: 'usd',
    });
  } catch (e) {
    log.error({ err: errMsg(e), rideId }, 'create tap to pay payment intent');
    res.status(500).json({ error: 'Could not prepare the payment.', errorCode: 'PAYMENT_INTENT_FAILED' });
  }
});

// POST /api/terminal/payments/:paymentIntentId/receipt — recibo digital al pasajero.
// Apple exige poder enviarlo tanto si el cobro se aprobó como si se rechazó.
terminalRouter.post('/payments/:paymentIntentId/receipt', requireSupabaseAuth, async (req: Request, res: Response) => {
  if (!soloChofer(req, res)) return;
  const stripe = stripeOError(res);
  if (!stripe) return;

  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email.', errorCode: 'INVALID_EMAIL', field: 'email' });
  }
  if (!isEmailConfigured()) {
    return res.status(503).json({ error: 'Email is not available right now.', errorCode: 'EMAIL_NOT_CONFIGURED' });
  }

  try {
    const pi = await stripe.paymentIntents.retrieve(req.params.paymentIntentId, { expand: ['latest_charge'] });
    if (pi.metadata?.type !== 'tap_to_pay' || pi.metadata?.driver_id !== req.supabaseUid) {
      return res.status(404).json({ error: 'Payment not found.', errorCode: 'PAYMENT_NOT_FOUND' });
    }

    const aprobado = pi.status === 'succeeded';
    const cargo = pi.latest_charge as Stripe.Charge | null;
    const tarjeta = cargo?.payment_method_details?.card_present;
    const dinero = (c: number) => `$${(c / 100).toFixed(2)}`;
    const fareCents = Number(pi.metadata.fare_cents ?? pi.amount);
    const taxCents = Number(pi.metadata.tax_amount_cents ?? 0);
    const fecha = new Date((cargo?.created ?? pi.created) * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' });

    const html = emailShell({
      eyebrow: aprobado ? 'Payment Receipt' : 'Payment Declined',
      subtitle: fecha,
      content: `
        ${section(`<div style="margin-bottom:12px;">${badge(aprobado ? 'Approved' : 'Not approved', aprobado ? brand.green : brand.red)}</div>
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            ${row('Ride fare', dinero(fareCents))}
            ${taxCents > 0 ? row('Tax', dinero(taxCents)) : ''}
            ${tarjeta ? row('Card', `${(tarjeta.brand ?? 'card').toUpperCase()} •••• ${tarjeta.last4 ?? ''}`) : ''}
            ${row('Method', 'Tap to Pay on iPhone')}
            ${totalRow(aprobado ? 'Total charged' : 'Amount', dinero(pi.amount))}
          </table>`)}
        ${aprobado ? '' : section(`<p style="margin:0 0 20px;font-size:13px;color:${brand.slate};">No money was taken from your card.</p>`)}
      `,
      footerNote: `Reference: ${pi.id}`,
    });

    const enviado = await sendEmail({
      to: email,
      subject: aprobado ? `Your URBONT receipt — ${dinero(pi.amount)}` : 'Your URBONT payment was not approved',
      html,
      category: 'ride_receipt',
    });
    if (!enviado) return res.status(502).json({ error: 'Could not send the receipt.', errorCode: 'RECEIPT_NOT_SENT' });
    res.json({ success: true });
  } catch (e) {
    log.error({ err: errMsg(e) }, 'send tap to pay receipt');
    res.status(500).json({ error: 'Could not send the receipt.', errorCode: 'RECEIPT_FAILED' });
  }
});
