/**
 * El email y el push de lanzamiento de Tap to Pay on iPhone (checklist 6.1 y
 * 6.3). Sin base de datos ni envíos, para poder probarlo y previsualizarlo; el
 * envío está en tapToPayLaunch.ts.
 *
 * Apple sólo permite su material: el email sigue la plantilla "Launch" del
 * Marketing Toolkit (versión móvil, una columna) con sus imágenes —el visual de
 * producto y los íconos salen del PSD sin tocar— y cada frase es copy aprobado
 * de la guía de marketing (agosto 2025), con el nombre de la app donde la guía
 * deja el hueco. Lo único que la guía permite cambiar libremente son los pasos
 * para empezar, que aquí son los de URBONT.
 */
import { FONT } from './emailLayout';

/** Las imágenes las publica la web (websitev2/public/email/tap-to-pay). */
const IMG = process.env.TAP_TO_PAY_EMAIL_IMAGES_URL || 'https://urbont.com/email/tap-to-pay';

/** El botón lleva a la app en el App Store: la actualiza o la abre. */
const APP_URL = 'https://apps.apple.com/app/urbont/id6449638551';

export const ASUNTO = 'Tap to Pay on iPhone is now available in URBONT';

// ── Copy aprobado (Tap to Pay on iPhone Marketing Guide, agosto 2025) ────────
export const COPY = {
  headline: 'Tap to Pay on iPhone',
  // Value proposition, subheadline.
  subheadline: 'Accept contactless payments right on your iPhone.',
  // Value proposition, short copy ([partner name solution/app] y [terminals/readers]).
  body: 'With Tap to Pay on iPhone and the URBONT app, you can accept all types of in-person, contactless payments right on your iPhone—from physical debit and credit cards to Apple Pay and other digital wallets—no extra card readers or hardware needed. It’s easy, secure, and private.',
  // CTA.
  cta: 'Get started',
  tiles: [
    {
      icon: 'icon-reach.png', w: 39, h: 39,
      // Enhanced experience: subheadline + push body + advertising copy.
      head: 'Expand where you do business.',
      body: 'Reach more customers, take payments on the go, and explore new setups like line busting. All you need is your iPhone and the URBONT app.',
    },
    {
      icon: 'icon-contactless.png', w: 26, h: 37,
      // Streamlined operations: subheadline + push body.
      head: 'No additional hardware required.',
      body: 'You can accept all types of contactless payments right on your iPhone. There’s no additional hardware to invest in or manage.',
    },
    {
      icon: 'icon-privacy.png', w: 26, h: 36,
      // Privacy and security: subheadline + short copy.
      head: 'Privacy and security of iPhone built in.',
      body: 'Tap to Pay on iPhone uses the built-in security and privacy features of iPhone to help protect your business and customer data. Apple doesn’t store card numbers on Apple servers, so merchants and customers can rest assured that their data stays theirs.',
    },
  ],
  // Easy (merchants): subheadline. Los pasos son de URBONT.
  stepsHead: 'Get started in a few steps.',
  steps: [
    'Update the URBONT app from the App Store.',
    'Go to Account > Tap to Pay on iPhone and enable it.',
    'Accept in-person, contactless payments right on your iPhone.',
  ],
  // Legal: completo, más los adicionales por mencionar privacidad y Apple Pay.
  legal: [
    'Tap to Pay on iPhone Requirements: Tap to Pay on iPhone requires a supported payment app and the latest version of iOS. Update to the latest version by going to Settings > General > Software Update. Tap Download and Install. Some contactless cards may not be accepted by your payment app. Transaction limits may apply. The Contactless Symbol is a trademark owned by and used with permission of EMVCo, LLC. Tap to Pay on iPhone is not available in all markets. For Tap to Pay on iPhone countries and regions, see developer.apple.com/tap-to-pay/regions.',
    'Tap to Pay on iPhone Encryption and Storage: Encrypted card numbers are temporarily stored on iPhone only for transactions made in Store and Forward mode.',
    'Apple Pay is a service provided by Apple Payments Services LLC, a subsidiary of Apple Inc. Neither Apple Inc. nor Apple Payments Services LLC is a bank. Any card used in Apple Pay is offered by the card issuer.',
  ],
} as const;

/** Push de lanzamiento: "Value proposition" de la guía, con su CTA. */
export const PUSH = {
  title: 'Accept in-person payments with Tap to Pay on iPhone.',
  body: 'You can accept all types of contactless payments right on your iPhone—from physical debit and credit cards to Apple Pay and other digital wallets. Terms apply.',
  // Al abrirla, quien aún no lo activó ve la presentación con el banner Hero.
  data: { type: 'tap_to_pay_launch', screen: 'driver_home' },
} as const;

// Colores de la plantilla de Apple.
const TEXTO = '#1D1D1F';
const GRIS = '#6E6E73';
const FONDO = '#F5F5F7';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function tile(inner: string, padding = '32px 28px'): string {
  return `<tr><td style="padding:0 0 16px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="background:#FFFFFF;">
      <tr><td style="padding:${padding};">${inner}</td></tr>
    </table>
  </td></tr>`;
}

/**
 * El email "Launch" de la plantilla, en una columna de 480 px. `img` cambia de
 * dónde salen las imágenes (la vista previa local las toma del disco).
 */
export function launchEmailHtml(img: string = IMG): string {
  const c = COPY;
  const bloques = c.tiles.map(t => tile(`
        <img src="${img}/${t.icon}" width="${t.w}" height="${t.h}" alt="" style="display:block;border:0;margin:0 0 18px;">
        <p style="margin:0 0 10px;font-family:${FONT};font-size:24px;line-height:1.2;font-weight:600;color:${TEXTO};">${esc(t.head)}</p>
        <p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.45;color:${TEXTO};">${esc(t.body)}</p>`)).join('');

  const pasos = c.steps.map((s, i) => `
        <tr><td style="padding:0 0 22px;">
          <img src="${img}/step-${i + 1}.png" width="35" height="35" alt="${i + 1}" style="display:block;border:0;margin:0 0 10px;">
          <p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.4;font-weight:600;color:${TEXTO};">${esc(s)}</p>
        </td></tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(ASUNTO)}</title></head>
<body style="margin:0;padding:0;background:${FONDO};">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${FONDO}" style="background:${FONDO};">
  <tr><td align="center" style="padding:24px 12px;">
    <table width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px;max-width:100%;">

      ${tile(`
        <p style="margin:0 0 28px;font-family:${FONT};font-size:15px;font-weight:300;letter-spacing:0.14em;color:${TEXTO};">URBONT</p>
        <h1 style="margin:0 0 16px;font-family:${FONT};font-size:34px;line-height:1.1;font-weight:700;color:${TEXTO};">${esc(c.headline)}</h1>
        <p style="margin:0 0 18px;font-family:${FONT};font-size:22px;line-height:1.25;font-weight:600;color:${GRIS};">${esc(c.subheadline)}</p>
        <p style="margin:0 0 26px;font-family:${FONT};font-size:15px;line-height:1.45;color:${TEXTO};">${esc(c.body)}<sup style="font-size:10px;">&#9674;</sup></p>
        <table cellpadding="0" cellspacing="0" border="0"><tr>
          <td bgcolor="#1A5A7F" style="background:#1A5A7F;border-radius:22px;">
            <a href="${APP_URL}" style="display:inline-block;padding:12px 26px;font-family:${FONT};font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;">${esc(c.cta)}</a>
          </td>
        </tr></table>`, '32px 28px 28px')}
      <tr><td style="padding:0 0 16px;">
        <img src="${img}/launch-hero.jpg" width="480" alt="A contactless card held near an iPhone to pay"
             style="display:block;width:100%;max-width:480px;height:auto;border:0;background:#FFFFFF;">
      </td></tr>
      ${bloques}
      ${tile(`
        <p style="margin:0 0 26px;font-family:${FONT};font-size:24px;line-height:1.2;font-weight:600;color:${TEXTO};">${esc(c.stepsHead)}</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">${pasos}</table>`)}

      <tr><td style="padding:8px 4px 0;font-family:${FONT};font-size:11px;line-height:1.5;color:${GRIS};">
        <p style="margin:0 0 6px;">&#9674; Legal</p>
        ${c.legal.map(l => `<p style="margin:0 0 8px;">${esc(l)}</p>`).join('')}
        <p style="margin:12px 0 0;">URBONT — Premium Chauffeur Service · Miami</p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}
