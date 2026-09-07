// ── Shared visual system for outgoing email ───────────────────────────────────
// Every email the API sends is built on this shell, so the brand reads the same
// whether the recipient gets a receipt, a support alert or a login code.
//
// Before this module the three templates had drifted apart: three different
// navies (#0A2438, #001F3F and a slate-gray set), three font stacks
// (system-ui / Arial / bare sans-serif) and three corner radii (20 / 12 / 8 px).
//
// Email constraints this file works within:
//   · tables for layout — flexbox and grid are unreliable across clients
//   · inline styles only — several clients strip <style> blocks
//   · no CSS variables — tokens live here as TS constants and get interpolated
//   · system fonts only — web fonts do not load in most mail clients
//   · bgcolor attributes alongside CSS, for older Outlook

/** Brand tokens. Single place to adjust the palette. */
export const brand = {
  /** Darkest navy — body text and the top of the header gradient. */
  navyDeep: '#0A2438',
  /** Mid blue — bottom of the header gradient, secondary marks. */
  navyMid:  '#1A5A7F',
  /** Logo tile background, taken from the brand mark. */
  tile:     '#2E5A78',
  /** Gold accent — eyebrow labels and highlights. */
  gold:     '#D4A055',
  /** Secondary text. */
  slate:    '#5A6B79',
  /** Page background behind the card. */
  ground:   '#E9EEF0',
  /** Hairlines and dividers. */
  line:     '#E3E9ED',
  /** Panels nested inside the card. */
  panel:    '#F4F7F9',
  paper:    '#FFFFFF',
  muted:    '#9BAAB5',
  green:    '#1E7A54',
  amber:    '#C77D0A',
  red:      '#C0392B',
} as const;

export const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * Brand mark: the tile plus the URBONT wordmark.
 *
 * Drawn in HTML rather than referenced as an image on purpose — Gmail blocks
 * `data:` URIs and remote images are hidden until the reader allows them, so a
 * linked logo would leave a blank gap for most recipients. If the mark is ever
 * hosted at a stable public URL, swap the tile cell for an <img> and keep the
 * rest.
 */
function logoLockup(): string {
  return `
      <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 16px;">
        <tr>
          <td width="54" height="54" align="center" valign="middle" bgcolor="${brand.tile}"
              style="width:54px;height:54px;background:${brand.tile};border-radius:13px;
                     font-family:${FONT};font-size:31px;font-weight:300;color:#FFFFFF;
                     line-height:54px;text-align:center;">U</td>
        </tr>
      </table>
      <h1 style="margin:0;font-family:${FONT};font-size:27px;font-weight:200;
                 color:#FFFFFF;letter-spacing:0.14em;text-transform:uppercase;">URBONT</h1>`;
}

export interface ShellOptions {
  /** Small gold label above the wordmark. e.g. "Trip Receipt" */
  eyebrow: string;
  /** Optional line under the wordmark — a date, a ticket number. */
  subtitle?: string;
  /** The email body, already rendered. */
  content: string;
  /** Closing line above the copyright. */
  footerNote?: string;
}

/** Wraps content in the standard URBONT card. */
export function emailShell(o: ShellOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${brand.ground};font-family:${FONT};">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${brand.ground}"
       style="background:${brand.ground};padding:32px 16px;">
  <tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" border="0"
           style="width:520px;max-width:100%;background:${brand.paper};border-radius:20px;overflow:hidden;">

      <!-- Header -->
      <tr><td bgcolor="${brand.navyDeep}" align="center"
              style="background:${brand.navyDeep};
                     background-image:linear-gradient(135deg,${brand.navyDeep},${brand.navyMid});
                     padding:34px 32px 30px;text-align:center;">
        <p style="margin:0 0 14px;font-family:${FONT};font-size:11px;font-weight:800;
                  color:${brand.gold};letter-spacing:0.22em;text-transform:uppercase;">${o.eyebrow}</p>
        ${logoLockup()}
        ${o.subtitle ? `<p style="margin:10px 0 0;font-family:${FONT};font-size:13px;
                  color:rgba(255,255,255,0.55);">${o.subtitle}</p>` : ''}
      </td></tr>

      <!-- Body -->
      <tr><td style="padding:0;">${o.content}</td></tr>

      <!-- Footer -->
      <tr><td style="padding:22px 30px 30px;text-align:center;border-top:1px solid ${brand.line};">
        ${o.footerNote ? `<p style="margin:0 0 8px;font-family:${FONT};font-size:11px;
                  color:${brand.muted};line-height:1.5;">${o.footerNote}</p>` : ''}
        <p style="margin:0;font-family:${FONT};font-size:11px;color:${brand.muted};">
          URBONT — Premium Chauffeur Service · Miami</p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── Reusable pieces ───────────────────────────────────────────────────────────

/** Label/value row for detail tables. */
export function row(label: string, value: string, opts: { strong?: boolean; color?: string } = {}): string {
  const weight = opts.strong ? '600' : '400';
  const color  = opts.color || brand.navyDeep;
  return `<tr>
      <td style="padding:7px 0;font-family:${FONT};font-size:13px;color:${brand.slate};">${label}</td>
      <td style="padding:7px 0;font-family:${FONT};font-size:13px;color:${color};
                 font-weight:${weight};text-align:right;">${value}</td>
    </tr>`;
}

/** Emphasised total row, separated by a rule. */
export function totalRow(label: string, value: string): string {
  return `<tr>
      <td style="padding:13px 0 6px;font-family:${FONT};font-size:16px;font-weight:700;
                 color:${brand.navyDeep};border-top:1px solid ${brand.line};">${label}</td>
      <td style="padding:13px 0 6px;font-family:${FONT};font-size:16px;font-weight:700;
                 color:${brand.navyDeep};text-align:right;border-top:1px solid ${brand.line};">${value}</td>
    </tr>`;
}

/** Coloured pill, used for ticket priority. */
export function badge(text: string, color: string): string {
  return `<span style="display:inline-block;padding:3px 11px;border-radius:11px;
      background:${color}1F;color:${color};font-family:${FONT};font-size:11px;
      font-weight:700;letter-spacing:0.04em;text-transform:uppercase;">${text}</span>`;
}

/** Section wrapper with the standard side padding. */
export function section(inner: string, padding = '24px 30px 0'): string {
  return `<div style="padding:${padding};">${inner}</div>`;
}
