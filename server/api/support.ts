import { Router, Request, Response } from 'express';
import { requireSupabaseAuth } from '../middleware';
import { supabaseAdmin } from '../db/client';
import { createContextLogger } from '../lib/logger';
import { z } from 'zod';
import { validate } from '../middleware/validation';
import nodemailer from 'nodemailer';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

const log = createContextLogger('SUPPORT');
export const supportRouter = Router();

const ticketSchema = z.object({
  category: z.enum(['lost_item', 'driver_issue', 'billing', 'app_issue', 'safety', 'other']),
  subject: z.string().min(3, 'Subject must be at least 3 characters').max(150),
  description: z.string().min(10, 'Please provide more detail').max(3000),
  ride_id: z.string().uuid().optional().nullable(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
});

// ── Email helper ──────────────────────────────────────────────────────────────

async function sendAdminEmail(ticket: {
  id: string;
  category: string;
  subject: string;
  description: string;
  priority: string;
  ride_id?: string | null;
  userName: string;
  userPhone: string;
}): Promise<void> {
  const adminEmail  = process.env.ADMIN_EMAIL;
  const smtpHost    = process.env.SMTP_HOST;
  const smtpPort    = parseInt(process.env.SMTP_PORT || '587');
  const smtpUser    = process.env.SMTP_USER;
  const smtpPass    = process.env.SMTP_PASS;

  if (!adminEmail || !smtpHost || !smtpUser || !smtpPass) {
    log.warn({ ticketId: ticket.id }, 'SMTP not configured — admin email skipped');
    return;
  }

  const transporter = nodemailer.createTransport({
    host:   smtpHost,
    port:   smtpPort,
    secure: smtpPort === 465,
    auth:   { user: smtpUser, pass: smtpPass },
  });

  const categoryLabel: Record<string, string> = {
    lost_item:    'Lost Item',
    driver_issue: 'Driver Issue',
    billing:      'Billing',
    app_issue:    'App Issue',
    safety:       'Safety',
    other:        'Other',
  };

  const priorityColors: Record<string, string> = {
    low: '#6B7280', normal: '#3B82F6', high: '#F59E0B', urgent: '#EF4444',
  };

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a1a;">
      <div style="background: #001F3F; padding: 24px; border-radius: 8px 8px 0 0;">
        <h1 style="color: #ffffff; margin: 0; font-size: 20px;">URBONT Support Ticket</h1>
        <p style="color: #94a3b8; margin: 4px 0 0; font-size: 13px;">Ticket #${ticket.id.slice(-8).toUpperCase()}</p>
      </div>
      <div style="background: #f8fafc; padding: 24px; border: 1px solid #e2e8f0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #6B7280; width: 140px; font-size: 13px;">Priority</td>
            <td style="padding: 8px 0;">
              <span style="background: ${priorityColors[ticket.priority]}22; color: ${priorityColors[ticket.priority]}; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; text-transform: uppercase;">${ticket.priority}</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6B7280; font-size: 13px;">Category</td>
            <td style="padding: 8px 0; font-weight: 500;">${categoryLabel[ticket.category] || ticket.category}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #6B7280; font-size: 13px;">User</td>
            <td style="padding: 8px 0;">${ticket.userName} · ${ticket.userPhone}</td>
          </tr>
          ${ticket.ride_id ? `<tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px;">Ride ID</td><td style="padding: 8px 0; font-family: monospace;">${ticket.ride_id}</td></tr>` : ''}
          <tr>
            <td style="padding: 8px 0; color: #6B7280; font-size: 13px;">Subject</td>
            <td style="padding: 8px 0; font-weight: 600;">${ticket.subject}</td>
          </tr>
        </table>
        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 16px 0;" />
        <p style="color: #6B7280; font-size: 12px; margin: 0 0 8px;">Description</p>
        <p style="background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; margin: 0; font-size: 14px; line-height: 1.6; white-space: pre-wrap;">${ticket.description.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
      </div>
      <div style="background: #e2e8f0; padding: 12px 24px; border-radius: 0 0 8px 8px; font-size: 11px; color: #94a3b8;">
        URBONT · ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET
      </div>
    </div>
  `;

  await transporter.sendMail({
    from:    `"URBONT Support" <${smtpUser}>`,
    to:      adminEmail,
    subject: `[${ticket.priority.toUpperCase()}] ${categoryLabel[ticket.category] || ticket.category}: ${ticket.subject}`,
    html,
  });
}

// POST /api/support/tickets — submit a new ticket
supportRouter.post(
  '/tickets',
  requireSupabaseAuth,
  validate(ticketSchema),
  async (req: Request, res: Response) => {
    const user_id = req.supabaseUid!;
    const { category, subject, description, ride_id, priority } = req.body;

    try {
      // Get user profile for email context
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('first_name, last_name, phone')
        .eq('id', user_id)
        .maybeSingle();

      const p = profile as { first_name?: string; last_name?: string; phone?: string } | null;
      const userName  = p ? `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'User' : 'User';
      const userPhone = p?.phone || 'N/A';

      const { data: ticket, error } = await supabaseAdmin
        .from('support_tickets')
        .insert({
          user_id,
          category,
          subject,
          description,
          ride_id: ride_id || null,
          priority,
          status: 'open',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (error) throw error;

      // Fire-and-forget admin email
      sendAdminEmail({
        id: (ticket as Record<string,unknown>).id as string,
        category,
        subject,
        description,
        priority,
        ride_id,
        userName,
        userPhone,
      }).catch(err => log.warn({ err: err.message }, 'Admin email failed'));

      res.status(201).json({
        success: true,
        ticket_id: (ticket as Record<string,unknown>).id,
        message: 'Your support request has been received. Our team will review it shortly.',
      });
    } catch (err: any) {
      log.error({ err: err.message, user_id }, 'create ticket error');
      res.status(500).json({ error: 'Failed to submit support request. Please try again.' });
    }
  },
);

// GET /api/support/tickets — fetch own tickets
supportRouter.get(
  '/tickets',
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    const user_id = req.supabaseUid!;
    try {
      const { data, error } = await supabaseAdmin
        .from('support_tickets')
        .select('id, category, subject, status, priority, created_at, updated_at')
        .eq('user_id', user_id)
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) throw error;
      res.json(data ?? []);
    } catch (err: any) {
      log.error({ err: err.message, user_id }, 'get tickets error');
      res.status(500).json({ error: 'Unable to fetch your support history. Please try again.' });
    }
  },
);

// GET /api/support/tickets/:id — get single ticket detail
supportRouter.get(
  '/tickets/:id',
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    const user_id = req.supabaseUid!;
    try {
      const { data, error } = await supabaseAdmin
        .from('support_tickets')
        .select('*')
        .eq('id', req.params.id)
        .eq('user_id', user_id)
        .maybeSingle();

      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Ticket not found.' });
      res.json(data);
    } catch (err: any) {
      log.error({ err: err.message, user_id }, 'get ticket error');
      res.status(500).json({ error: 'Unable to load ticket details. Please try again.' });
    }
  },
);
