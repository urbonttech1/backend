import { Router, Request, Response } from 'express';
  import Stripe from 'stripe';
  import crypto from 'crypto';
  import { requireSupabaseAuth } from '../middleware';
  import { supabaseAdmin } from '../db/client';
  import { logger } from '../lib/logger';

  function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

  let _splitsStripe: Stripe | null = null;
  function getStripe(): Stripe | null {
    if (_splitsStripe) return _splitsStripe;
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      logger.warn('[SPLITS] STRIPE_SECRET_KEY is not set — fare splitting will not work.');
      return null;
    }
    _splitsStripe = new Stripe(key);
    return _splitsStripe;
  }

  export const splitsRouter = Router();

  // POST /api/splits/:rideId — create a fare split session
  splitsRouter.post('/:rideId', requireSupabaseAuth, async (req: Request, res: Response) => {
    const uid = req.supabaseUid!;
    const { rideId } = req.params;
    const { splitCount } = req.body as { splitCount?: number };

    if (!splitCount || splitCount < 2 || splitCount > 8) {
      return res.status(400).json({ error: 'splitCount must be between 2 and 8' });
    }

    // Verify ride belongs to this passenger
    const { data: ride } = await supabaseAdmin
      .from('rides')
      .select('id, fare, passenger_id, ride_status, pickup, dropoff')
      .eq('id', rideId)
      .eq('passenger_id', uid)
      .maybeSingle();

    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    if (!ride.fare) return res.status(400).json({ error: 'Ride fare not yet calculated' });

    const totalCents = Math.round(ride.fare * 100);
    const perPersonCents = Math.floor(totalCents / splitCount);
    // Remainder cents (totalCents % splitCount) are assigned to the organizer so the
    // sum of all shares always equals totalCents exactly (no cents lost to Math.floor).
    const remainderCents = totalCents - perPersonCents * splitCount;
    const organizerShareCents = perPersonCents + remainderCents;
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const { data: split, error } = await supabaseAdmin
      .from('fare_splits')
      .insert({
        ride_id: rideId,
        token,
        total_cents: totalCents,
        split_count: splitCount,
        paid_count: 1, // requester already paying their share via main fare
        per_person_cents: perPersonCents,
        organizer_share_cents: organizerShareCents,
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: 'Failed to create split session' });

    const shareUrl = `${process.env.APP_URL || 'https://urbont.app'}/split/${token}`;

    res.json({
      splitId: split.id,
      token,
      shareUrl,
      totalCents,
      perPersonCents,
      organizerShareCents,
      remainderCents,
      splitCount,
      expiresAt: expiresAt.toISOString(),
    });
  });

  // GET /api/splits/join/:token — get split session details (public — no auth needed)
  splitsRouter.get('/join/:token', async (req: Request, res: Response) => {
    const { data: split } = await supabaseAdmin
      .from('fare_splits')
      .select('*, fare_split_payments(*)')
      .eq('token', req.params.token)
      .maybeSingle();

    if (!split) return res.status(404).json({ error: 'Split session not found or expired' });
    if (new Date(split.expires_at) < new Date()) return res.status(400).json({ error: 'This split link has expired' });

    const remaining = split.split_count - split.paid_count;
    const perPersonCents = split.per_person_cents ?? Math.floor(split.total_cents / split.split_count);

    // Get ride details
    const { data: ride } = await supabaseAdmin
      .from('rides')
      .select('pickup, dropoff, vehicle_type')
      .eq('id', split.ride_id)
      .maybeSingle();

    res.json({
      splitId: split.id,
      rideId: split.ride_id,
      totalCents: split.total_cents,
      perPersonCents,
      splitCount: split.split_count,
      paidCount: split.paid_count,
      remaining,
      expiresAt: split.expires_at,
      ride: ride || null,
      payments: split.fare_split_payments || [],
    });
  });

  // POST /api/splits/pay/:token — pay your share of the split
  splitsRouter.post('/pay/:token', async (req: Request, res: Response) => {
    const { payerName, payerEmail, paymentMethodId } = req.body as {
      payerName?: string; payerEmail?: string; paymentMethodId?: string;
    };

    const { data: split } = await supabaseAdmin
      .from('fare_splits')
      .select('*')
      .eq('token', req.params.token)
      .maybeSingle();

    if (!split) return res.status(404).json({ error: 'Split not found' });
    if (new Date(split.expires_at) < new Date()) return res.status(400).json({ error: 'Split link expired' });
    if (split.paid_count >= split.split_count) return res.status(400).json({ error: 'All shares already paid' });

    const perPersonCents = split.per_person_cents ?? Math.floor(split.total_cents / split.split_count);

    try {
      const stripe = getStripe();
      if (!stripe) return res.status(503).json({ error: 'Payment processing is not configured on this server.' });

      // Calculate Stripe Tax for the split share
      let taxedAmountCents = perPersonCents;
      let taxCalculationId: string | undefined;
      let taxAmountCents = 0;
      try {
        const calc = await (stripe.tax as unknown as { calculations: { create: (args: unknown) => Promise<{ id: string; amount_total: number; tax_amount_exclusive: number }> } }).calculations.create({
          currency: 'usd',
          customer_details: {
            address: { country: 'US' },
            address_source: 'shipping',
          },
          line_items: [{
            amount: perPersonCents,
            reference: `split-${split.id}`,
            tax_behavior: 'exclusive',
            tax_code: 'txcd_20030000',
          }],
        });
        taxedAmountCents = calc.amount_total as number;
        taxCalculationId = calc.id as string;
        taxAmountCents = calc.tax_amount_exclusive as number;
      } catch {
        // Stripe Tax not enabled — proceed without tax
      }

      // Idempotency key anchored to the split + the payment method being charged
      // — a network retry or double-tap of the same card resolves to the same
      // PaymentIntent instead of charging that guest twice for their share.
      const pi = await stripe.paymentIntents.create({
        amount: taxedAmountCents,
        currency: 'usd',
        payment_method: paymentMethodId,
        confirm: !!paymentMethodId,
        metadata: {
          fare_split_id: split.id,
          ride_id: split.ride_id,
          payer_name: payerName || 'Guest',
          type: 'fare_split',
          fare_cents: String(perPersonCents),
          ...(taxCalculationId ? {
            tax_calculation_id: taxCalculationId,
            tax_amount_cents: String(taxAmountCents),
          } : {}),
        },
        description: `URBONT split fare — ${payerName || 'Guest'}`,
      }, {
        idempotencyKey: `fare-split_${split.id}_${paymentMethodId || payerEmail || payerName || 'guest'}`,
      });

      // Record payment
      await supabaseAdmin.from('fare_split_payments').insert({
        fare_split_id: split.id,
        payer_name: payerName || 'Guest',
        payer_email: payerEmail || null,
        amount_cents: perPersonCents,
        payment_intent_id: pi.id,
        status: pi.status === 'succeeded' ? 'paid' : 'pending',
        paid_at: pi.status === 'succeeded' ? new Date().toISOString() : null,
      });

      // Atomic paid_count increment using optimistic locking.
      // If two guests simultaneously reach this point for the last slot, only one will
      // succeed the update (.eq('paid_count', split.paid_count) acts as a compare-and-swap).
      // The loser gets their Stripe payment refunded immediately.
      if (pi.status === 'succeeded') {
        const { data: atomicSlot } = await supabaseAdmin
          .from('fare_splits')
          .update({ paid_count: split.paid_count + 1 })
          .eq('id', split.id)
          .eq('paid_count', split.paid_count)   // CAS: only update if count hasn't changed
          .lt('paid_count', split.split_count)  // safety guard: never exceed split_count
          .select('id')
          .maybeSingle();

        if (!atomicSlot) {
          // Concurrent payment claimed this slot first — refund this payment immediately
          try { await stripe.refunds.create({ payment_intent: pi.id }); } catch { /* best-effort */ }
          return res.status(409).json({
            error: 'This share was just claimed by another payment. You have not been charged.',
          });
        }
      }

      res.json({
        success: true,
        requiresAction: pi.status === 'requires_action',
        clientSecret: pi.client_secret,
        paymentIntentId: pi.id,
        amountCents: perPersonCents,
      });
    } catch (err: any) {
      res.status(500).json({ error: 'Payment failed: ' + errMsg(err) });
    }
  });

  // GET /api/splits/:rideId/status — check split status for a ride
  splitsRouter.get('/:rideId/status', requireSupabaseAuth, async (req: Request, res: Response) => {
    const { data: split } = await supabaseAdmin
      .from('fare_splits')
      .select('*, fare_split_payments(*)')
      .eq('ride_id', req.params.rideId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!split) return res.json({ hasSplit: false });

    res.json({
      hasSplit: true,
      splitId: split.id,
      token: split.token,
      paidCount: split.paid_count,
      splitCount: split.split_count,
      payments: split.fare_split_payments,
    });
  });
  