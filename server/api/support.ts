import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { requireSupabaseAuth } from '../middleware';
import { supabaseAdmin } from '../db/client';
import { createContextLogger } from '../lib/logger';
import { normalizarTicket, normalizarPqrs, ETIQUETA_CATEGORIA, type PqrsNormalizada } from '../services/supportTicket';
import { sendEmail, isEmailConfigured } from '../services/mailer';
import { emailShell, section, row, badge, brand, FONT } from '../services/emailLayout';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

const log = createContextLogger('SUPPORT');
export const supportRouter = Router();


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

  const categoryLabel: Record<string, string> = ETIQUETA_CATEGORIA;

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

/**
 * Registra el SOS como incidente crítico: es lo que ve operaciones en la
 * pantalla de Incidentes del panel, que ordena por severidad. Nunca lanza, para
 * que un fallo aquí no impida guardar el ticket ni enviar el aviso.
 */
async function registrarIncidenteSOS(d: {
  userId: string;
  role?: string;
  userName: string;
  rideId: string | null;
  description: string;
}): Promise<void> {
  try {
    let viajeExiste = false;
    let driverId: string | null = null;
    let passengerId: string | null = null;
    if (d.rideId) {
      const { data: ride } = await supabaseAdmin
        .from('rides').select('driver_id, passenger_id').eq('id', d.rideId).maybeSingle();
      const r = ride as { driver_id?: string | null; passenger_id?: string | null } | null;
      viajeExiste = !!r;
      driverId = r?.driver_id ?? null;
      passengerId = r?.passenger_id ?? null;
    }
    const esConductor = d.role === 'chauffeur' || d.role === 'driver';
    if (esConductor && !driverId) driverId = d.userId;
    if (!esConductor && !passengerId) passengerId = d.userId;

    const { error } = await supabaseAdmin.from('incidents').insert({
      ride_id:        viajeExiste ? d.rideId : null,
      driver_id:      driverId,
      passenger_id:   passengerId,
      reported_by_id: d.userId,
      reporter_role:  esConductor ? 'driver' : 'passenger',
      reporter_name:  d.userName,
      incid_type:     'sos',
      severity:       'critical',
      incid_status:   'open',
      description:    d.description,
    });
    if (error) log.error({ err: error.message, userId: d.userId }, 'SOS: incident not saved');
    else log.warn({ userId: d.userId, rideId: d.rideId }, 'SOS registered as critical incident');
  } catch (err: unknown) {
    log.error({ err: errMsg(err), userId: d.userId }, 'SOS: incident failed');
  }
}

// ─── PQRS desde la web ───────────────────────────────────────────────────────
// Público, sin sesión: límite por IP y un campo trampa (`website`) que una
// persona no ve y un bot rellena.

const pqrsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.', errorCode: 'RATE_LIMITED' },
});

/** Número corto para que el remitente cite su solicitud. */
function radicado(id: string): string {
  return `PQRS-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

async function confirmarPqrs(p: PqrsNormalizada, numero: string): Promise<void> {
  if (!isEmailConfigured()) return;
  const tipo = ETIQUETA_CATEGORIA[p.category].replace('PQRS · ', '');
  const html = emailShell({
    eyebrow: 'PQRS',
    subtitle: numero,
    content: section(`
      <p style="margin:0 0 14px;font-family:${FONT};font-size:14px;line-height:1.6;color:${brand.navyDeep};">Hola ${escaparHtml(p.name)},</p>
      <p style="margin:0 0 14px;font-family:${FONT};font-size:14px;line-height:1.6;color:${brand.navyDeep};">
        Recibimos tu <strong>${tipo.toLowerCase()}</strong> con el número <strong>${numero}</strong>.
        Nuestro equipo la revisará y te responderá a este correo.</p>
      <div style="margin:4px 0 18px;padding:14px 16px;background:${brand.panel};border-radius:12px;border:1px solid ${brand.line};
        font-family:${FONT};font-size:13px;line-height:1.55;color:${brand.navyDeep};white-space:pre-wrap;">${escaparHtml(p.description)}</div>
      <p style="margin:0;font-family:${FONT};font-size:13px;color:${brand.slate};">Conserva este número para cualquier seguimiento.</p>
    `),
    footerNote: 'Este mensaje se envió porque registraste una PQRS en urbont.com.',
  });
  await sendEmail({ to: p.email, subject: `Recibimos tu ${tipo.toLowerCase()} — ${numero}`, html, category: 'support_ticket' });
}

function escaparHtml(t: string): string {
  return t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

supportRouter.post('/pqrs', pqrsLimiter, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.website === 'string' && body.website.trim()) {
    // Bot: se le responde como si hubiera salido bien, sin guardar nada.
    return res.status(201).json({ success: true, ticketId: null, number: null });
  }
  const r = normalizarPqrs(body);
  if ('errorCode' in r) return res.status(400).json({ error: r.error, errorCode: r.errorCode, field: r.field });
  const p = r.pqrs;

  try {
    const ahora = new Date().toISOString();
    const fila: Record<string, unknown> = {
      user_id: null, category: p.category, subject: p.subject, description: p.description,
      priority: p.priority, status: 'open', user_type: 'web',
      user_name: p.name, user_phone: p.phone, user_email: p.email,
      created_at: ahora, updated_at: ahora,
    };
    const insertar = (datos: Record<string, unknown>) =>
      supabaseAdmin.from('support_tickets').insert(datos).select('id').single();

    let resp = await insertar(fila);
    // Si PostgREST aún no ve `user_email`, el correo va en la descripción: el
    // equipo tiene que poder responder igual.
    if (resp.error && /user_email/.test(resp.error.message)) {
      const { user_email: _omit, ...sinEmail } = fila;
      resp = await insertar({ ...sinEmail, description: `${p.description}\n\n— Contacto: ${p.email}` });
    }
    if (resp.error || !resp.data) throw resp.error ?? new Error('insert returned no row');

    const id = (resp.data as { id: string }).id;
    const numero = radicado(id);

    sendAdminEmail({
      id, category: p.category, subject: `${numero} · ${escaparHtml(p.subject)}`,
      description: `${p.description}\n\nContacto: ${p.name} · ${p.email}${p.phone ? ` · ${p.phone}` : ''}`,
      priority: p.priority, userName: escaparHtml(p.name), userPhone: p.phone || 'N/A',
    }).catch(err => log.warn({ err: err.message }, 'PQRS admin email failed'));
    confirmarPqrs(p, numero).catch(err => log.warn({ err: errMsg(err) }, 'PQRS confirmation email failed'));

    res.status(201).json({ success: true, ticketId: id, number: numero });
  } catch (err: unknown) {
    log.error({ err: errMsg(err) }, 'create PQRS error');
    res.status(500).json({ error: 'We could not submit your request. Please try again.', errorCode: 'PQRS_NOT_SAVED' });
  }
});

// POST /api/support/tickets — submit a new ticket
//
// Acepta el formato de todas las pantallas de la app (ver services/supportTicket.ts)
// y responde los errores con `errorCode`, para que la app distinga un fallo de un
// éxito.
supportRouter.post(
  '/tickets',
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    const user_id = req.supabaseUid!;
    const resultado = normalizarTicket((req.body ?? {}) as Record<string, unknown>);
    // `in` y no `!resultado.ok`: sin modo estricto, TypeScript no distingue los
    // casos por un literal booleano.
    if ('errorCode' in resultado) {
      return res.status(400).json({ error: resultado.error, errorCode: resultado.errorCode, field: resultado.field });
    }
    const { category, subject, description, rideId, priority, esSOS } = resultado.ticket;

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

      // El SOS se registra como incidente ANTES que el ticket: una emergencia no
      // puede depender de que el ticket se guarde bien.
      if (esSOS) {
        await registrarIncidenteSOS({ userId: user_id, role: req.supabaseRole, userName, rideId, description });
      }

      const ahora = new Date().toISOString();
      const fila = {
        user_id, category, subject, description,
        ride_id: rideId, priority, status: 'open',
        // Quién lo envió, para el panel de soporte.
        user_type: req.supabaseRole === 'chauffeur' || req.supabaseRole === 'driver'
          ? 'driver'
          : req.supabaseRole === 'passenger' || !req.supabaseRole ? 'passenger' : 'other',
        user_name: userName,
        user_phone: p?.phone || null,
        created_at: ahora, updated_at: ahora,
      };
      const insertar = (datos: Record<string, unknown>) =>
        supabaseAdmin.from('support_tickets').insert(datos).select('id, status, created_at').single();

      let resp = await insertar(fila);
      // Un viaje que no existe no debe tumbar el ticket, y menos un SOS: se
      // guarda sin viaje (si venía en el texto, sigue en la descripción).
      if (resp.error?.code === '23503' && rideId) {
        log.warn({ user_id, rideId }, 'ticket ride not found — saving without ride');
        resp = await insertar({ ...fila, ride_id: null });
      }
      if (resp.error || !resp.data) throw resp.error ?? new Error('insert returned no row');

      const t = resp.data as { id: string; status: string | null; created_at: string | null };

      // Fire-and-forget admin email
      sendAdminEmail({
        id: t.id,
        category,
        subject,
        description,
        priority,
        ride_id: rideId,
        userName,
        userPhone,
      }).catch(err => log.warn({ err: err.message }, 'Admin email failed'));

      res.status(201).json({
        success: true,
        ticket_id: t.id, // nombre anterior; la app lo sigue leyendo
        ticketId: t.id,
        status: t.status ?? 'open',
        createdAt: t.created_at ?? ahora,
        message: 'Your support request has been received. Our team will review it shortly.',
      });
    } catch (err: unknown) {
      log.error({ err: errMsg(err), user_id }, 'create ticket error');
      res.status(500).json({
        error: 'Failed to submit support request. Please try again.',
        errorCode: 'TICKET_NOT_SAVED',
      });
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
