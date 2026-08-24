import { Router, Request, Response } from 'express';
import { logger } from '../../lib/logger';
import { verifyToken, verifyTokenIgnoreExpiry, issueToken, supabaseAdmin, supabasePublic } from '../../db/client';
import { getAccountStatus } from '../../services/accountSecurity';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export const sessionRouter = Router();

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
sessionRouter.get('/me', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided.' });
  }

  const token = authHeader.slice(7);
  const session = verifyToken(token);
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  try {
    const { data: user } = await supabaseAdmin
      .from('profiles')
      .select('id, phone, email, first_name, last_name, role, membership, avatar_url, account_status, membership_type, total_rides')
      .eq('id', session.user_id)
      .maybeSingle();

    if (!user) return res.status(404).json({ error: 'User not found.' });

    return res.json({
      user_id: user.id,
      phone: user.phone,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role || session.role,
      membership: user.membership || 'free',
      membership_type: user.membership_type || 'standard',
      avatar_url: user.avatar_url,
      total_rides: user.total_rides || 0,
      account_status: user.account_status || 'active',
    });
  } catch (err) {
    logger.error({ userId: session.user_id, err: errMsg(err) }, '[Auth/me] Failed to load user profile');
    return res.status(500).json({ error: 'Failed to load user profile.' });
  }
});

// ─── POST /api/auth/refresh ───────────────────────────────────────────────────
sessionRouter.post('/refresh', async (req: Request, res: Response) => {
  const { refresh_token } = req.body as { refresh_token?: string };
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token is required.' });

  // 1. Try custom JWT first (OTP/phone/chauffeur/valet server-issued tokens)
  const session = verifyTokenIgnoreExpiry(refresh_token);
  if (session) {
    try {
      const { data: user } = await supabaseAdmin
        .from('profiles')
        .select('id, phone, email, role')
        .eq('id', session.user_id)
        .maybeSingle();

      if (!user) return res.status(404).json({ error: 'User not found.' });

      const newToken = issueToken({
        id: user.id as string,
        phone: (user.phone as string) || '',
        role: (user.role as string) || 'passenger',
      });

      return res.json({ access_token: newToken, refresh_token: newToken, user_id: user.id });
    } catch (err) {
      logger.error({ err: errMsg(err) }, '[Auth/refresh] Custom JWT refresh failed');
      return res.status(500).json({ error: 'Failed to refresh token.' });
    }
  }

  // 2. Fallback: try Supabase refresh token (valets/drivers who logged in via Supabase directly)
  try {
    const { data: refreshData, error: refreshError } = await supabasePublic.auth.refreshSession({ refresh_token });
    if (refreshError || !refreshData?.session || !refreshData?.user?.id) {
      return res.status(401).json({ error: 'Invalid or expired refresh token.' });
    }

    const userId = refreshData.user.id;
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, phone, role')
      .eq('id', userId)
      .maybeSingle();

    const newToken = issueToken({
      id: userId,
      phone: (profile?.phone as string) || refreshData.user.email || '',
      role: (profile?.role as string) || 'passenger',
    });

    return res.json({
      access_token: newToken,
      refresh_token: refreshData.session.refresh_token,
      user_id: userId,
    });
  } catch (err) {
    logger.error({ err: errMsg(err) }, '[Auth/refresh] Supabase refresh failed');
    return res.status(401).json({ error: 'Invalid refresh token.' });
  }
});

// ─── POST /api/auth/oauth-web ─────────────────────────────────────────────────
// Called by the website's /auth/callback page after Google OAuth.
// Accepts a Supabase access token, looks up (or creates) the user profile,
// and returns our custom JWT so the website can work like OTP-authenticated users.
sessionRouter.post('/oauth-web', async (req: Request, res: Response) => {
  const { accessToken } = req.body as { accessToken?: string };
  if (!accessToken) {
    return res.status(400).json({ error: 'accessToken is required.' });
  }

  try {
    // Validate the Supabase token
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
    if (userError || !userData?.user) {
      return res.status(401).json({ error: 'Invalid or expired Google session.' });
    }

    const { id: userId, email } = userData.user;

    // Fetch or create profile
    let { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, phone, email, first_name, last_name, role')
      .eq('id', userId)
      .maybeSingle();

    if (!profile) {
      // First-time Google login — create a basic passenger profile
      const now = new Date().toISOString();
      const nameParts = (userData.user.user_metadata?.full_name as string | undefined)?.split(' ') ?? [];
      const firstName = (userData.user.user_metadata?.given_name as string | undefined) || nameParts[0] || null;
      const lastName  = (userData.user.user_metadata?.family_name as string | undefined) || nameParts.slice(1).join(' ') || null;

      const { error: upsertErr } = await supabaseAdmin.from('profiles').upsert({
        id:         userId,
        email:      email || null,
        first_name: firstName,
        last_name:  lastName,
        role:       'passenger',
        membership: 'free',
        status_val: 'offline',
        avatar_url: (userData.user.user_metadata?.avatar_url as string | undefined) || null,
        created_at: now,
        updated_at: now,
      }, { onConflict: 'id', ignoreDuplicates: false });

      if (upsertErr) {
        logger.error({ userId, err: upsertErr.message }, '[Auth/oauth-web] Profile creation failed');
        return res.status(500).json({ error: 'Failed to create user profile. Please try again.' });
      }

      // Re-fetch so we return accurate data
      const { data: newProfile } = await supabaseAdmin
        .from('profiles')
        .select('id, phone, email, first_name, last_name, role')
        .eq('id', userId)
        .maybeSingle();

      if (!newProfile) {
        logger.error({ userId }, '[Auth/oauth-web] Profile not found after creation');
        return res.status(500).json({ error: 'Failed to load user profile. Please try again.' });
      }
      profile = newProfile;
    }

    // Enforce account restrictions — same parity as OTP login path
    const accountStatus = await getAccountStatus(userId);
    if (accountStatus.status === 'banned') {
      return res.status(403).json({
        error: 'account_banned',
        message: 'This account has been permanently deactivated.',
        reason: accountStatus.reason || 'Terms of service violation.',
      });
    }
    if (accountStatus.status === 'suspended') {
      return res.status(403).json({
        error: 'account_suspended',
        message: 'This account is temporarily suspended.',
        reason: accountStatus.reason,
        suspendedUntil: accountStatus.suspendedUntil,
      });
    }

    const role  = (profile?.role as string) || 'passenger';
    const phone = (profile?.phone as string) || email || userId;
    const token = issueToken({ id: userId, phone, role });

    const firstName = profile?.first_name as string | null;
    const lastName  = profile?.last_name  as string | null;
    const name = firstName
      ? `${firstName} ${lastName ?? ''}`.trim()
      : null;

    logger.info({ userId, role }, '[Auth/oauth-web] Google login success');

    return res.json({
      token,
      user: {
        id:    userId,
        phone: (profile?.phone as string) || '',
        email: (profile?.email as string) || email || undefined,
        name,
        role,
      },
    });
  } catch (err) {
    logger.error({ err: errMsg(err) }, '[Auth/oauth-web] Failed');
    return res.status(500).json({ error: 'Authentication failed. Please try again.' });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
sessionRouter.post('/logout', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const session = verifyToken(token);
    if (session) {
      try {
        await supabaseAdmin.from('device_sessions').delete().eq('user_id', session.user_id);
      } catch {
        // Non-critical — continue with logout
      }
    }
  }
  return res.json({ success: true });
});
