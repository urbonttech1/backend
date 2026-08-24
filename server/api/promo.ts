import { Router, Request, Response } from 'express';
import { requireSupabaseAuth } from '../middleware';
import { requireAdminJWT } from './admin-auth';
import { supabaseAdmin } from '../db/client';

export const promoRouter = Router();

// POST /api/promo/validate — validate a promo code for a given ride amount
promoRouter.post('/validate', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { code, rideAmount } = req.body as { code?: string; rideAmount?: number };
  if (!code) return res.status(400).json({ error: 'Code is required' });

  const normalised = code.trim().toUpperCase();

  const { data: promo, error } = await supabaseAdmin
    .from('promo_codes')
    .select('*')
    .eq('code', normalised)
    .eq('is_active', true)
    .maybeSingle();

  if (error || !promo) return res.status(404).json({ error: 'Promo code not found or expired' });

  // Check expiry
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
    return res.status(400).json({ error: 'This promo code has expired' });
  }

  // Check max uses
  if (promo.max_uses !== null && promo.used_count >= promo.max_uses) {
    return res.status(400).json({ error: 'This promo code has reached its usage limit' });
  }

  // Check minimum ride amount
  if (rideAmount !== undefined && promo.min_ride_amount > 0 && rideAmount < promo.min_ride_amount) {
    return res.status(400).json({ error: `Minimum ride amount of $${promo.min_ride_amount} required` });
  }

  // Check if this user already used the code
  const { data: used } = await supabaseAdmin
    .from('promo_code_uses')
    .select('id')
    .eq('promo_code_id', promo.id)
    .eq('user_id', uid)
    .maybeSingle();
  if (used) return res.status(400).json({ error: 'You have already used this promo code' });

  // Calculate discount
  const amount = rideAmount || 0;
  const discount = promo.discount_type === 'percent'
    ? +(amount * promo.discount_value / 100).toFixed(2)
    : +Math.min(promo.discount_value, amount).toFixed(2);

  res.json({
    valid: true,
    promoId: promo.id,
    code: promo.code,
    description: promo.description,
    discountType: promo.discount_type,
    discountValue: promo.discount_value,
    discountAmount: discount,
    finalAmount: +(amount - discount).toFixed(2),
  });
});

// POST /api/promo/redeem — record redemption after ride created
promoRouter.post('/redeem', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { promoId, rideId, discountApplied } = req.body as {
    promoId?: string; rideId?: string; discountApplied?: number;
  };
  if (!promoId || !discountApplied) return res.status(400).json({ error: 'promoId and discountApplied required' });

  await supabaseAdmin.from('promo_code_uses').insert({
    promo_code_id: promoId,
    user_id: uid,
    ride_id: rideId || null,
    discount_applied: discountApplied,
  }).select().single();

  // Increment used_count atomically via RPC; fallback to direct SQL increment
  const { error: rpcErr } = await supabaseAdmin.rpc('increment_promo_uses', { promo_id: promoId });
  if (rpcErr) {
    // RPC unavailable — fetch current count and increment directly.
    // Use optimistic locking (.eq used_count == current) to prevent a race condition
    // where two concurrent requests both read the same count and both increment to N+1.
    const { data: pc } = await supabaseAdmin.from('promo_codes').select('used_count').eq('id', promoId).maybeSingle();
    const current = (pc as { used_count?: number } | null)?.used_count ?? 0;
    await supabaseAdmin.from('promo_codes')
      .update({ used_count: current + 1 })
      .eq('id', promoId)
      .eq('used_count', current); // optimistic lock: only succeeds if nobody else incremented
  }

  // FIX: res.json was previously inside the if(rpcErr) block — response was never
  // sent when the RPC succeeded, causing the request to hang indefinitely.
  res.json({ success: true });
});

// ── Admin endpoints (admin only) ─────────────────────────────────────────────

// GET /api/promo — list all promo codes (admin)
promoRouter.get('/', requireAdminJWT, async (req: Request, res: Response) => {
  const { data } = await supabaseAdmin.from('promo_codes').select('*').order('created_at', { ascending: false });
  res.json({ codes: data || [] });
});

// POST /api/promo/create — create a promo code (admin)
promoRouter.post('/create', requireAdminJWT, async (req: Request, res: Response) => {
  const { code, description, discountType, discountValue, maxUses, minRideAmount, expiresAt } = req.body;
  if (!code || !discountType || !discountValue) return res.status(400).json({ error: 'code, discountType, discountValue required' });

  const { data, error } = await supabaseAdmin.from('promo_codes').insert({
    code: code.trim().toUpperCase(),
    description,
    discount_type: discountType,
    discount_value: discountValue,
    max_uses: maxUses || null,
    min_ride_amount: minRideAmount || 0,
    expires_at: expiresAt || null,
  }).select().single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ code: data });
});

// DELETE /api/promo/:id — deactivate a promo code (admin)
promoRouter.delete('/:id', requireAdminJWT, async (req: Request, res: Response) => {
  await supabaseAdmin.from('promo_codes').update({ is_active: false }).eq('id', req.params.id);
  res.json({ success: true });
});
