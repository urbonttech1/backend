import { Router, Request, Response } from 'express';
import { requireSupabaseAuth } from '../middleware';
import { supabaseAdmin } from '../db/client';
import { createContextLogger } from '../lib/logger';
import { z } from 'zod';
import { validate } from '../middleware/validation';
import { sendEmail, isEmailConfigured } from '../services/mailer';
import { emailShell, section, row, badge, brand, FONT } from '../services/emailLayout';

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

export async function sendAdminEmail(ticket: {
  id: string;
  category: string;
  subject: string;
  description: string;
  priority: string;
  ride_id?: string | null;
  userName: string;
  userPhone: string;
}): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL;

  if (!adminEmail) {
    log.warn({ ticketId: ticket.id }, 'ADMIN_EMAIL not set — admin notification skipped');
    return;
  }
  if (!isEmailConfigured()) {
    log.warn({ ticketId: ticket.id }, 'No email provider configured — admin notification skipped');
    return;
  }

  const categoryLabel: Record<string, string> = {
    lost_item:    'Lost Item',
    driver_issue: 'Driver Issue',
    billing:      'Billing',
    app_issue:    'App Issue',
    safety:       'Safety',
    other:        'Other',
  };

  const priorityColors: Record<string, string> = {
    low: brand.slate, normal: brand.navyMid, high: brand.amber, urgent: brand.red,
  };

  const content = `
    ${section(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding:7px 0;font-family:${FONT};font-size:13px;color:${brand.slate};">Priority</td>
          <td style="padding:7px 0;text-align:right;">${badge(ticket.priority, priorityColors[ticket.priority] || brand.slate)}</td>
        </tr>
        ${row('Category', categoryLabel[ticket.category] || ticket.category, { strong: true })}
        ${row('User', ticket.userName)}
        ${row('Phone', ticket.userPhone)}
        ${ticket.ride_id ? row('Ride ID', ticket.ride_id) : ''}
      </table>`)}

    ${section(`
      <p style="margin:0 0 8px;font-family:${FONT};font-size:11px;font-weight:700;
                letter-spacing:0.08em;text-transform:uppercase;color:${brand.slate};">Subject</p>
      <p style="margin:0 0 18px;font-family:${FONT};font-size:15px;font-weight:600;
                color:${brand.navyDeep};line-height:1.45;">${ticket.subject}</p>

      <p style="margin:0 0 8px;font-family:${FONT};font-size:11px;font-weight:700;
                letter-spacing:0.08em;text-transform:uppercase;color:${brand.slate};">Description</p>
      <div style="background:${brand.panel};border-radius:12px;padding:16px;
                  font-family:${FONT};font-size:14px;color:${brand.navyDeep};
                  line-height:1.6;white-space:pre-wrap;">${ticket.description.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`,
      '20px 30px 4px')}
  `;

  const html = emailShell({
    eyebrow:  'Support Ticket',
    subtitle: `#${ticket.id.slice(-8).toUpperCase()} · ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`,
    content,
    footerNote: 'Reply to this email to reach the user directly.',
  });

  await sendEmail({
    to:       adminEmail,
    subject:  `[${ticket.priority.toUpperCase()}] ${categoryLabel[ticket.category] || ticket.category}: ${ticket.subject}`,
    html,
    category: 'support_ticket',
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
