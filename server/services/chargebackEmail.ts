/**
 * Aviso al equipo cuando un pasajero disputa un cobro.
 *
 * Un contracargo tiene plazo: si nadie responde a Stripe antes de la fecha
 * límite, se pierde por incomparecencia aunque el viaje se haya prestado. Antes
 * no se escuchaba el evento siquiera, así que el único aviso era entrar al
 * panel de Stripe por casualidad.
 *
 * No toca el dinero del chofer: eso lo decide una persona.
 *
 * Nunca lanza, y `CHARGEBACK_ALERTS=off` lo apaga sin desplegar código.
 */
import { logger } from '../lib/logger';
import { sendEmail, isEmailConfigured } from './mailer';
import { emailShell, section, row, totalRow, badge, brand, FONT } from './emailLayout';
import { motivoLegible } from './paymentEvents';

export interface DatosContracargo {
  disputeId: string;
  amountUsd: number;
  motivo: string | null;
  /** El estado tal cual lo manda Stripe: needs_response, won, lost… */
  estado: string;
  rideId: string | null;
  /** Abierto = recién creado; si no, es el cierre. */
  abierto: boolean;
  dueBy: Date | null;
}

export function avisosContracargoActivos(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.CHARGEBACK_ALERTS ?? '').trim().toLowerCase() !== 'off';
}

function escapar(t: string): string {
  return t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Cómo se lee el desenlace de una disputa cerrada. */
const DESENLACE: Record<string, { texto: string; color: string }> = {
  won:            { texto: 'Ganada',             color: brand.green },
  lost:           { texto: 'Perdida',            color: brand.red },
  warning_closed: { texto: 'Aviso cerrado',      color: brand.slate },
};

/** El HTML del aviso. Pura, para poder probarla. */
export function correoContracargoHtml(d: DatosContracargo): string {
  const desenlace = DESENLACE[d.estado];
  const ref = d.rideId ? d.rideId.slice(0, 8).toUpperCase() : null;

  const cabecera = d.abierto
    ? `Un pasajero disputó un cobro. Stripe ya retuvo el importe; si nadie responde con pruebas antes del plazo, se pierde por incomparecencia.`
    : `Se cerró la disputa de un cobro.`;

  const filas = [
    row('Disputa', escapar(d.disputeId)),
    ref ? row('Viaje', ref, { strong: true }) : row('Viaje', 'Sin identificar', { color: brand.amber }),
    d.motivo ? row('Motivo', escapar(motivoLegible(d.motivo) ?? d.motivo)) : '',
    desenlace
      ? `<tr><td style="padding:7px 0;font-family:${FONT};font-size:13px;color:${brand.slate};">Resultado</td>
         <td style="padding:7px 0;text-align:right;">${badge(desenlace.texto, desenlace.color)}</td></tr>`
      : '',
    d.abierto && d.dueBy
      ? row('Responder antes de', d.dueBy.toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' }), { strong: true, color: brand.red })
      : '',
  ].filter(Boolean).join('');

  const content = `
    ${section(`
      <p style="margin:0;font-family:${FONT};font-size:14px;line-height:1.6;color:${brand.navyDeep};">
        ${cabecera}
      </p>`)}
    ${section(`
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        ${filas}
        ${totalRow('Importe', `$${d.amountUsd.toFixed(2)}`)}
      </table>`)}
    ${section(`
      <p style="margin:0;font-family:${FONT};font-size:13px;line-height:1.6;color:${brand.slate};">
        ${d.abierto
          ? 'Responde desde el panel de Stripe, en Payments → Disputes. Al chofer no se le ha descontado nada: esa decisión es tuya.'
          : 'No hace falta hacer nada más en Stripe.'}
      </p>`)}
  `;

  return emailShell({
    eyebrow: 'Contracargo',
    subtitle: d.abierto ? 'Requiere respuesta' : 'Disputa cerrada',
    content,
    footerNote: ref ? `Trip ${ref}` : d.disputeId,
  });
}

function asunto(d: DatosContracargo): string {
  if (!d.abierto) {
    const r = DESENLACE[d.estado]?.texto ?? 'cerrada';
    return `Contracargo ${r.toLowerCase()} · $${d.amountUsd.toFixed(2)}`;
  }
  return `Contracargo de $${d.amountUsd.toFixed(2)}${d.rideId ? ` · viaje ${d.rideId.slice(0, 8).toUpperCase()}` : ''}`;
}

/**
 * Manda el aviso. Nunca lanza: un correo que falla no puede devolver un 500 al
 * webhook, porque Stripe reintentaría el evento entero.
 */
export async function avisarContracargo(d: DatosContracargo): Promise<void> {
  try {
    if (!avisosContracargoActivos()) return;

    const destino = process.env.ADMIN_EMAIL;
    if (!destino) {
      logger.warn(`[CHARGEBACK] ADMIN_EMAIL no está configurado — aviso de ${d.disputeId} no enviado`);
      return;
    }
    if (!isEmailConfigured()) {
      logger.warn(`[CHARGEBACK] sin proveedor de correo — aviso de ${d.disputeId} no enviado`);
      return;
    }

    await sendEmail({
      to: destino,
      subject: asunto(d),
      html: correoContracargoHtml(d),
      category: 'support_ticket',
    });
  } catch (err) {
    logger.error(`[CHARGEBACK] no se pudo avisar de ${d.disputeId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
