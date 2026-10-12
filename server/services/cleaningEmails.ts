/**
 * Correos al pasajero sobre el cargo de limpieza, junto a los push que ya existen:
 * cuando el chofer lo reporta (en revisión, sin cobrar), cuando se cobra y cuando
 * se rechaza.
 *
 * Nunca lanza: un correo que falla se registra y el flujo del cargo sigue igual.
 * `CLEANING_EMAILS=off` los apaga sin desplegar código.
 */
import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';
import { sendEmail, isEmailConfigured } from './mailer';
import { emailShell, section, row, totalRow, badge, brand, FONT } from './emailLayout';

export type EventoLimpieza = 'submitted' | 'charged' | 'rejected';

export interface DatosCorreoLimpieza {
  amountUsd: number;
  /** Etiqueta del motivo: "Beach sand", "Professional cleaning". */
  label: string;
  rideId: string;
  /** Limpieza profesional: el cargo espera además el recibo de la empresa. */
  awaitingReceipt?: boolean;
}

const SOPORTE = 'support@urbont.com';

function escapar(t: string): string {
  return t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function parrafo(texto: string, margen = '0 0 14px'): string {
  return `<p style="margin:${margen};font-family:${FONT};font-size:14px;line-height:1.6;color:${brand.navyDeep};">${texto}</p>`;
}

export function correoLimpiezaHtml(nombre: string | null, evento: EventoLimpieza, d: DatosCorreoLimpieza): string {
  const saludo = nombre?.trim() ? `Hi ${escapar(nombre.trim())},` : 'Hi,';
  const monto = `$${d.amountUsd.toFixed(2)}`;
  const motivo = d.label.toLowerCase();
  const ref = d.rideId.slice(0, 8).toUpperCase();

  const cuerpo = {
    submitted: `
      ${parrafo(`Your chauffeur reported a <strong>${monto} ${motivo}</strong> charge for your recent trip.`)}
      ${parrafo(d.awaitingReceipt
        ? 'Nothing has been charged. URBONT will review the photos and the professional cleaning receipt before deciding, as described in the cleaning policy you accepted when booking.'
        : 'Nothing has been charged. URBONT will review the photos first, as described in the cleaning policy you accepted when booking.')}
      <div style="margin:4px 0 18px;">${badge('Under review', brand.amber)}</div>`,
    charged: `
      ${parrafo(`After reviewing the photos, URBONT applied the <strong>${motivo}</strong> charge to the card on file.`)}`,
    rejected: `
      ${parrafo(`URBONT reviewed the <strong>${motivo}</strong> charge reported for your trip and <strong>did not apply it</strong>. Nothing was charged to your card.`)}
      <div style="margin:4px 0 18px;">${badge('Not charged', brand.green)}</div>`,
  }[evento];

  const detalle = section(`
    <table width="100%" cellpadding="0" cellspacing="0" border="0">
      ${row('Reason', escapar(d.label))}
      ${row('Trip', ref)}
      ${evento === 'charged' ? totalRow('Charged', monto) : row('Amount', monto)}
    </table>`, '0 30px 0');

  return emailShell({
    eyebrow: 'Cleaning Charge',
    content: `${section(`${parrafo(saludo)}${cuerpo}`)}${detalle}${section(
      parrafo(`Questions? Reply to this email or write to <a href="mailto:${SOPORTE}" style="color:${brand.navyMid};">${SOPORTE}</a>.`, '0 0 6px'),
      '18px 30px 0',
    )}`,
    footerNote: `Trip ${ref}`,
  });
}

const ASUNTO: Record<EventoLimpieza, (d: DatosCorreoLimpieza) => string> = {
  submitted: d => `A $${d.amountUsd.toFixed(2)} cleaning charge was reported for your trip`,
  charged:   d => `Cleaning charge applied — $${d.amountUsd.toFixed(2)}`,
  rejected:  () => 'The cleaning charge for your trip was not applied',
};

export function correosLimpiezaActivos(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.CLEANING_EMAILS ?? '').trim().toLowerCase() !== 'off';
}

/** Envía el correo si el pasajero tiene uno. Nunca lanza. */
export async function correoLimpiezaPasajero(passengerId: string, evento: EventoLimpieza, d: DatosCorreoLimpieza): Promise<void> {
  if (!correosLimpiezaActivos() || !isEmailConfigured()) return;
  try {
    const { data: perfil } = await supabaseAdmin.from('profiles')
      .select('email, first_name').eq('id', passengerId).maybeSingle();
    const email = String((perfil as { email?: string | null } | null)?.email ?? '').trim();
    // Casi todos los pasajeros entran por teléfono: sin correo, solo queda el push.
    if (!email) return;
    const ok = await sendEmail({
      to: email,
      subject: ASUNTO[evento](d),
      html: correoLimpiezaHtml((perfil as { first_name?: string | null }).first_name ?? null, evento, d),
      category: 'ride_receipt',
    });
    if (!ok) logger.warn(`[LIMPIEZA] Correo '${evento}' no enviado al pasajero ${passengerId}`);
  } catch (err) {
    logger.warn(`[LIMPIEZA] Correo '${evento}' falló para ${passengerId}: ${(err as Error)?.message}`);
  }
}
