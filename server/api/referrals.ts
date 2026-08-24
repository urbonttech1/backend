import { Router } from 'express';
import { supabaseAdmin } from '../db/client';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export const referralRouter = Router();

referralRouter.get('/', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  const token = authHeader.split(' ')[1];

  try {
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

    const [
      { data: profile, error: profileError },
      { data: referrals, error: referralsError },
      { data: stats, error: statsError },
    ] = await Promise.all([
      supabaseAdmin.from('profiles').select('referral_code').eq('id', user.id).single(),
      supabaseAdmin.from('referrals').select('id, name, status, created_at').eq('referrer_id', user.id),
      supabaseAdmin.from('referrals').select('status, reward_amount').eq('referrer_id', user.id),
    ]);

    if (profileError || referralsError || statsError) {
      return res.status(500).json({ error: 'Failed to fetch referral data' });
    }

    const invited = stats?.length || 0;
    const completed = stats?.filter(r => r.status === 'Completed').length || 0;
    const earned = stats?.reduce((acc, r) => acc + (r.reward_amount || 0), 0) || 0;

    return res.json({
      code: profile?.referral_code || 'N/A',
      referrals: referrals?.map(r => ({
        id: r.id,
        name: r.name,
        status: r.status,
        date: new Date(r.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      })) || [],
      stats: { invited, completed, earned }
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to fetch referral data' });
  }
});
