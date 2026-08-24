import { logger } from '../lib/logger';
// ── Twilio SMS sender (native fetch — no SDK dependency) ─────────────────────
// Uses the Twilio Messages REST API directly.
// Required env vars:
//   TWILIO_ACCOUNT_SID   — your Twilio Account SID (AC...)
//   TWILIO_AUTH_TOKEN    — your Twilio Auth Token
//   TWILIO_PHONE_NUMBER  — your Twilio number in E.164 format (+1XXXXXXXXXX)

export function isTwilioConfigured(): boolean {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_PHONE_NUMBER
  );
}

export async function sendSmsTwilio(to: string, body: string): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !from) {
    throw new Error('Twilio credentials not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER).');
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const params = new URLSearchParams({ To: to, From: from, Body: body });

  logger.info({ to, from }, '[Twilio] Sending SMS');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const data = await res.json() as { sid?: string; error_code?: number; message?: string };

  if (!res.ok) {
    const msg = data.message || `HTTP ${res.status}`;
    logger.error({ errorCode: data.error_code || res.status, msg }, '[Twilio] Error');
    throw new Error(`Twilio error ${data.error_code || res.status}: ${msg}`);
  }

  logger.info({ sid: data.sid }, '[Twilio] SMS sent');
}
