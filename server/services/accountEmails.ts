/**
 * Correos de estado de cuenta — suspensión y reactivación.
 *
 * Hasta ahora suspender a alguien era silencioso: se actualizaba el perfil y el
 * usuario solo se enteraba al intentar entrar y recibir un 403. El motivo ya
 * viajaba en esa respuesta, así que aquí se reusa el mismo texto.
 */

import { sendEmail } from './mailer';
import { emailShell, section, badge, brand, FONT } from './emailLayout';

export interface AccountEmailTarget {
  email?: string | null;
  name?: string | null;
}

export interface SuspensionData {
  /** Motivo escrito por el admin. */
  reason?: string | null;
  /** Fin de la suspensión en ISO, o null si es indefinida. */
  suspendedUntil?: string | null;
}

const SOPORTE = 'support@urbont.com';

function saludo(name?: string | null): string {
  const limpio = (name || '').trim();
  return limpio ? `Hola ${limpio},` : 'Hola,';
}

function parrafo(texto: string, margen = '0 0 14px'): string {
  return `<p style="margin:${margen};font-family:${FONT};font-size:14px;
    line-height:1.6;color:${brand.navyDeep};">${texto}</p>`;
}

function panel(inner: string): string {
  return `<div style="margin:4px 0 18px;padding:14px 16px;background:${brand.panel};
    border-radius:12px;border:1px solid ${brand.line};">${inner}</div>`;
}

function fechaLegible(iso: string): string {
  return new Date(iso).toLocaleDateString('es-US', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

export function suspensionHtml(target: AccountEmailTarget, data: SuspensionData): string {
  const hasta = data.suspendedUntil
    ? `La suspensión se levanta el <strong>${fechaLegible(data.suspendedUntil)}</strong>.`
    : 'La suspensión permanece vigente hasta que nuestro equipo la revise.';

  return emailShell({
    eyebrow: 'Estado de cuenta',
    content: section(`
      ${parrafo(saludo(target.name))}
      ${parrafo(`Tu cuenta de URBONT ha sido <strong>suspendida</strong> y por ahora
        no podrás iniciar sesión ni usar el servicio.`)}
      ${panel(`
        <p style="margin:0 0 6px;font-family:${FONT};font-size:11px;font-weight:700;
          letter-spacing:0.08em;text-transform:uppercase;color:${brand.slate};">Motivo</p>
        <p style="margin:0;font-family:${FONT};font-size:14px;line-height:1.55;
          color:${brand.navyDeep};">${data.reason || 'No se especificó un motivo.'}</p>
      `)}
      ${parrafo(hasta)}
      ${parrafo(`Si crees que se trata de un error, responde a este correo o escríbenos a
        <a href="mailto:${SOPORTE}" style="color:${brand.navyMid};">${SOPORTE}</a>.`, '0')}
    `),
    footerNote: 'Este mensaje se envió porque el estado de tu cuenta cambió.',
  });
}

export function reactivacionHtml(target: AccountEmailTarget): string {
  return emailShell({
    eyebrow: 'Estado de cuenta',
    content: section(`
      ${parrafo(saludo(target.name))}
      ${parrafo(`Tu cuenta de URBONT vuelve a estar <strong>activa</strong>.
        Ya puedes iniciar sesión y usar el servicio con normalidad.`)}
      <div style="margin:4px 0 18px;">${badge('Cuenta activa', brand.green)}</div>
      ${parrafo(`Gracias por tu paciencia. Si tienes dudas, escríbenos a
        <a href="mailto:${SOPORTE}" style="color:${brand.navyMid};">${SOPORTE}</a>.`, '0')}
    `),
    footerNote: 'Este mensaje se envió porque el estado de tu cuenta cambió.',
  });
}

/** Qué pasó con el aviso, para que el panel pueda decírselo al admin. */
export interface ResultadoAviso {
  /** true = el correo salió. */
  sent: boolean;
  /** Mensaje listo para mostrar en el panel. */
  message: string;
  /** Motivo de que no se enviara, cuando `sent` es false. */
  reason?: 'NO_EMAIL' | 'SEND_FAILED';
}

async function avisar(
  target: AccountEmailTarget,
  subject: string,
  html: string,
): Promise<ResultadoAviso> {
  // Casi todos los pasajeros entran por teléfono y nunca registran un correo.
  // En ese caso no se envía nada y se le dice al admin, en vez de fingir que
  // el aviso salió.
  const destino = (target.email || '').trim();
  if (!destino) {
    return {
      sent: false,
      reason: 'NO_EMAIL',
      message: 'El usuario no tiene correo registrado, no se envió el aviso.',
    };
  }

  const ok = await sendEmail({ to: destino, subject, html });
  return ok
    ? { sent: true, message: `Aviso enviado a ${destino}.` }
    : { sent: false, reason: 'SEND_FAILED', message: `No se pudo enviar el aviso a ${destino}.` };
}

export function enviarAvisoSuspension(
  target: AccountEmailTarget,
  data: SuspensionData,
): Promise<ResultadoAviso> {
  return avisar(target, 'Tu cuenta de URBONT ha sido suspendida', suspensionHtml(target, data));
}

export function enviarAvisoReactivacion(target: AccountEmailTarget): Promise<ResultadoAviso> {
  return avisar(target, 'Tu cuenta de URBONT vuelve a estar activa', reactivacionHtml(target));
}
