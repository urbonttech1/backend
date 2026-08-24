import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
import Stripe from 'stripe';
import { requireSupabaseAuth } from '../middleware';
import { supabaseAdmin } from '../db/client';

const _TIPS_SK = process.env.STRIPE_SECRET_KEY || '';
let _tipsStripe: Stripe | null = null;
function getStripe(): Stripe | null {
  if (_tipsStripe) return _tipsStripe;
  if (!_TIPS_SK) { logger.warn('[WARN] STRIPE_SECRET_KEY not set — tips unavailable.'); return null; }
  _tipsStripe = new Stripe(_TIPS_SK);
  return _tipsStripe;
}

export const tipsRouter = Router();

// POST /api/tips/:rideId — add a tip to a completed ride
tipsRouter.post('/:rideId', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { rideId } = req.params;
  const { amount, paymentMethodId } = req.body as { amount?: number; paymentMethodId?: string };

  if (!amount || amount < 1 || amount > 200) {
    return res.status(400).json({ error: 'Tip amount must be between $1 and $200' });
  }

  // FIX: Guard against unconfigured Stripe — getStripe() returns null when key is absent.
  // Previously this would throw TypeError: Cannot read properties of null (reading 'paymentIntents')
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Payment processing is temporarily unavailable. Please try again later.' });
  }

  // Verify ride belongs to this passenger and is completed
  const { data: ride, error: rideErr } = await supabaseAdmin
    .from('rides')
    .select('id, passenger_id, driver_id, ride_status, tip_amount, fare')
    .eq('id', rideId)
    .eq('passenger_id', uid)
    .maybeSingle();

  if (rideErr || !ride) return res.status(404).json({ error: 'Ride not found' });
  if (ride.ride_status !== 'completed') return res.status(400).json({ error: 'Can only tip on completed rides' });
  if (ride.tip_amount) return res.status(400).json({ error: 'This ride already has a tip' });

  try {
    const amountCents = Math.round(amount * 100);

    // Re-check tip_amount immediately before charging to shrink the race window
    // where two concurrent requests both pass the initial guard above.
    const { data: freshRide } = await supabaseAdmin
      .from('rides')
      .select('tip_amount')
      .eq('id', rideId)
      .maybeSingle();
    if (freshRide?.tip_amount) return res.status(409).json({ error: 'This ride already has a tip' });

    // Create and confirm PaymentIntent for tip. Idempotency key is anchored to
    // rideId + passenger — a client retry (timeout, double-tap) resolves to the
    // same PaymentIntent instead of creating a second charge for the same tip.
    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      payment_method: paymentMethodId,
      confirm: !!paymentMethodId,
      metadata: { ride_id: rideId, type: 'tip', passenger_id: uid, driver_id: ride.driver_id || '' },
      description: `URBONT tip for ride ${rideId}`,
    }, {
      idempotencyKey: `tip_${rideId}_${uid}`,
    });

    // Record tip on ride — only if no tip was recorded meanwhile (compare-and-swap
    // via .is('tip_amount', null)) so a concurrent duplicate charge, if it ever
    // slipped through, can't silently overwrite an already-recorded tip.
    await supabaseAdmin.from('rides').update({
      tip_amount: amount,
      tip_pi_id: pi.id,
      updated_at: new Date().toISOString(),
    }).eq('id', rideId).is('tip_amount', null);

    res.json({
      success: true,
      tipAmount: amount,
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
    });
  } catch (err: any) {
    logger.error(`[TIPS] Error creating tip payment: ${err.message}`);
    res.status(500).json({ error: 'Failed to process tip' });
  }
});

// GET /api/tips/:rideId — get tip status for a ride
tipsRouter.get('/:rideId', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { data: ride } = await supabaseAdmin
    .from('rides')
    .select('tip_amount, tip_pi_id')
    .eq('id', req.params.rideId)
    .eq('passenger_id', uid)
    .maybeSingle();

  res.json({ tipAmount: ride?.tip_amount || null, tipPiId: ride?.tip_pi_id || null });
});
