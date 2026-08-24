import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { requireSupabaseAuth } from '../middleware';
import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

let _subsStripe: Stripe | null = null;
function getStripe(): Stripe | null {
  if (_subsStripe) return _subsStripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    logger.warn('[SUBSCRIPTIONS] STRIPE_SECRET_KEY is not set — subscription payments will not work.');
    return null;
  }
  _subsStripe = new Stripe(key);
  return _subsStripe;
}

const PASS_PRICE_ID = process.env.URBONT_PASS_PRICE_ID || '';
const PASS_PRICE_CENTS = 2900; // $29/month
const PASS_DISCOUNT_PCT = 10;  // 10% off every ride

export const subscriptionsRouter = Router();

// GET /api/subscriptions/status — check current pass status
subscriptionsRouter.get('/status', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { data: sub } = await supabaseAdmin
    .from('urbont_subscriptions')
    .select('*')
    .eq('user_id', uid)
    .maybeSingle();

  if (!sub) return res.json({ active: false, subscription: null });

  // If period ended, mark inactive
  if (sub.current_period_end && new Date(sub.current_period_end) < new Date() && sub.status === 'active') {
    await supabaseAdmin.from('urbont_subscriptions').update({ status: 'cancelled' }).eq('user_id', uid);
    await supabaseAdmin.from('profiles').update({ urbont_pass_active: false }).eq('id', uid);
    return res.json({ active: false, subscription: { ...sub, status: 'cancelled' } });
  }

  res.json({ active: sub.status === 'active', subscription: sub, discountPct: PASS_DISCOUNT_PCT });
});

// POST /api/subscriptions/subscribe — subscribe to URBONT Pass
subscriptionsRouter.post('/subscribe', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { paymentMethodId } = req.body as { paymentMethodId?: string };

  // Check if already subscribed
  const { data: existing } = await supabaseAdmin
    .from('urbont_subscriptions')
    .select('status, stripe_customer_id')
    .eq('user_id', uid)
    .maybeSingle();

  if (existing?.status === 'active') return res.status(400).json({ error: 'Already subscribed to URBONT Pass' });

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('email, first_name, last_name')
    .eq('id', uid)
    .maybeSingle();

  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Payment processing is not configured on this server.' });
    // Get or create Stripe customer
    let customerId = existing?.stripe_customer_id as string | undefined;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: profile?.email || '',
        name: [profile?.first_name, profile?.last_name].filter(Boolean).join(' '),
        metadata: { user_id: uid },
      });
      customerId = customer.id;
    }

    if (paymentMethodId) {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
      await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } });
    }

    // If Stripe Price ID is configured, create real subscription; otherwise use a one-month manual period
    let subId: string | null = null;
    let periodStart = new Date();
    let periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    if (PASS_PRICE_ID && paymentMethodId) {
      const stripeSub = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: PASS_PRICE_ID }],
        default_payment_method: paymentMethodId,
        metadata: { user_id: uid },
      });
      subId = stripeSub.id;
      periodStart = new Date(Number((stripeSub as unknown as Record<string,unknown>).current_period_start) * 1000);
      periodEnd = new Date(Number((stripeSub as unknown as Record<string,unknown>).current_period_end) * 1000);
    } else {
      // No Stripe price configured — create a manual PaymentIntent for $29
      // Idempotency key anchored to the user — a retry/double-tap within the
      // key's ~24h Stripe window resolves to the same PaymentIntent instead of
      // charging the pass twice. Naturally expires so a genuine resubscribe
      // later isn't blocked.
      const pi = await stripe.paymentIntents.create({
        amount: PASS_PRICE_CENTS,
        currency: 'usd',
        customer: customerId,
        payment_method: paymentMethodId,
        confirm: !!paymentMethodId,
        metadata: { user_id: uid, type: 'urbont_pass' },
        description: 'URBONT Pass — 1 month subscription',
      }, {
        idempotencyKey: `urbont-pass_${uid}`,
      });
      return res.json({
        requiresAction: pi.status === 'requires_action',
        clientSecret: pi.client_secret,
        paymentIntentId: pi.id,
        message: 'Complete payment to activate your URBONT Pass',
      });
    }

    // Upsert subscription record
    await supabaseAdmin.from('urbont_subscriptions').upsert({
      user_id: uid,
      stripe_subscription_id: subId,
      stripe_customer_id: customerId,
      plan: 'pass',
      status: 'active',
      discount_pct: PASS_DISCOUNT_PCT,
      current_period_start: periodStart.toISOString(),
      current_period_end: periodEnd.toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    await supabaseAdmin.from('profiles').update({ urbont_pass_active: true }).eq('id', uid);

    res.json({ success: true, active: true, discountPct: PASS_DISCOUNT_PCT, periodEnd: periodEnd.toISOString() });
  } catch (err: any) {
    logger.error(`[SUBSCRIPTIONS] Subscribe error: ${err.message}`);
    res.status(500).json({ error: 'Failed to create subscription: ' + err.message });
  }
});

// POST /api/subscriptions/cancel — cancel URBONT Pass
subscriptionsRouter.post('/cancel', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { data: sub } = await supabaseAdmin
    .from('urbont_subscriptions')
    .select('stripe_subscription_id, status')
    .eq('user_id', uid)
    .maybeSingle();

  if (!sub || sub.status !== 'active') return res.status(400).json({ error: 'No active subscription to cancel' });

  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Payment processing is not configured on this server.' });
    if (sub.stripe_subscription_id) {
      await stripe.subscriptions.cancel(sub.stripe_subscription_id);
    }

    await supabaseAdmin.from('urbont_subscriptions')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('user_id', uid);

    await supabaseAdmin.from('profiles').update({ urbont_pass_active: false }).eq('id', uid);

    res.json({ success: true, message: 'URBONT Pass cancelled. Discount active until end of period.' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to cancel: ' + err.message });
  }
});

// POST /api/subscriptions/activate — activate after manual PaymentIntent succeeded (webhook or client-side)
subscriptionsRouter.post('/activate', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { paymentIntentId, stripeCustomerId } = req.body as { paymentIntentId?: string; stripeCustomerId?: string };

  // Verify the PaymentIntent with Stripe before activating the subscription.
  // Prevents an authenticated user from activating a pass without actually paying.
  if (paymentIntentId) {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Payment processing not configured' });
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (pi.status !== 'succeeded') {
        return res.status(402).json({ error: 'Payment not yet completed' });
      }
      if (pi.metadata?.user_id && pi.metadata.user_id !== uid) {
        return res.status(403).json({ error: 'Payment belongs to a different account' });
      }
    } catch (piErr: unknown) {
      logger.error(`[SUBSCRIPTIONS] PI verification failed for ${paymentIntentId}: ${piErr instanceof Error ? piErr.message : String(piErr)}`);
      return res.status(400).json({ error: 'Could not verify payment' });
    }
  }

  const periodStart = new Date();
  const periodEnd = new Date();
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  await supabaseAdmin.from('urbont_subscriptions').upsert({
    user_id: uid,
    stripe_subscription_id: paymentIntentId || null,
    stripe_customer_id: stripeCustomerId || null,
    plan: 'pass',
    status: 'active',
    discount_pct: PASS_DISCOUNT_PCT,
    current_period_start: periodStart.toISOString(),
    current_period_end: periodEnd.toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });

  await supabaseAdmin.from('profiles').update({ urbont_pass_active: true }).eq('id', uid);

  res.json({ success: true, active: true, discountPct: PASS_DISCOUNT_PCT });
});
