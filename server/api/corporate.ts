import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { requireSupabaseAuth } from '../middleware';
import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

let _corpStripe: Stripe | null = null;
function getStripe(): Stripe | null {
  if (_corpStripe) return _corpStripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    logger.warn('[CORPORATE] STRIPE_SECRET_KEY is not set — corporate billing will not work.');
    return null;
  }
  _corpStripe = new Stripe(key);
  return _corpStripe;
}

export const corporateRouter = Router();

// POST /api/corporate — create a corporate account
corporateRouter.post('/', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { companyName, billingEmail, monthlyLimit } = req.body as {
    companyName?: string; billingEmail?: string; monthlyLimit?: number;
  };
  if (!companyName || !billingEmail) return res.status(400).json({ error: 'companyName and billingEmail are required' });

  // Check if user already belongs to a corporate account
  const { data: existing } = await supabaseAdmin
    .from('corporate_members')
    .select('id')
    .eq('user_id', uid)
    .maybeSingle();
  if (existing) return res.status(400).json({ error: 'You are already a member of a corporate account' });

  try {
    // Create Stripe customer for corporate billing
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Payment processing is not configured on this server.' });
    const customer = await stripe.customers.create({
      name: companyName,
      email: billingEmail,
      metadata: { created_by: uid, type: 'corporate' },
    });

    const { data: account, error } = await supabaseAdmin
      .from('corporate_accounts')
      .insert({
        company_name: companyName,
        billing_email: billingEmail,
        stripe_customer_id: customer.id,
        monthly_limit: monthlyLimit || null,
        created_by: uid,
      })
      .select()
      .single();

    if (error) throw error;

    // Add creator as admin member
    await supabaseAdmin.from('corporate_members').insert({
      corporate_account_id: account.id,
      user_id: uid,
      role: 'admin',
    });

    // Link account to user profile
    await supabaseAdmin.from('profiles').update({ corporate_acct_id: account.id }).eq('id', uid);

    res.json({ account, stripeCustomerId: customer.id });
  } catch (err: any) {
    logger.error(`[CORPORATE] Create error: ${err.message}`);
    res.status(500).json({ error: 'Failed to create corporate account' });
  }
});

// GET /api/corporate/me — get current user's corporate account
corporateRouter.get('/me', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;

  const { data: membership } = await supabaseAdmin
    .from('corporate_members')
    .select('role, corporate_account_id, corporate_accounts(*)')
    .eq('user_id', uid)
    .eq('is_active', true)
    .maybeSingle();

  if (!membership) return res.json({ account: null });

  // Get members
  const { data: members } = await supabaseAdmin
    .from('corporate_members')
    .select('id, role, joined_at, is_active, profiles(id, first_name, last_name, email, avatar_url)')
    .eq('corporate_account_id', membership.corporate_account_id);

  // Get this month's rides
  const firstOfMonth = new Date();
  firstOfMonth.setDate(1); firstOfMonth.setHours(0, 0, 0, 0);

  const { data: rides } = await supabaseAdmin
    .from('rides')
    .select('fare, tip_amount, created_at')
    .eq('corporate_acct_id', membership.corporate_account_id)
    .gte('created_at', firstOfMonth.toISOString())
    .eq('ride_status', 'completed');

  const monthSpend = (rides || []).reduce((sum, r) => sum + (r.fare || 0) + (r.tip_amount || 0), 0);

  res.json({
    account: (membership as Record<string,unknown>).corporate_accounts,
    myRole: membership.role,
    members: members || [],
    monthSpend,
  });
});

// POST /api/corporate/invite — add member by email
corporateRouter.post('/invite', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { email } = req.body as { email?: string };
  if (!email) return res.status(400).json({ error: 'email is required' });

  // Verify requester is admin
  const { data: myMembership } = await supabaseAdmin
    .from('corporate_members')
    .select('role, corporate_account_id')
    .eq('user_id', uid)
    .eq('role', 'admin')
    .eq('is_active', true)
    .maybeSingle();

  if (!myMembership) return res.status(403).json({ error: 'Only corporate admins can invite members' });

  // Find user by email
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, first_name, last_name')
    .eq('email', email)
    .maybeSingle();

  if (!profile) return res.status(404).json({ error: 'No URBONT account found with that email. Ask them to sign up first.' });

  // Add as member
  const { error } = await supabaseAdmin.from('corporate_members').insert({
    corporate_account_id: myMembership.corporate_account_id,
    user_id: profile.id,
    role: 'member',
  });

  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'This user is already a member' });
    return res.status(500).json({ error: 'Failed to add member' });
  }

  await supabaseAdmin.from('profiles').update({ corporate_acct_id: myMembership.corporate_account_id }).eq('id', profile.id);

  res.json({ success: true, addedUser: profile });
});

// DELETE /api/corporate/members/:userId — remove member
corporateRouter.delete('/members/:userId', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;

  const { data: myMembership } = await supabaseAdmin
    .from('corporate_members')
    .select('role, corporate_account_id')
    .eq('user_id', uid)
    .eq('role', 'admin')
    .eq('is_active', true)
    .maybeSingle();

  if (!myMembership) return res.status(403).json({ error: 'Admin only' });

  await supabaseAdmin
    .from('corporate_members')
    .update({ is_active: false })
    .eq('user_id', req.params.userId)
    .eq('corporate_account_id', myMembership.corporate_account_id);

  await supabaseAdmin.from('profiles').update({ corporate_acct_id: null }).eq('id', req.params.userId);

  res.json({ success: true });
});

// GET /api/corporate/rides — corporate ride history
corporateRouter.get('/rides', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;

  const { data: membership } = await supabaseAdmin
    .from('corporate_members')
    .select('corporate_account_id, role')
    .eq('user_id', uid)
    .eq('is_active', true)
    .maybeSingle();

  if (!membership) return res.status(403).json({ error: 'Not a corporate member' });

  const { data: rides } = await supabaseAdmin
    .from('rides')
    .select('id, pickup, dropoff, fare, tip_amount, vehicle_type, ride_status, created_at, passenger_id, profiles!rides_passenger_id_fkey(first_name, last_name)')
    .eq('corporate_acct_id', membership.corporate_account_id)
    .order('created_at', { ascending: false })
    .limit(100);

  res.json({ rides: rides || [] });
});
