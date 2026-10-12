/**
 * Independent Valet Participation Agreement.
 *
 * El texto vive aquí, versionado, para poder sustituirlo sin publicar otra app.
 * `ivpa-2026-10-1` es un borrador operativo: cubre lo que pide el registro
 * (negocio independiente, responsabilidad propia, limitación e indemnización)
 * y no sustituye la revisión de un abogado.
 */
import { createHash } from 'crypto';

export const ACUERDO_VERSION = 'ivpa-2026-10-1';

export const ACUERDO_TEXTO = `INDEPENDENT VALET PARTICIPATION AGREEMENT
Version ${ACUERDO_VERSION}

OPERATIONAL DRAFT. This is the exact text presented for electronic acceptance. It is not a substitute for review by counsel. URBONT may replace it with a later version; a later version must be accepted separately.

1. Independent business
You participate in URBONT as an independent business, or as the authorized representative of the company whose details you provide. You are not an employee, partner, joint venturer, or agent of URBONT. URBONT does not control how you staff, supervise, or carry out valet activity at your location. Nothing in this agreement creates an employment relationship.

2. Your own responsibility
You are responsible for your own actions and for the actions of the people who perform valet services for your company, within the limits permitted by law. That includes how vehicles are handled, how guests are treated, and whether your activity complies with the licenses, permits, and rules that apply to you. URBONT provides a platform to request chauffeur trips. It does not perform valet services for you.

3. Limitation of liability
To the fullest extent permitted by law, URBONT is not liable for loss, damage, injury, or delay arising from your valet operations, from a guest's vehicle while it is in your care, or from your decision to request or not request a trip. Where the law does not allow a complete limitation, URBONT's liability is limited to the minimum the law requires. URBONT does not exclude liability for its own fraud or for any liability that cannot legally be limited.

4. Indemnification
You will indemnify and hold harmless URBONT and its directors, employees, and agents from claims, losses, and reasonable expenses (including attorneys' fees) that arise from your valet activity, from a breach of this agreement, or from the acts or omissions of your company or its staff, except to the extent caused by URBONT's own fraud or by liability that the law does not allow you to indemnify.

5. Electronic acceptance
Pressing "I AGREE – Electronic Signature" after checking the box is your electronic signature. URBONT stores your name, account, the date and time, this version, and a record that you pressed the button. You may download a copy of the agreement together with that record.
`;

export function hashAcuerdo(texto: string = ACUERDO_TEXTO): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

export const ACUERDO_HASH = hashAcuerdo();

export interface AceptacionPedida {
  version?: string | null;
  checkbox?: boolean | null;
  action?: string | null;
}

/** Solo cuenta si marcó la casilla, pulsó I AGREE y es la versión que se le mostró. */
export function aceptacionValida(p: AceptacionPedida): boolean {
  return p.checkbox === true && p.action === 'i_agree' && p.version === ACUERDO_VERSION;
}

export interface RegistroFirma {
  name: string;
  email: string;
  acceptedAt: string;
  version: string;
  sha256: string;
}

/** Texto que el valet descarga: el acuerdo más la prueba de que pulsó I AGREE. */
export function copiaFirmada(r: RegistroFirma): string {
  return `${ACUERDO_TEXTO}
ELECTRONIC SIGNATURE RECORD
Name: ${r.name || '—'}
Account: ${r.email || '—'}
Accepted at: ${r.acceptedAt}
Version: ${r.version}
SHA-256: ${r.sha256}
Record: the valet checked the box and pressed "I AGREE – Electronic Signature".
`;
}
