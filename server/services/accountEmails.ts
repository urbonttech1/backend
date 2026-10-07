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

export function aprobacionValetHtml(target: AccountEmailTarget): string {
  return emailShell({
    eyebrow: 'Solicitud de valet',
    content: section(`
      ${parrafo(saludo(target.name))}
      ${parrafo(`Tu solicitud para unirte a la red de valets de URBONT fue <strong>aprobada</strong>.
        Ya puedes iniciar sesión en la app con tu correo y tu contraseña y empezar a despachar viajes.`)}
      ${parrafo(`¿Te postulaste desde nuestro sitio web? Entonces aún no tienes contraseña: abre la app, entra a
        <em>Valet</em> y toca <strong>«Forgot password?»</strong> para crearla con este mismo correo.`)}
      <div style="margin:4px 0 18px;">${badge('Cuenta aprobada', brand.green)}</div>
      ${parrafo(`Bienvenido. Si tienes dudas, escríbenos a
        <a href="mailto:${SOPORTE}" style="color:${brand.navyMid};">${SOPORTE}</a>.`, '0')}
    `),
    footerNote: 'Este mensaje se envió porque el estado de tu solicitud cambió.',
  });
}

export function rechazoValetHtml(target: AccountEmailTarget, reason?: string | null): string {
  return emailShell({
    eyebrow: 'Solicitud de valet',
    content: section(`
      ${parrafo(saludo(target.name))}
      ${parrafo(`Revisamos tu solicitud para unirte a la red de valets de URBONT y, por ahora,
        <strong>no pudimos aprobarla</strong>.`)}
      ${reason ? panel(`<p style="margin:0;font-family:${FONT};font-size:14px;line-height:1.55;
        color:${brand.navyDeep};">${reason}</p>`) : ''}
      ${parrafo(`Si crees que se trata de un error, responde a este correo o escríbenos a
        <a href="mailto:${SOPORTE}" style="color:${brand.navyMid};">${SOPORTE}</a>.`, '0')}
    `),
    footerNote: 'Este mensaje se envió porque el estado de tu solicitud cambió.',
  });
}

export function documentoValetHtml(target: AccountEmailTarget, docLabel: string, reason?: string | null): string {
  return emailShell({
    eyebrow: 'Solicitud de valet',
    content: section(`
      ${parrafo(saludo(target.name))}
      ${parrafo(`Revisamos tu documento <strong>${docLabel}</strong> y necesitamos que lo envíes de nuevo.`)}
      ${reason ? panel(`<p style="margin:0;font-family:${FONT};font-size:14px;line-height:1.55;
        color:${brand.navyDeep};">${reason}</p>`) : ''}
      ${parrafo(`Abre la app de URBONT e inicia sesión con tu correo y contraseña: te pediremos subirlo otra vez
        y tu solicitud seguirá en revisión.`)}
      ${parrafo(`¿Dudas? Escríbenos a
        <a href="mailto:${SOPORTE}" style="color:${brand.navyMid};">${SOPORTE}</a>.`, '0')}
    `),
    footerNote: 'Este mensaje se envió porque tu solicitud de valet tiene un documento por corregir.',
  });
}

export function cambioContrasenaHtml(target: AccountEmailTarget): string {
  return emailShell({
    eyebrow: 'Seguridad de la cuenta',
    content: section(`
      ${parrafo(saludo(target.name))}
      ${parrafo(`El equipo de URBONT <strong>cambió la contraseña</strong> de tu cuenta.
        Usa la nueva contraseña que te compartimos para iniciar sesión en la app.`)}
      ${parrafo(`Si no pediste este cambio, escríbenos de inmediato a
        <a href="mailto:${SOPORTE}" style="color:${brand.navyMid};">${SOPORTE}</a>.`, '0')}
    `),
    footerNote: 'Este mensaje se envió porque la contraseña de tu cuenta cambió.',
  });
}

export type FaseVencimiento = '30d' | '15d' | '7d' | 'vencido';

/** `YYYY-MM-DD` sin pasar por la zona del servidor, que podría restarle un día. */
function fechaDeVencimiento(ymd: string): string {
  return new Date(`${ymd.slice(0, 10)}T12:00:00Z`).toLocaleDateString('es-US', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

export function vencimientoDocumentoHtml(
  target: AccountEmailTarget,
  docLabel: string,
  expiryDate: string,
  fase: FaseVencimiento,
): string {
  const fecha = `<strong>${fechaDeVencimiento(expiryDate)}</strong>`;
  const cuerpo = fase === 'vencido'
    ? `${parrafo(`Tu documento <strong>${docLabel}</strong> venció el ${fecha}.`)}
       ${parrafo(`Por seguridad, tu cuenta quedó <strong>suspendida temporalmente</strong> y no podrás
         recibir viajes hasta que subas un documento vigente.`)}
       <div style="margin:4px 0 18px;">${badge('Documento vencido', brand.red)}</div>`
    : `${parrafo(`Tu documento <strong>${docLabel}</strong> vence el ${fecha}${
         fase === '7d' ? ', en menos de una semana' : fase === '15d' ? ', en unas dos semanas' : ''}.`)}
       ${parrafo(fase === '7d' || fase === '15d'
         ? 'Si no lo renuevas antes de esa fecha, tu cuenta se suspenderá y no podrás recibir viajes.'
         : 'Renuévalo con tiempo para seguir conduciendo sin interrupciones.')}`;

  return emailShell({
    eyebrow: 'Documentos',
    content: section(`
      ${parrafo(saludo(target.name))}
      ${cuerpo}
      ${parrafo(`Abre la app de URBONT, entra a <em>Perfil → Documentos</em> y sube la versión vigente.`)}
      ${parrafo(`¿Dudas? Escríbenos a
        <a href="mailto:${SOPORTE}" style="color:${brand.navyMid};">${SOPORTE}</a>.`, '0')}
    `),
    footerNote: 'Este mensaje se envió porque uno de tus documentos está por vencer o venció.',
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

export function enviarAvisoAprobacionValet(target: AccountEmailTarget): Promise<ResultadoAviso> {
  return avisar(target, 'Tu solicitud de valet en URBONT fue aprobada', aprobacionValetHtml(target));
}

export function enviarAvisoRechazoValet(target: AccountEmailTarget, reason?: string | null): Promise<ResultadoAviso> {
  return avisar(target, 'Sobre tu solicitud de valet en URBONT', rechazoValetHtml(target, reason));
}

export function enviarAvisoDocumentoValet(target: AccountEmailTarget, docLabel: string, reason?: string | null): Promise<ResultadoAviso> {
  return avisar(target, 'Necesitamos que vuelvas a enviar un documento', documentoValetHtml(target, docLabel, reason));
}

export function enviarAvisoCambioContrasena(target: AccountEmailTarget): Promise<ResultadoAviso> {
  return avisar(target, 'La contraseña de tu cuenta de URBONT cambió', cambioContrasenaHtml(target));
}

const ASUNTO_VENCIMIENTO: Record<FaseVencimiento, (doc: string) => string> = {
  '30d':     doc => `Tu ${doc} vence en 30 días`,
  '15d':     doc => `Tu ${doc} vence en 15 días`,
  '7d':      doc => `Tu ${doc} vence en 7 días`,
  'vencido': doc => `Tu ${doc} venció — cuenta suspendida`,
};

export function enviarAvisoVencimientoDocumento(
  target: AccountEmailTarget,
  docLabel: string,
  expiryDate: string,
  fase: FaseVencimiento,
): Promise<ResultadoAviso> {
  return avisar(target, ASUNTO_VENCIMIENTO[fase](docLabel), vencimientoDocumentoHtml(target, docLabel, expiryDate, fase));
}
