import { Router, Request, Response } from 'express';
import { createContextLogger } from '../../lib/logger';
import { randomInt, createHmac } from 'crypto';
import jwt from 'jsonwebtoken';
import { otpRateLimiter, recordOtpFailure, validateBody, sanitizeBody } from '../../middleware';
import { getOrCreateSupabaseUser, getOrCreateSupabaseUserByEmail, createSupabaseSession, supabaseAdmin } from '../../db/client';
import { sendSmsTwilio, isTwilioConfigured } from '../../services/twilio';
import { verifyFirebasePhoneToken } from '../../services/firebasePhoneAuth';
import { getAccountStatus } from '../../services/accountSecurity';
import { jwtSecret } from '../../db/client';
import { getUserDoc } from '../../db/helpers';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
  const log = createContextLogger('OTP');

  export const otpRouter = Router();

  // ── Developer bypass phone (skips Twilio, accepts fixed code 000000, supports role switching) ──
  const DEV_PHONE = '+584245661220';

  // ── In-memory fallback store (cleared on restart) ─────────────────────────────
  const otpStore = new Map<string, { code: string; expiresAt: number; attempts: number }>();

  function generateCode(): string {
    return randomInt(100000, 1000000).toString();
  }

  function cleanupExpired() {
    const now = Date.now();
    for (const [key, val] of otpStore.entries()) {
      if (now > val.expiresAt) otpStore.delete(key);
    }
  }
  setInterval(cleanupExpired, 5 * 60 * 1000);

  // ── Stateless OTP token helpers ───────────────────────────────────────────────
  function signOtpToken(key: string, code: string, ttlMs = 10 * 60 * 1000): string {
    const codeHash = createHmac('sha256', jwtSecret).update(`${key}:${code}`).digest('hex');
    return jwt.sign({ key, codeHash, type: 'otp' }, jwtSecret, { expiresIn: Math.floor(ttlMs / 1000) });
  }

  function verifyOtpToken(token: string, key: string, code: string): boolean {
    try {
      const payload = jwt.verify(token, jwtSecret) as { key: string; codeHash: string; type: string };
      if (payload.type !== 'otp' || payload.key !== key) return false;
      const expected = createHmac('sha256', jwtSecret).update(`${key}:${code}`).digest('hex');
      return payload.codeHash === expected;
    } catch {
      return false;
    }
  }

  // ─── Check if phone is registered ─────────────────────────────────────────────
  otpRouter.post('/check', sanitizeBody, otpRateLimiter, validateBody(['phone']), async (req: Request, res: Response) => {
    const { phone } = req.body as { phone: string };
    const phoneRegex = /^\+[1-9]\d{6,14}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({ error: 'Invalid phone number format.' });
    }
    try {
      const { data: existingUser } = await supabaseAdmin
        .from('profiles')
        .select('id, phone, role')
        .eq('phone', phone)
        .maybeSingle();
      return res.json({ exists: !!existingUser });
    } catch (err) {
      log.error(`[OTP] Check failed for ${phone}: ${errMsg(err)}`);
      return res.status(500).json({ error: 'Failed to check registration status.' });
    }
  });

  // ─── Send OTP via WhatsApp (sent.dm) or SMS (Twilio) ──────────────────────────
  otpRouter.post('/send', sanitizeBody, otpRateLimiter, validateBody(['phone']), async (req: Request, res: Response) => {
    const { phone } = req.body as { phone: string };
    const phoneRegex = /^\+[1-9]\d{6,14}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({ error: 'Invalid phone number. Use international format (e.g. +12125551234).' });
    }

    const code = generateCode();
    const otpToken = signOtpToken(phone, code);
    otpStore.set(phone, { code, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });

    // ── Developer bypass: skip all SMS providers, return code directly ─────────────
    if (phone === DEV_PHONE) {
      log.info(`[OTP] DEV BYPASS: returning code directly for dev phone ${phone}`);
      return res.json({ success: true, otpToken, devCode: code });
    }

    // ── Twilio SMS (primary) ────────────────────────────────────────────────────────
      if (isTwilioConfigured()) {
        try {
          await sendSmsTwilio(phone, `Your URBONT verification code is: ${code}. Valid for 10 minutes. Do not share this code.`);
          log.info(`[OTP] SMS sent via Twilio to ${phone}`);
          return res.json({ success: true, otpToken });
        } catch (twilioErr) {
          log.error(`[OTP] Twilio send ERROR for ${phone}: ${errMsg(twilioErr)}`);
          // Map Twilio error codes to user-friendly 400 responses (don't fall to 503)
          const codeMatch = errMsg(twilioErr).match(/Twilio error (\d+)/);
          const twilioCode = codeMatch ? parseInt(codeMatch[1], 10) : 0;
          // Invalid / unreachable number codes → return 400 immediately
          const INVALID_NUM_CODES = [21211, 21217, 21614, 21612, 21215, 21408, 60200, 21610, 21616];
          if (INVALID_NUM_CODES.includes(twilioCode)) {
            return res.status(400).json({
              error: 'The phone number you entered is not valid or cannot receive SMS. Please verify the number and country code.'
            });
          }
        }
      }

      // ── No SMS provider available ─────────────────────────────────────────────
      const isProduction = process.env.NODE_ENV === 'production';
      if (isProduction) {
        log.error(`[OTP] No SMS provider available for ${phone} — sent.dm and Twilio both failed or unconfigured`);
        return res.status(503).json({ error: 'SMS service temporarily unavailable. Please use email verification or contact support.' });
      }
      log.warn(`[OTP] DEV: No SMS provider configured — returning devCode for ${phone}`);
      return res.json({ success: true, otpToken, devCode: code });
  });

  // ─── Send OTP via email ────────────────────────────────────────────────────────
  otpRouter.post('/email/send', sanitizeBody, otpRateLimiter, validateBody(['email']), async (req: Request, res: Response) => {
    const { email } = req.body as { email: string };
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    const emailKey = `email:${email.toLowerCase()}`;
    const smtpHost = process.env.SMTP_HOST;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpPort = parseInt(process.env.SMTP_PORT || '587');

    if (!smtpHost || !smtpUser || !smtpPass) {
      log.error('[OTP EMAIL] SMTP env vars missing — SMTP_HOST, SMTP_USER, SMTP_PASS required');
      return res.status(503).json({ error: 'Email service not configured. Contact support.' });
    }

    const code = generateCode();
    const otpToken = signOtpToken(emailKey, code);
    otpStore.set(emailKey, { code, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });
    log.info(`[OTP EMAIL] Generated code for ${email}`);

    try {
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.default.createTransport({ host: smtpHost, port: smtpPort, auth: { user: smtpUser, pass: smtpPass } });
      await transporter.sendMail({
        from: `URBONT <${smtpUser}>`,
        to: email,
        subject: `Your URBONT verification code: ${code}`,
        html: `
          <div style="font-family:sans-serif;max-width:440px;margin:0 auto;color:#001F3F;">
            <div style="background:#001F3F;padding:24px;border-radius:12px 12px 0 0;text-align:center;">
              <h1 style="color:#D4A055;margin:0;font-size:24px;letter-spacing:4px;">URBONT</h1>
              <p style="color:#fff;margin:6px 0 0;opacity:0.6;font-size:12px;">Premium Chauffeur Service</p>
            </div>
            <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;text-align:center;">
              <p style="font-size:15px;color:#374151;margin:0 0 20px;">Your verification code is:</p>
              <div style="font-size:44px;font-weight:800;letter-spacing:14px;color:#001F3F;margin:0 0 20px;padding:16px;background:#f9fafb;border-radius:8px;">${code}</div>
              <p style="font-size:12px;color:#9ca3af;margin:0;">Valid for 10 minutes. Never share this code with anyone.</p>
            </div>
          </div>
        `,
      });
      log.info(`[OTP EMAIL] Code sent to ${email}`);
      return res.json({ success: true, otpToken });
    } catch (err: unknown) {
      log.error({ email, err: errMsg(err) }, '[OTP EMAIL] Send FAILED');
      return res.status(503).json({ error: 'Failed to send verification email. Please try again.' });
    }
  });

  // ─── Verify email OTP ──────────────────────────────────────────────────────────
  otpRouter.post('/email/verify', sanitizeBody, otpRateLimiter, validateBody(['email', 'code']), async (req: Request, res: Response) => {
    const { email, code, otpToken } = req.body as { email: string; code: string; otpToken?: string };
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    const codeStr = String(code).trim();
    if (!/^\d{6}$/.test(codeStr)) {
      return res.status(400).json({ error: 'Invalid code format.' });
    }

    const emailKey = `email:${email.toLowerCase()}`;
    let verified = false;

    if (otpToken) {
      verified = verifyOtpToken(otpToken, emailKey, codeStr);
      if (!verified) {
        recordOtpFailure(ip);
        return res.status(400).json({ error: 'Incorrect or expired code. Please request a new one.' });
      }
    } else {
      const entry = otpStore.get(emailKey);
      if (!entry) return res.status(400).json({ error: 'Code not found. Please request a new one.' });
      if (Date.now() > entry.expiresAt) {
        otpStore.delete(emailKey);
        return res.status(400).json({ error: 'Code expired. Please request a new one.' });
      }
      entry.attempts += 1;
      if (entry.attempts > 5) {
        otpStore.delete(emailKey);
        recordOtpFailure(ip);
        return res.status(429).json({ error: 'Too many attempts. Please request a new code.' });
      }
      if (entry.code !== codeStr) {
        recordOtpFailure(ip);
        return res.status(400).json({ error: 'Incorrect code. Please try again.' });
      }
      verified = true;
      otpStore.delete(emailKey);
    }

    try {
      const user = await getOrCreateSupabaseUserByEmail(email);
      const accountStatus = await getAccountStatus(user.id);
      if (accountStatus.status === 'banned') {
        return res.status(403).json({ error: 'account_banned', message: 'This account has been permanently deactivated.', reason: accountStatus.reason || 'Terms of service violation.' });
      }
      if (accountStatus.status === 'suspended') {
        return res.status(403).json({ error: 'account_suspended', message: 'This account is temporarily suspended.', reason: accountStatus.reason, suspendedUntil: accountStatus.suspendedUntil });
      }
      const session = await createSupabaseSession(user.id, user.email, user.role);
      log.info(`[OTP EMAIL] Session created for ${email} (user: ${user.id})`);
      const profile = await getUserDoc(user.id).catch(() => null);
      return res.json({
        success: true,
        user_id: user.id,
        profile: profile ? {
          first_name: profile.first_name || null,
          last_name: profile.last_name || null,
          email: profile.email || null,
          phone: profile.phone || null,
          avatar_url: (profile as Record<string,unknown>).avatar_url || null,
          title: (profile as Record<string,unknown>).title || null,
          business_name: (profile as Record<string,unknown>).business_name || null,
          home_address: (profile as Record<string,unknown>).home_address || null,
          work_address: (profile as Record<string,unknown>).work_address || null,
        } : null,
        session: {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          user_id: user.id,
          email: user.email,
          role: user.role,
          account_status: accountStatus.status,
        },
      });
    } catch (err: unknown) {
      log.error({ email, err: errMsg(err) }, '[OTP EMAIL] Session creation failed');
      return res.status(500).json({ error: 'Verified but failed to create session. Please try again.' });
    }
  });

  // ─── Verify phone OTP ──────────────────────────────────────────────────────────
  otpRouter.post('/verify', sanitizeBody, otpRateLimiter, validateBody(['phone', 'code']), async (req: Request, res: Response) => {
    const { phone, code, otpToken, role: requestedRole } = req.body as { phone: string; code: string; otpToken?: string; role?: string };
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const phoneRegex = /^\+[1-9]\d{6,14}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({ error: 'Invalid phone number format.' });
    }

    const codeStr = String(code).trim();
    let verified = false;

    // ── Developer bypass: fixed code 000000 always accepted for dev phone (non-prod only) ──
    if (process.env.NODE_ENV !== 'production' && phone === DEV_PHONE && codeStr === '000000') {
      verified = true;
      log.info(`[OTP] DEV BYPASS: fixed code accepted for ${phone}`);
    }

    // ── Master bypass code — non-prod only. Never honor BYPASS_CODE/OTP_BYPASS in
    // production, even if the env var is accidentally set there (defense in depth). ──
    const masterBypass = process.env.NODE_ENV !== 'production'
      ? (process.env.BYPASS_CODE || process.env.OTP_BYPASS)
      : undefined;
    if (!verified && masterBypass && codeStr === String(masterBypass).trim()) {
      verified = true;
      log.info(`[OTP] Bypass code accepted for ${phone}`);
    }

    if (!verified && !/^\d{6}$/.test(codeStr)) {
      return res.status(400).json({ error: 'Invalid code format.' });
    }

    if (!verified) {
      if (otpToken) {
        verified = verifyOtpToken(otpToken, phone, codeStr);
        if (!verified) {
          recordOtpFailure(ip);
          return res.status(400).json({ error: 'Incorrect or expired code. Please request a new one.' });
        }
      } else {
        const entry = otpStore.get(phone);
        if (!entry) return res.status(400).json({ error: 'Code not found. Please request a new one.' });
        if (Date.now() > entry.expiresAt) {
          otpStore.delete(phone);
          return res.status(400).json({ error: 'Code expired. Please request a new one.' });
        }
        entry.attempts += 1;
        if (entry.attempts > 5) {
          otpStore.delete(phone);
          recordOtpFailure(ip);
          return res.status(429).json({ error: 'Too many attempts. Please request a new code.' });
        }
        if (entry.code !== codeStr) {
          recordOtpFailure(ip);
          return res.status(400).json({ error: 'Incorrect code. Please try again.' });
        }
        verified = true;
        otpStore.delete(phone);
      }
    }

    try {
      const user = await getOrCreateSupabaseUser(phone);

      // ── Developer role switch: update profile role if requested (non-prod only) ──
      const validRoles = ['passenger', 'chauffeur', 'valet'];
      if (process.env.NODE_ENV !== 'production' && phone === DEV_PHONE && requestedRole && validRoles.includes(requestedRole)) {
        await supabaseAdmin.from('profiles').update({ role: requestedRole }).eq('id', user.id);
        user.role = requestedRole;
        log.info(`[OTP] DEV BYPASS: role switched to '${requestedRole}' for ${phone}`);
      }

      const accountStatus = await getAccountStatus(user.id);
      if (accountStatus.status === 'banned') {
        return res.status(403).json({ error: 'account_banned', message: 'This account has been permanently deactivated.', reason: accountStatus.reason || 'Terms of service violation.' });
      }
      if (accountStatus.status === 'suspended') {
        return res.status(403).json({ error: 'account_suspended', message: 'This account is temporarily suspended.', reason: accountStatus.reason, suspendedUntil: accountStatus.suspendedUntil });
      }
      const session = await createSupabaseSession(user.id, user.phone, user.role);
      log.info(`[OTP] Session created for ${phone} (user: ${user.id}, role: ${user.role})`);
      const profile = await getUserDoc(user.id).catch(() => null);
      return res.json({
        success: true,
        user_id: user.id,
        profile: profile ? {
          first_name: profile.first_name || null,
          last_name: profile.last_name || null,
          email: profile.email || null,
          phone: profile.phone || null,
          avatar_url: (profile as Record<string,unknown>).avatar_url || null,
          title: (profile as Record<string,unknown>).title || null,
          business_name: (profile as Record<string,unknown>).business_name || null,
          home_address: (profile as Record<string,unknown>).home_address || null,
          work_address: (profile as Record<string,unknown>).work_address || null,
        } : null,
        session: {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          user_id: user.id,
          phone: user.phone,
          role: user.role,
          account_status: accountStatus.status,
        },
      });
    } catch (err) {
      log.error({ errMsgStr: errMsg(err), code: (err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined), stack: (err instanceof Error ? err.stack : undefined)?.split('\n')[1] }, `[OTP] Session creation failed for ${phone}`);
      return res.status(500).json({ error: 'Verified but failed to create session. Please try again.' });
    }
  });

// ─── Verify phone via Firebase Phone Authentication ───────────────────────────
// Client calls signInWithPhoneNumber() → user enters code → Firebase returns
// an ID token → client sends it here → server verifies & creates Supabase session.
otpRouter.post('/firebase/verify', sanitizeBody, otpRateLimiter, validateBody(['idToken']), async (req: Request, res: Response) => {
  const { idToken } = req.body as { idToken: string };

  if (!idToken || typeof idToken !== 'string') {
    return res.status(400).json({ error: 'idToken is required.' });
  }

  let phone: string;
  try {
    phone = await verifyFirebasePhoneToken(idToken);
  } catch (err) {
    log.info(`[Firebase Phone Auth] Token verification failed: ${errMsg(err)}`);
    return res.status(401).json({ error: errMsg(err) || 'Firebase token verification failed.' });
  }

  try {
    const user = await getOrCreateSupabaseUser(phone);
    const accountStatus = await getAccountStatus(user.id);

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

    const session = await createSupabaseSession(user.id, user.phone, user.role);
    log.info(`[Firebase Phone Auth] Session created for ${phone.slice(0, 3)}*** (user: ${user.id}, role: ${user.role})`);

    const profile = await getUserDoc(user.id).catch(() => null);

    return res.json({
      success: true,
      user_id: user.id,
      profile: profile ? {
        first_name: profile.first_name || null,
        last_name: profile.last_name || null,
        email: profile.email || null,
        phone: profile.phone || null,
        avatar_url: (profile as Record<string,unknown>).avatar_url || null,
        title: (profile as Record<string,unknown>).title || null,
        business_name: (profile as Record<string,unknown>).business_name || null,
        home_address: (profile as Record<string,unknown>).home_address || null,
        work_address: (profile as Record<string,unknown>).work_address || null,
      } : null,
      session: {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        user_id: user.id,
        phone: user.phone,
        role: user.role,
        account_status: accountStatus.status,
      },
    });
  } catch (err) {
    log.info(`[Firebase Phone Auth] Session creation failed: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Verified but failed to create session. Please try again.' });
  }
});
