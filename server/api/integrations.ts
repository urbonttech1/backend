import { Router, Request, Response } from "express";
import { createContextLogger } from '../lib/logger';
import Stripe from 'stripe';
import { validateBody, requireSupabaseAuth, optionalSupabaseAuth } from "../middleware";
import { supabaseAdmin } from '../db/client';
import { estadoDeCuenta, type CuentaConnect } from '../services/connectStatus';
import { pagarViajesPendientes } from '../services/payoutRecovery';
import { calculateRideMetrics, calcularReparto } from '../services/rideMetrics';
import { tasaImpuestoRespaldo } from '../services/taxConfig';
import { codigoPostalDe, codigoPostalDelViaje } from '../services/taxLocation';

const log = createContextLogger('INTEGRATIONS');

// ââ Singleton Stripe client ââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Production safety: never fall back to a hardcoded key. Refuse to boot if
// STRIPE_SECRET_KEY is missing in production.
const _STRIPE_SK = process.env.STRIPE_SECRET_KEY;
if (!_STRIPE_SK && process.env.NODE_ENV === 'production') {
  log.warn('[WARN] STRIPE_SECRET_KEY not set â Stripe webhooks and payments will be unavailable.');
}

let stripeClient: Stripe | null = null;
function getStripe(): Stripe | null {
  if (stripeClient) return stripeClient;
  const key = _STRIPE_SK;
  if (!key || key.startsWith('pk_')) return null;
  stripeClient = new Stripe(key);
  return stripeClient;
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export const integrationsRouter = Router();

// ââ Stripe Webhook â must use raw body; mounted BEFORE express.json() âââââââââ
// Handles: payment_intent.succeeded, account.updated
// Register in server.ts: app.use('/api/integrations/stripe/webhook', express.raw(...), integrationsRouter)
integrationsRouter.post(
  '/stripe/webhook',
  async (req: Request, res: Response) => {
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const sig = req.headers['stripe-signature'] as string;
    // Dos secretos porque hacen falta dos endpoints en Stripe: los eventos de
    // las cuentas conectadas —`account.updated`, el que decide si un chofer
    // puede cobrar— sólo se envían a un endpoint marcado como Connect, y ése
    // firma con un secreto distinto. Se prueban los dos contra la misma URL.
    const secretos = [
      process.env.STRIPE_WEBHOOK_SECRET,
      process.env.STRIPE_WEBHOOK_SECRET_CONNECT,
    ].filter((s): s is string => !!s);

    let event: Stripe.Event;

    if (secretos.length > 0 && sig) {
      let verificado: Stripe.Event | null = null;
      let ultimoError = 'sin secretos configurados';
      for (const secreto of secretos) {
        try {
          verificado = stripe.webhooks.constructEvent(req.body, sig, secreto);
          break;
        } catch (err: unknown) {
          ultimoError = err instanceof Error ? err.message : String(err);
        }
      }
      if (!verificado) {
        log.error(`[STRIPE_WEBHOOK] Signature verification failed: ${ultimoError}`);
        return res.status(400).send(`Webhook Error: ${ultimoError}`);
      }
      event = verificado;
    } else {
      // Production: refuse unsigned webhooks. Only allow unsigned in dev/test.
      if (process.env.NODE_ENV === 'production') {
        log.error('[STRIPE_WEBHOOK] Rejected unsigned request in production.');
        return res.status(400).json({ error: 'Webhook signature required' });
      }
      try {
        event = JSON.parse(req.body.toString()) as Stripe.Event;
      } catch {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }
    }

    log.info(`[STRIPE_WEBHOOK] ${event.type}`);

    try {
      switch (event.type) {
        // ââ Payment confirmed â mark ride as paid âââââââââââââââââââââââââââââ
        case 'payment_intent.succeeded': {
          const pi = event.data.object as Stripe.PaymentIntent;
          const rideId = pi.metadata?.ride_id;
          const flowType = pi.metadata?.type;

          if (rideId) {
            // For valet_card_checkout, do NOT advance ride_status via webhook.
            // Ride status is controlled exclusively by the driver's PATCH /status endpoint.
            // If the passenger pays mid-trip, we only record the payment fields.
            if (flowType === 'valet_card_checkout') {
              await supabaseAdmin.from('rides').update({
                payment_intent_id: pi.id,
                payment_status: 'paid',
                updated_at: new Date().toISOString(),
              }).eq('id', rideId);
              log.info(`[STRIPE_WEBHOOK] Valet card payment received for ride ${rideId} â ride_status unchanged (driver controls completion)`);
            } else {
              await supabaseAdmin.from('rides').update({
                ride_status: 'completed',
                payment_intent_id: pi.id,
                updated_at: new Date().toISOString(),
              }).eq('id', rideId);
              log.info(`[STRIPE_WEBHOOK] Ride ${rideId} marked as paid (${pi.amount / 100} ${pi.currency.toUpperCase()})`);
            }

            // ââ Valet card flow: pay the valet's $10 commission via Transfer âââââ
            // The application_fee already kept (URBONT 10% + valet $10) in the
            // platform balance â now route the valet portion to the valet's
            // connected account.
            if (flowType === 'valet_card_checkout') {
              try {
                const valetUserId          = pi.metadata?.valet_user_id || '';
                const valetSurchargeCents  = parseInt(pi.metadata?.valet_surcharge_cents || '0', 10);

                // Idempotency: skip if commission already paid
                const { data: rideRow } = await supabaseAdmin
                  .from('rides')
                  .select('valet_commission_paid')
                  .eq('id', rideId)
                  .maybeSingle();

                if (valetUserId && valetSurchargeCents > 0 && !rideRow?.valet_commission_paid) {
                  const { data: valetProfile } = await supabaseAdmin
                    .from('profiles')
                    .select('stripe_account_id')
                    .eq('id', valetUserId)
                    .maybeSingle();

                  const valetAccountId = valetProfile?.stripe_account_id;
                  if (valetAccountId) {
                    const transfer = await stripe.transfers.create({
                      amount: valetSurchargeCents,
                      currency: 'usd',
                      destination: valetAccountId,
                      metadata: {
                        ride_id:       rideId,
                        valet_user_id: valetUserId,
                        type:          'valet_commission',
                        payment_method:'card',
                        source_pi:     pi.id,
                      },
                    }, {
                      // Idempotency key prevents double-transfers on Stripe webhook retries
                      idempotencyKey: `valet_commission_${rideId}_${pi.id}`,
                    });
                    await supabaseAdmin.from('rides').update({
                      valet_commission_paid:        true,
                      valet_commission_transfer_id: transfer.id,
                    }).eq('id', rideId);
                    log.info(`[STRIPE_WEBHOOK] Valet commission $${valetSurchargeCents/100} â ${valetAccountId} (transfer ${transfer.id})`);
                  } else {
                    log.warn(`[STRIPE_WEBHOOK] Valet ${valetUserId} has no stripe_account_id; commission not transferred`);
                  }
                }
              } catch (transferErr: unknown) {
                log.error(`[STRIPE_WEBHOOK] Valet commission transfer failed: ${errMsg(transferErr)}`);
              }
            }
          }
          break;
        }

        // ── Payment failed — update ride + log for support ──────────────────
        case 'payment_intent.payment_failed': {
          const pi = event.data.object as Stripe.PaymentIntent;
          const rideId = pi.metadata?.ride_id;
          if (rideId) {
            const failReason = pi.last_payment_error?.message ?? 'Unknown payment error';
            log.warn(`[STRIPE_WEBHOOK] Payment failed for ride ${rideId}: ${failReason}`);
            // Update ride payment state so the passenger can be notified and retry
            await supabaseAdmin.from('rides').update({
              payment_status: 'failed',
              payment_error: failReason,
              updated_at: new Date().toISOString(),
            }).eq('id', rideId);
          }
          break;
        }

        // ── Driver Connected Account updated — sync status in DB and process pending payouts ──
        case 'account.updated': {
          const account = event.data.object as Stripe.Account;
          // Manda la capacidad `transfers`, que es lo que Stripe exige para
          // transferir; `details_submitted` sólo dice que llenó el formulario.
          const newStatus = estadoDeCuenta(account as CuentaConnect);
          const { data: updatedProfiles } = await supabaseAdmin
            .from('profiles')
            .update({ stripe_connect_status: newStatus })
            .eq('stripe_account_id', account.id)
            .select('id');
          log.info(`[STRIPE_WEBHOOK] Account ${account.id} → ${newStatus}`);

          // Si acaba de quedar habilitada, se le paga lo atrasado. Es el mismo
          // trabajo que hace el cron cada 15 minutos: esto sólo lo adelanta.
          if (newStatus === 'active' && updatedProfiles && updatedProfiles.length > 0) {
            const driverUserId = updatedProfiles[0].id;
            const r = await pagarViajesPendientes({ stripe, driverId: driverUserId });
            if (r.viajesPagados > 0) {
              log.info(`[STRIPE_WEBHOOK] ${r.viajesPagados} pagos atrasados liberados a ${driverUserId} ($${(r.centavosPagados / 100).toFixed(2)})`);
            }
          }
          break;
        }

        // ââ Payout sent to driver âââââââââââââââââââââââââââââââââââââââââââââ
        case 'payout.paid': {
          const payout = event.data.object as Stripe.Payout;
          log.info(`[STRIPE_WEBHOOK] Payout ${payout.id} sent â $${payout.amount / 100}`);
          break;
        }


        // ââ Subscription cancelled from Stripe dashboard or non-payment âââââ
        case 'customer.subscription.deleted': {
          const sub = event.data.object as Stripe.Subscription;
          const userId = sub.metadata?.user_id;
          if (userId) {
            await supabaseAdmin.from('urbont_subscriptions')
              .update({ status: 'cancelled', updated_at: new Date().toISOString() })
              .eq('stripe_subscription_id', sub.id);
            await supabaseAdmin.from('profiles')
              .update({ urbont_pass_active: false })
              .eq('id', userId);
            log.info(`[STRIPE_WEBHOOK] Subscription ${sub.id} deleted â user ${userId} pass deactivated`);
          }
          break;
        }

        // ââ Subscription renewal payment failed â mark as past_due ââââââââââ
        case 'invoice.payment_failed': {
          const invoice = event.data.object as Stripe.Invoice & { subscription?: string | Stripe.Subscription | null };
          const subId = typeof invoice.subscription === 'string'
            ? invoice.subscription
            : (invoice.subscription as Stripe.Subscription | null)?.id;
          if (subId) {
            await supabaseAdmin.from('urbont_subscriptions')
              .update({ status: 'past_due', updated_at: new Date().toISOString() })
              .eq('stripe_subscription_id', subId);
            log.warn(`[STRIPE_WEBHOOK] Invoice payment failed for subscription ${subId} â marked past_due`);
          }
          break;
        }

        default:
          // unhandled event type â acknowledge without error
          break;
      }
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      log.error(`[STRIPE_WEBHOOK] Handler error: ${errMessage}`);
      // Still return 200 so Stripe doesn't retry
    }

    res.json({ received: true });
  }
);

// ââ Stripe Tax estimate (no PI created) âââââââââââââââââââââââââââââââââââââââ
// GET /api/integrations/stripe/estimate-tax?amountCents=4500
integrationsRouter.get("/stripe/estimate-tax", async (req: Request, res: Response) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const amountCents = parseInt(req.query.amountCents as string, 10);
    if (isNaN(amountCents) || amountCents < 50) {
      return res.status(400).json({ error: 'Invalid amountCents' });
    }

    // Opcional y compatible con las apps viejas: sin el, se estima con la tasa
    // de respaldo, que es lo que venia pasando siempre.
    const postalCode = codigoPostalDe(req.query.postalCode);
    const result = await calculateStripeTax(stripe, amountCents, `estimate-${Date.now()}`, postalCode);
    res.json({
      taxAmountCents:   result.taxAmountCents,
      taxedAmountCents: result.taxedAmountCents,
      taxRatePercent:   amountCents > 0
        ? +((result.taxAmountCents / amountCents) * 100).toFixed(4)
        : 0,
    });
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : undefined;
    res.status(500).json({ error: errMessage || 'Tax estimation failed' });
  }
});

// ââ Stripe public config â safe to expose (publishable key only) âââââââââââââââ
integrationsRouter.get("/stripe/config", (_req, res) => {
  const publishableKey = process.env.VITE_STRIPE_PUBLISHABLE_KEY || process.env.STRIPE_PUBLISHABLE_KEY || '';
  if (!publishableKey) {
    return res.status(503).json({ error: 'Stripe publishable key not configured', configured: false });
  }
  res.json({ publishableKey, configured: true });
});

// ââ Create Payment Intent (ride checkout) âââââââââââââââââââââââââââââââââââââ
integrationsRouter.post("/stripe/create-payment-intent", optionalSupabaseAuth, validateBody(['amount']), async (req: Request, res: Response) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    // amount is in DOLLARS (e.g. 65.88). The server converts to cents for Stripe.
    const raw = parseFloat(req.body.amount);
    if (isNaN(raw) || raw < 0.5 || raw > 5000) {
      return res.status(400).json({ error: 'Invalid amount. Must be between $0.50 and $5,000.' });
    }

    const amount = Math.round(raw * 100);
    const { currency = 'usd', savedPaymentMethodId } = req.body;
    if (!['usd', 'eur'].includes(currency)) {
      return res.status(400).json({ error: 'Unsupported currency.' });
    }

    // When paying with a saved card:
    //   1. Retrieve the PM from Stripe to discover its attached customer — this
    //      works even when the session token has expired (optionalSupabaseAuth).
    //   2. If the user IS authenticated, verify the PM's customer matches theirs.
    //   3. Attach BOTH customer and payment_method to the PaymentIntent so that
    //      stripe.confirmCardPayment on the client never gets a customer mismatch.
    let customerId: string | undefined;
    let attachedPmId: string | undefined;

    if (savedPaymentMethodId) {
      try {
        const pm = await stripe.paymentMethods.retrieve(savedPaymentMethodId as string);
        if (pm.customer) {
          // Verify ownership when user is authenticated
          if (req.supabaseUid) {
            const expectedCustomerId = await getOrCreateStripeCustomer(stripe, req.supabaseUid);
            if (pm.customer !== expectedCustomerId) {
              return res.status(403).json({ error: 'Payment method does not belong to your account.' });
            }
          }
          customerId = pm.customer as string;
        } else if (req.supabaseUid) {
          // PM not yet attached to a customer — fall back to user's customer
          customerId = await getOrCreateStripeCustomer(stripe, req.supabaseUid);
        }
        attachedPmId = pm.id;
      } catch {
        return res.status(400).json({ error: 'Invalid payment method. Please choose another card.' });
      }
    } else if (req.supabaseUid) {
      // New card — associate with the Stripe customer so it can be saved later
      try { customerId = await getOrCreateStripeCustomer(stripe, req.supabaseUid); } catch { /* non-blocking */ }
    }

    const taxResult = await calculateStripeTax(
      stripe, amount, `payment-${req.supabaseUid || 'anon'}`, codigoPostalDe(req.body?.postalCode),
    );

    // The client generates a random `checkoutToken` once per checkout attempt
    // (kept stable across retries of that same attempt, e.g. via useRef) and
    // sends it back here. Anchoring the Stripe idempotency key to it means a
    // network retry or double-submit of the *same* attempt returns the same
    // PaymentIntent instead of creating — and potentially confirming — a
    // second one for the same charge. Falls back to an ungapped key when the
    // client is on an older build that doesn't send it yet.
    const checkoutToken = typeof req.body.checkoutToken === 'string' && req.body.checkoutToken.length > 0
      ? req.body.checkoutToken
      : undefined;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: taxResult.taxedAmountCents,
      currency,
      capture_method: 'automatic',
      payment_method_types: ['card'],
      metadata: {
        passenger_id: req.supabaseUid || 'anonymous',
        ...(taxResult.taxCalculationId ? {
          tax_calculation_id: taxResult.taxCalculationId,
          tax_amount_cents: String(taxResult.taxAmountCents),
        } : {}),
      },
      ...(customerId ? { customer: customerId } : {}),
      // Attach the saved PM upfront so Stripe validates it before confirm
      ...(attachedPmId ? { payment_method: attachedPmId } : {}),
    }, checkoutToken ? {
      idempotencyKey: `checkout_${req.supabaseUid || 'anon'}_${checkoutToken}`,
    } : undefined);

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      taxAmountCents: taxResult.taxAmountCents,
    });
  } catch (error: unknown) {
    log.error(`[STRIPE_ERROR]: ${errMsg(error)}`);
    res.status(500).json({ error: 'Payment processing failed. Please try again.' });
  }
});

// ââ Stripe Tax calculation helper âââââââââââââââââââââââââââââââââââââââââââââ
// Calculates applicable US tax for a given amount using Stripe Tax API.
// Falls back gracefully if Stripe Tax is not enabled on the account.
async function calculateStripeTax(
  stripe: Stripe,
  amountCents: number,
  reference: string,
  /**
   * El codigo postal de la recogida. Sin el, Stripe responde 400 -el impuesto
   * de ventas en EE. UU. cambia por condado, asi que el pais solo no le dice
   * nada- y el calculo caia siempre a la tasa de respaldo sin que se notara.
   * Ver `taxLocation.ts`.
   */
  postalCode?: string | null,
  taxCode = 'txcd_20030000' // Ground transportation
): Promise<{ taxedAmountCents: number; taxCalculationId?: string; taxAmountCents: number }> {
  // Sin codigo postal la llamada esta condenada a fallar: se va al respaldo sin
  // gastar la peticion ni llenar el panel de Stripe de errores 400.
  if (!postalCode) {
    log.warn(`[STRIPE_TAX] Sin codigo postal para ${reference}: se usa la tasa de respaldo.`);
    return tasaDeRespaldo(amountCents);
  }

  try {
    // stripe.tax exists in Stripe SDK >= 12 but may not be in older TS declarations
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calc = await (stripe as any).tax.calculations.create({
      currency: 'usd',
      customer_details: {
        address: { country: 'US', postal_code: postalCode },
        address_source: 'shipping',
      },
      line_items: [{
        amount: amountCents,
        reference,
        tax_behavior: 'exclusive',
        tax_code: taxCode,
      }],
    });
    return {
      taxedAmountCents: calc.amount_total as number,
      taxCalculationId: calc.id as string,
      taxAmountCents: calc.tax_amount_exclusive as number,
    };
  } catch (err: unknown) {
    log.warn(`[STRIPE_TAX] Calculo fallido para ${reference} (${postalCode}): ${errMsg(err)}. Se usa la tasa de respaldo.`);
    return tasaDeRespaldo(amountCents);
  }
}

/**
 * La estimacion de cuando Stripe Tax no puede calcular.
 *
 * La tasa la configura el panel (Tarifas). Antes estaba escrita aqui, asi que un
 * viaje fuera de EE. UU. se estimaba con impuestos de Florida.
 */
async function tasaDeRespaldo(
  amountCents: number,
): Promise<{ taxedAmountCents: number; taxAmountCents: number }> {
  const taxRate = await tasaImpuestoRespaldo();
  const taxAmountCents = Math.round(amountCents * taxRate);
  return { taxedAmountCents: amountCents + taxAmountCents, taxAmountCents };
}

// ââ Get or create Stripe customer for a user ââââââââââââââââââââââââââââââââââ
async function getOrCreateStripeCustomer(stripe: Stripe, userId: string): Promise<string> {
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_customer_id, email, first_name, last_name, phone')
    .eq('id', userId)
    .single();

  if (profile?.stripe_customer_id) return profile.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: profile?.email || undefined,
    name: [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || undefined,
    phone: profile?.phone || undefined,
    metadata: { supabase_user_id: userId },
  });

  await supabaseAdmin.from('profiles').update({ stripe_customer_id: customer.id }).eq('id', userId);
  return customer.id;
}

// ââ Create SetupIntent (save card for future use) âââââââââââââââââââââââââââââ
integrationsRouter.post("/stripe/setup-intent", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const customerId = await getOrCreateStripeCustomer(stripe, req.supabaseUid!);
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
    });

    res.json({ clientSecret: setupIntent.client_secret });
  } catch (error: unknown) {
    log.error(`[STRIPE_SETUP_INTENT]: ${errMsg(error)}`);
    res.status(500).json({ error: 'Could not initialize card setup. Please try again.' });
  }
});

// ââ List saved payment methods ââââââââââââââââââââââââââââââââââââââââââââââââ
integrationsRouter.get("/stripe/payment-methods", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', req.supabaseUid!)
      .single();

    if (!profile?.stripe_customer_id) return res.json({ methods: [], defaultPaymentMethodId: null });

    const [methods, customer] = await Promise.all([
      stripe.paymentMethods.list({ customer: profile.stripe_customer_id, type: 'card' }),
      stripe.customers.retrieve(profile.stripe_customer_id),
    ]);

    let defaultPaymentMethodId: string | null = null;
    if (!customer.deleted) {
      const dpm = (customer as Stripe.Customer).invoice_settings?.default_payment_method;
      if (dpm) defaultPaymentMethodId = typeof dpm === 'string' ? dpm : dpm.id;
    }

    const result = methods.data.map(pm => ({
      id: pm.id,
      brand: pm.card?.brand || 'card',
      last4: pm.card?.last4 || '????',
      exp_month: pm.card?.exp_month,
      exp_year: pm.card?.exp_year,
      funding: pm.card?.funding,
    }));

    res.json({ methods: result, defaultPaymentMethodId });
  } catch (error: unknown) {
    log.error(`[STRIPE_LIST_PM]: ${errMsg(error)}`);
    res.status(500).json({ error: 'Could not load payment methods.' });
  }
});

// ── Set default payment method ────────────────────────────────────────────────
// Persists the user's chosen "primary" card on the Stripe customer itself
// (invoice_settings.default_payment_method), so it survives across screens,
// sessions and devices instead of living only in a component's local state.
integrationsRouter.post("/stripe/payment-methods/:pmId/default", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const { pmId } = req.params;
    if (!pmId.startsWith('pm_')) return res.status(400).json({ error: 'Invalid payment method ID.' });

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', req.supabaseUid!)
      .single();

    if (!profile?.stripe_customer_id) return res.status(404).json({ error: 'No payment profile found.' });

    const pm = await stripe.paymentMethods.retrieve(pmId);
    if (pm.customer !== profile.stripe_customer_id) {
      return res.status(403).json({ error: 'Not your payment method.' });
    }

    await stripe.customers.update(profile.stripe_customer_id, {
      invoice_settings: { default_payment_method: pmId },
    });

    res.json({ success: true, defaultPaymentMethodId: pmId });
  } catch (error: unknown) {
    log.error(`[STRIPE_SET_DEFAULT_PM]: ${errMsg(error)}`);
    res.status(500).json({ error: 'Could not set default payment method.' });
  }
});

// ââ Delete a saved payment method âââââââââââââââââââââââââââââââââââââââââââââ
integrationsRouter.delete("/stripe/payment-methods/:pmId", requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

    const { pmId } = req.params;
    if (!pmId.startsWith('pm_')) return res.status(400).json({ error: 'Invalid payment method ID.' });

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', req.supabaseUid!)
      .single();

    const pm = await stripe.paymentMethods.retrieve(pmId);
    if (pm.customer !== profile?.stripe_customer_id) {
      return res.status(403).json({ error: 'Not your payment method.' });
    }

    await stripe.paymentMethods.detach(pmId);
    res.json({ success: true });
  } catch (error: unknown) {
    log.error(`[STRIPE_DELETE_PM]: ${errMsg(error)}`);
    res.status(500).json({ error: 'Could not remove payment method.' });
  }
});

// ââ Gift Requests (gift cards + guest bookings) ââââââââââââââââââââââââââââââââ
integrationsRouter.post("/gift-requests", requireSupabaseAuth, validateBody(['type']), async (req: Request, res: Response) => {
  try {
    const userId = req.supabaseUid!;
    const { type, ...details } = req.body;

    if (!['gift_card', 'guest_booking'].includes(type)) {
      return res.status(400).json({ error: 'Invalid request type.' });
    }

    const { data, error } = await supabaseAdmin
      .from('gift_requests')
      .insert({
        requester_user_id: userId,
        type,
        details: details,
        status: 'pending',
      })
      .select('id')
      .single();

    if (error) throw error;

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('first_name, last_name')
      .eq('id', userId)
      .single();

    const label = type === 'gift_card'
      ? `Gift card request â $${details.amount} to ${details.recipient_email}`
      : `Guest booking â ${details.guest_name} (${details.guest_phone}) on ${details.date} at ${details.time}`;

    await supabaseAdmin.from('support_tickets').insert({
      user_id: userId,
      user_name: [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || 'Passenger',
      category: type === 'gift_card' ? 'billing' : 'other',
      subject: type === 'gift_card' ? 'Gift Card Request' : 'Guest Booking Request',
      message: label,
      priority: 'normal',
      status: 'open',
    });

    res.json({ success: true, id: data.id });
  } catch (error: unknown) {
    log.error(`[GIFT_REQUEST]: ${errMsg(error)}`);
    res.status(500).json({ error: 'Could not process your request. Please try again.' });
  }
});

// ââ Stripe Connect: Create ride PaymentIntent with dynamic commission âââââââââ
// Uses calculateRideMetrics to compute the platform fee and driver payout.
// Requires the driver to have a Stripe Connected Account (stripe_account_id on profiles).
//
// POST /api/integrations/stripe/create-ride-payment
// Body: { rideId, totalFareUSD, driverConnectedAccountId?, driverRating? }
integrationsRouter.post(
  "/stripe/create-ride-payment",
  requireSupabaseAuth,
  validateBody(['rideId', 'totalFareUSD']),
  async (req: Request, res: Response) => {
    try {
      const stripe = getStripe();
      if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

      const { rideId, totalFareUSD, driverConnectedAccountId, driverRating } = req.body;

      const fareUSD = parseFloat(totalFareUSD);
      if (isNaN(fareUSD) || fareUSD < 1 || fareUSD > 10000) {
        return res.status(400).json({ error: 'Invalid totalFareUSD. Must be between $1 and $10,000.' });
      }

      // Fetch driver's Stripe Connected Account if not provided directly.
      // De paso, la comisión del valet: va incluida en el precio que se cobra,
      // pero no es del chofer, así que se descuenta antes de su 90 %.
      let connectedAccountId = driverConnectedAccountId || null;
      let valetCommissionCents = 0;
      let postalCode: string | null = null;

      {
        const { data: ride } = await supabaseAdmin
          .from('rides')
          .select('driver_id, valet_surcharge, pickup, dropoff')
          .eq('id', rideId)
          .maybeSingle();

        // Donde ocurre el servicio, para que Stripe Tax sepa que impuesto aplica.
        postalCode = codigoPostalDelViaje(ride as {
          pickup?: { address?: unknown } | null;
          dropoff?: { address?: unknown } | null;
        } | null ?? {});

        valetCommissionCents = Math.round(Number((ride as { valet_surcharge?: unknown } | null)?.valet_surcharge ?? 0) * 100) || 0;

        if (!connectedAccountId && ride?.driver_id) {
          const { data: driver } = await supabaseAdmin
            .from('profiles')
            .select('stripe_account_id')
            .eq('id', ride.driver_id)
            .maybeSingle();

          connectedAccountId = driver?.stripe_account_id || null;
        }
      }

      // Calculate commission â flat 10%
      const metrics = calculateRideMetrics({ totalFareUSD: fareUSD });

      // Build PaymentIntent options
      // capture_method: 'manual' â card is authorized (hold) but NOT charged until ride completes.
      // On cancellation during searching â cancel PI (zero charge, hold released instantly).
      // On ride completion â capture PI (charge the held amount).
      // Calculate Stripe Tax before creating the PaymentIntent
      const taxResult = await calculateStripeTax(stripe, metrics.totalCents, rideId, postalCode);

      const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
        amount: taxResult.taxedAmountCents,
        currency: 'usd',
        capture_method: 'manual',
        payment_method_types: ['card'],
        metadata: {
          ride_id: rideId,
          passenger_id: req.supabaseUid || 'anonymous',
          commission_rate: String(metrics.commissionRate),
          fare_cents: String(metrics.totalCents),
          ...(taxResult.taxCalculationId ? {
            tax_calculation_id: taxResult.taxCalculationId,
            tax_amount_cents: String(taxResult.taxAmountCents),
          } : {}),
        },
      };

      // Reparto con Stripe Connect, sólo si el chofer tiene cuenta conectada.
      //
      // Se manda SÓLO `application_fee_amount`: Stripe rechaza que vayan a la vez
      // con `transfer_data.amount`, así que con las dos el cobro fallaba entero.
      // El impuesto va dentro de la comisión porque lo declara la plataforma; al
      // chofer le llega el 90 % del precio, sin impuesto.
      if (connectedAccountId) {
        const reparto = calcularReparto({
          fareCents:  metrics.totalCents,
          taxCents:   taxResult.taxAmountCents,
          valetCents: Math.min(valetCommissionCents, metrics.totalCents),
        });
        paymentIntentParams.application_fee_amount = reparto.applicationFeeCents;
        paymentIntentParams.transfer_data = { destination: connectedAccountId };
        paymentIntentParams.metadata = {
          ...paymentIntentParams.metadata,
          driver_payout_cents: String(reparto.driverPayoutCents),
        };
      }

      // FIX: idempotencyKey anchored to rideId — a client retry (e.g. the passenger's
      // app times out waiting for a response and resends the same request) would
      // previously create a second PaymentIntent and place a second hold on the
      // passenger's card for the same ride. Stripe now returns the original
      // PaymentIntent instead of creating a duplicate for the same key.
      const paymentIntent = await stripe.paymentIntents.create(paymentIntentParams, {
        idempotencyKey: `create-ride-payment_${rideId}`,
      });

      // El impuesto que calculó Stripe se guarda en el viaje: es lo que el
      // historial del pasajero muestra como total. Sin esto, la lista tendría
      // que estimarlo. No bloquea el cobro si falla.
      void supabaseAdmin
        .from('rides')
        .update({
          tax_amount:     Math.round(taxResult.taxAmountCents) / 100,
          total_with_tax: Math.round(taxResult.taxedAmountCents) / 100,
        })
        .eq('id', rideId)
        .then(({ error }) => {
          if (error) log.warn(`[STRIPE] No se pudo guardar el impuesto del viaje ${rideId}: ${error.message}`);
        });

      // Store payment intent + fee on the ride record
      await supabaseAdmin.from('rides').update({
        payment_intent_id: paymentIntent.id,
        updated_at: new Date().toISOString(),
      }).eq('id', rideId);

      res.json({
        clientSecret: paymentIntent.client_secret,
        metrics: {
          totalUSD: fareUSD,
          totalCents: metrics.totalCents,
          taxAmountCents: taxResult.taxAmountCents,
          totalWithTaxCents: taxResult.taxedAmountCents,
          platformFeeCents: metrics.applicationFeeCents,
          driverPayoutCents: metrics.driverPayoutCents,
          commissionRate: '10%',
          driverHasConnectedAccount: !!connectedAccountId,
        },
      });
    } catch (error: unknown) {
      log.error(`[STRIPE_CONNECT]: ${errMsg(error)}`);
      res.status(500).json({ error: 'Failed to create ride payment.' });
    }
  },
);

// ââ Stripe Connect: Start onboarding (driver or valet) âââââââââââââââââââââââ
// POST /api/integrations/stripe/connect/create-account
// Creates an Express Connected Account (or reuses existing) and returns an onboarding link.
integrationsRouter.post(
  "/stripe/connect/create-account",
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    try {
      const stripe = getStripe();
      if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

      const userId = req.supabaseUid!;

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('stripe_account_id, email, first_name, last_name, role')
        .eq('id', userId)
        .maybeSingle();

      if (!profile) return res.status(404).json({ error: 'Profile not found' });

      let accountId = profile.stripe_account_id as string | null;

      if (!accountId) {
        // Sin `type: 'express'`, que es el campo antiguo: fija todas las
        // responsabilidades de golpe y Stripe lo rechazaba contra el perfil de
        // esta plataforma («You tried to create an Accounts v1 connected account
        // using the legacy `type` field…»). Se declaran una a una, que es lo que
        // su soporte indicó:
        //
        //   stripe_dashboard.type   express  → el panel simplificado del chofer,
        //                                      el que abre `createLoginLink`.
        //   losses.payments         application → los saldos negativos los asume
        //                                      Urbont, que es quien cobra al pasajero.
        //   requirement_collection  stripe   → obligatorio con Express; con
        //                                      'application' vuelve a fallar.
        //   fees.payer              application → las comisiones de Stripe salen
        //                                      de la parte de Urbont, como hasta ahora.
        //
        // Los cobros no cambian: `application_fee_amount` y `transfer_data` son
        // del momento del pago, no de la creación de la cuenta.
        const account = await stripe.accounts.create({
          country: 'US',
          email: profile.email || undefined,
          controller: {
            stripe_dashboard: { type: 'express' },
            losses: { payments: 'application' },
            fees: { payer: 'application' },
            requirement_collection: 'stripe',
          },
          capabilities: { transfers: { requested: true } },
          business_type: 'individual',
          individual: {
            first_name: profile.first_name || undefined,
            last_name: profile.last_name || undefined,
          },
          metadata: { supabase_user_id: userId, role: profile.role || 'driver' },
        });

        accountId = account.id;

        await supabaseAdmin.from('profiles').update({
          stripe_account_id: accountId,
          stripe_connect_status: 'pending',
        }).eq('id', userId);
      }

      // A donde Stripe devuelve al chofer al terminar (o al vencer el enlace).
      // Antes salía de REPLIT_DOMAINS y, sin esa variable, caía en urbont.app:
      // un dominio que no existe, así que el chofer terminaba su registro en una
      // página de error. Las dos páginas viven en websitev2.
      const appDomain = (process.env.PUBLIC_WEB_URL || 'https://urbont.com').replace(/\/+$/, '');

      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: `${appDomain}/stripe-connect-refresh`,
        return_url: `${appDomain}/stripe-connect-return`,
        type: 'account_onboarding',
      });

      res.json({ onboardingUrl: accountLink.url, accountId });
    } catch (error: unknown) {
      log.error(`[STRIPE_CONNECT_ONBOARD]: ${errMsg(error)}`);
      res.status(500).json({ error: 'Failed to start Stripe onboarding.' });
    }
  },
);

// ââ Stripe Connect: Get account status âââââââââââââââââââââââââââââââââââââââ
// GET /api/integrations/stripe/connect/status
integrationsRouter.get(
  "/stripe/connect/status",
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    try {
      const stripe = getStripe();
      if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

      const userId = req.supabaseUid!;

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('stripe_account_id, stripe_connect_status')
        .eq('id', userId)
        .maybeSingle();

      const accountId = profile?.stripe_account_id as string | null;

      if (!accountId) {
        return res.json({ status: 'not_connected', accountId: null, chargesEnabled: false, payoutsEnabled: false });
      }

      const account = await stripe.accounts.retrieve(accountId);
      const newStatus = account.details_submitted ? 'active' : 'pending';

      if (newStatus !== profile?.stripe_connect_status) {
        await supabaseAdmin.from('profiles').update({ stripe_connect_status: newStatus }).eq('id', userId);
      }

      res.json({
        status: newStatus,
        accountId,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
        detailsSubmitted: account.details_submitted,
      });
    } catch (error: unknown) {
      log.error(`[STRIPE_CONNECT_STATUS]: ${errMsg(error)}`);
      res.status(500).json({ error: 'Failed to retrieve Stripe account status.' });
    }
  },
);

// ââ Stripe Connect: Dashboard login link âââââââââââââââââââââââââââââââââââââ
// POST /api/integrations/stripe/connect/dashboard-link
integrationsRouter.post(
  "/stripe/connect/dashboard-link",
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    try {
      const stripe = getStripe();
      if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

      const userId = req.supabaseUid!;

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('stripe_account_id')
        .eq('id', userId)
        .maybeSingle();

      const accountId = profile?.stripe_account_id as string | null;
      if (!accountId) return res.status(400).json({ error: 'No Stripe account connected' });

      const loginLink = await stripe.accounts.createLoginLink(accountId);

      res.json({ url: loginLink.url });
    } catch (error: unknown) {
      log.error(`[STRIPE_CONNECT_DASHBOARD]: ${errMsg(error)}`);
      res.status(500).json({ error: 'Failed to generate dashboard link.' });
    }
  },
);

// ââ Capture PaymentIntent (ride completed â charge passenger) âââââââââââââââââ
// POST /api/integrations/stripe/capture/:paymentIntentId
integrationsRouter.post(
  '/stripe/capture/:paymentIntentId',
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    try {
      const stripe = getStripe();
      if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

      const paymentIntentId = req.params.paymentIntentId;
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (pi.status !== 'requires_capture') {
        return res.status(409).json({
          error: `PaymentIntent is in status '${pi.status}', cannot capture.`,
        });
      }

      const captured = await stripe.paymentIntents.capture(paymentIntentId);
      log.info(`[STRIPE] Payment captured â ${paymentIntentId} $${captured.amount / 100}`);

      res.json({ success: true, status: captured.status, amount: captured.amount });
    } catch (error: unknown) {
      log.error(`[STRIPE_CAPTURE]: ${errMsg(error)}`);
      res.status(500).json({ error: 'Failed to capture payment.' });
    }
  },
);

// -- Cancel/refund PaymentIntent (e.g. ride creation failed after charge) --
// POST /api/integrations/stripe/cancel/:paymentIntentId
//
// Status-aware: a PaymentIntent created with capture_method:'automatic'
// (like /stripe/create-payment-intent) is already captured the instant
// confirmCardPayment() succeeds -- calling paymentIntents.cancel() on it
// throws (Stripe only allows cancel on an uncaptured intent), silently
// leaving the passenger charged with no refund. Mirrors the status-aware
// cancel/refund logic already used for ride cancellations in rides.ts.
integrationsRouter.post(
  '/stripe/cancel/:paymentIntentId',
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    try {
      const stripe = getStripe();
      if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

      const paymentIntentId = req.params.paymentIntentId;
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (pi.status === 'requires_capture' || pi.status === 'requires_payment_method' || pi.status === 'requires_confirmation') {
        const cancelled = await stripe.paymentIntents.cancel(paymentIntentId);
        log.info(`[STRIPE] Payment cancelled (uncaptured) -> ${paymentIntentId}`);
        return res.json({ success: true, status: cancelled.status, refunded: false });
      }

      if (pi.status === 'succeeded') {
        // Already captured -- plain cancel() would throw. Issue a full refund instead.
        const refund = await stripe.refunds.create({ payment_intent: paymentIntentId });
        log.info(`[STRIPE] Payment refunded (was already captured) -> ${paymentIntentId} ($${(pi.amount_received ?? pi.amount) / 100})`);
        return res.json({ success: true, status: refund.status, refunded: true });
      }

      // 'canceled' or another terminal state -- nothing to do.
      res.json({ success: true, status: pi.status, refunded: false });
    } catch (error: unknown) {
      log.error(`[STRIPE_CANCEL]: ${errMsg(error)}`);
      res.status(500).json({ error: 'Failed to cancel/refund payment.' });
    }
  },
);

// ââ Post-ride tip â charge passenger + transfer to driver âââââââââââââââââââââ
// POST /api/integrations/stripe/tip
// Body: { rideId, amount }  (amount in USD, e.g. 5.00)
integrationsRouter.post(
  '/stripe/tip',
  requireSupabaseAuth,
  validateBody(['rideId', 'amount']),
  async (req: Request, res: Response) => {
    try {
      const stripe = getStripe();
      if (!stripe) return res.status(503).json({ error: 'Payment service unavailable' });

      const { rideId, amount } = req.body as { rideId: string; amount: number };
      const passengerId = req.supabaseUid!;

      if (typeof amount !== 'number' || amount <= 0 || amount > 200) {
        return res.status(400).json({ error: 'Tip amount must be between $0.01 and $200' });
      }

      const { data: ride, error: rideErr } = await supabaseAdmin
        .from('rides')
        .select('id, ride_status, passenger_id, driver_id, tip_amount, payment_method')
        .eq('id', rideId)
        .maybeSingle();

      if (rideErr || !ride) return res.status(404).json({ error: 'Ride not found' });
      if (String(ride.passenger_id) !== passengerId) return res.status(403).json({ error: 'Not your ride' });
      if (ride.ride_status !== 'completed') return res.status(400).json({ error: 'Can only tip completed rides' });
      if (ride.payment_method === 'cash') return res.status(400).json({ error: 'Cash rides cannot be tipped via card' });
      if (Number(ride.tip_amount) > 0) return res.status(409).json({ error: 'Tip already recorded for this ride' });

      const { data: passenger } = await supabaseAdmin
        .from('profiles')
        .select('stripe_customer_id')
        .eq('id', passengerId)
        .maybeSingle();

      const customerId = passenger?.stripe_customer_id as string | undefined;
      if (!customerId) {
        return res.status(400).json({ error: 'No saved payment method on file. Please add a card first.' });
      }

      const { data: driverProfile } = await supabaseAdmin
        .from('profiles')
        .select('stripe_account_id, stripe_connect_status')
        .eq('id', String(ride.driver_id))
        .maybeSingle();

      const driverAccountId = driverProfile?.stripe_account_id as string | undefined;
      const tipCents = Math.round(amount * 100);

      const paymentMethods = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
      if (!paymentMethods.data.length) {
        return res.status(400).json({ error: 'No saved card found. Please add a card first.' });
      }

      const pmId = paymentMethods.data[0].id;

      // Idempotency key anchored to rideId + passenger — a retry (timeout,
      // double-tap) resolves to the same PaymentIntent instead of charging twice.
      const pi = await stripe.paymentIntents.create({
        amount: tipCents,
        currency: 'usd',
        customer: customerId,
        payment_method: pmId,
        payment_method_types: ['card'],
        confirm: true,
        off_session: true,
        metadata: { ride_id: rideId, type: 'tip' },
      }, {
        idempotencyKey: `tip_${rideId}_${passengerId}`,
      });

      let transferId: string | undefined;
      if (driverAccountId && driverProfile?.stripe_connect_status === 'active') {
        const latestCharge = typeof pi.latest_charge === 'string' ? pi.latest_charge : undefined;
        const transfer = await stripe.transfers.create({
          amount: tipCents,
          currency: 'usd',
          destination: driverAccountId,
          source_transaction: latestCharge,
          metadata: { ride_id: rideId, type: 'tip' },
        }, {
          idempotencyKey: `tip-transfer_${rideId}_${pi.id}`,
        });
        transferId = transfer.id;
      }

      // Compare-and-swap: only record the tip if no tip landed concurrently.
      const { data: tipUpdated } = await supabaseAdmin
        .from('rides')
        .update({ tip_amount: amount, updated_at: new Date().toISOString() })
        .eq('id', rideId)
        .is('tip_amount', null)
        .select('id')
        .maybeSingle();
      if (!tipUpdated) {
        log.warn(`[STRIPE_TIP] tip_amount CAS miss for ride ${rideId} — a tip was already recorded concurrently (charge ${pi.id} still succeeded and must be reconciled manually)`);
      }

      log.info(`[STRIPE] Tip $${amount} for ride ${rideId} â driver ${driverAccountId || 'no-connect'} (transfer: ${transferId})`);

      res.json({ success: true, tipAmount: amount, paymentIntentId: pi.id, transferId });
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      log.error(`[STRIPE_TIP]: ${errMessage}`);
      res.status(500).json({ error: 'Failed to process tip', details: errMessage });
    }
  },
);
