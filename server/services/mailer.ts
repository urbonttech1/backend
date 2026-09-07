// ── Unified email transport ───────────────────────────────────────────────────
// Single entry point for every outgoing email in the API.
//
// Before this module, each of the four send points built its own transport
// inline: receipts went out through Resend while support alerts and login codes
// each created their own nodemailer transporter. That is why the same passenger
// could receive two receipts with different layouts depending on whether it was
// sent automatically or resent from the admin panel.
//
// Providers are tried in order and the first one configured wins:
//   SendGrid → Resend → SMTP
// Adding or swapping a provider now means touching this file only.

import { Resend } from 'resend';
import { createContextLogger } from '../lib/logger';

const log = createContextLogger('MAILER');

const SENDGRID_KEY = process.env.SENDGRID_API_KEY || '';
const RESEND_KEY   = process.env.RESEND_API_KEY   || '';
const SMTP_HOST    = process.env.SMTP_HOST        || '';
const SMTP_USER    = process.env.SMTP_USER        || '';
const SMTP_PASS    = process.env.SMTP_PASS        || '';
const SMTP_PORT    = parseInt(process.env.SMTP_PORT || '587', 10);

const FROM = process.env.EMAIL_FROM || 'URBONT <no-reply@urbont.com>';

export type MailCategory = 'ride_receipt' | 'support_ticket' | 'otp';
export type MailProvider = 'sendgrid' | 'resend' | 'smtp' | 'none';

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  /** Tags the send on the provider side so deliveries can be filtered by type. */
  category?: MailCategory;
  replyTo?: string;
}

/** Which provider will handle the next send. Surfaced by the health checks. */
export function activeProvider(): MailProvider {
  if (SENDGRID_KEY) return 'sendgrid';
  if (RESEND_KEY)   return 'resend';
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) return 'smtp';
  return 'none';
}

export function isEmailConfigured(): boolean {
  return activeProvider() !== 'none';
}

// EMAIL_FROM accepts both "info@urbont.com" and "URBONT <info@urbont.com>".
function parseFrom(value: string): { email: string; name?: string } {
  const m = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { email: m[2].trim(), name: m[1] || undefined };
  return { email: value.trim() };
}

// ── Lazy clients ──────────────────────────────────────────────────────────────
// Built on first use so an unconfigured provider never costs anything.

let sendgridKeySet = false;
async function getSendGrid() {
  const sg = (await import('@sendgrid/mail')).default;
  if (!sendgridKeySet) {
    sg.setApiKey(SENDGRID_KEY);
    sendgridKeySet = true;
  }
  return sg;
}

let resendClient: Resend | null = null;
function getResend(): Resend {
  if (!resendClient) resendClient = new Resend(RESEND_KEY);
  return resendClient;
}

let transporter: { sendMail: (o: Record<string, unknown>) => Promise<unknown> } | null = null;
async function getTransporter() {
  if (!transporter) {
    const nodemailer = await import('nodemailer');
    transporter = nodemailer.default.createTransport({
      host:   SMTP_HOST,
      port:   SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth:   { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

// SendGrid buries the useful part of a failure in response.body.errors.
function errDetail(err: unknown): string {
  const e = err as { response?: { body?: { errors?: Array<{ message?: string }> } }; message?: string };
  const fromBody = e?.response?.body?.errors?.map(x => x.message).filter(Boolean).join('; ');
  return fromBody || e?.message || String(err);
}

/**
 * Sends one email through the first configured provider.
 * Never throws: a failed send must not break the flow that triggered it
 * (a ride still completes, a support ticket is still created).
 */
export async function sendEmail(options: EmailOptions): Promise<boolean> {
  const provider = activeProvider();

  if (provider === 'none') {
    log.warn(
      { to: options.to, category: options.category },
      'No email provider configured — set SENDGRID_API_KEY, RESEND_API_KEY or SMTP_HOST/USER/PASS. Email not sent.',
    );
    return false;
  }

  const from = parseFrom(FROM);

  try {
    if (provider === 'sendgrid') {
      const sg = await getSendGrid();
      await sg.send({
        to:      options.to,
        from:    from.name ? { email: from.email, name: from.name } : from.email,
        subject: options.subject,
        html:    options.html,
        ...(options.replyTo  ? { replyTo: options.replyTo }      : {}),
        ...(options.category ? { categories: [options.category] } : {}),
      });
    } else if (provider === 'resend') {
      await getResend().emails.send({
        from:    FROM,
        to:      options.to,
        subject: options.subject,
        html:    options.html,
        ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      });
    } else {
      const tx = await getTransporter();
      await tx.sendMail({
        from:    from.name ? `${from.name} <${from.email}>` : from.email,
        to:      options.to,
        subject: options.subject,
        html:    options.html,
        ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      });
    }

    log.info({ to: options.to, category: options.category, provider }, 'Email sent');
    return true;
  } catch (err: unknown) {
    log.error(
      { to: options.to, category: options.category, provider, err: errDetail(err) },
      'Email send failed',
    );
    return false;
  }
}
