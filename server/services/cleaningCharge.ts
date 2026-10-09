/**
 * Reglas del cargo de limpieza. No habla con la base ni con Stripe: la ruta y
 * el cobro las usan, y aquí se pueden probar solas.
 *
 * El viaje ya se cobró al terminarlo. Esto es otro cargo, en dólares, y no sale
 * de la tarjeta hasta que Urbont lo aprueba. Las fotos pueden llegar hasta 2
 * horas después de completed_at: el chofer a veces no ve la suciedad hasta
 * que llega a casa. El recibo de la limpieza profesional entra después,
 * dentro de las 72 horas.
 */

export const VENTANA_MS = 2 * 60 * 60 * 1000;
export const RECIBO_MS = 72 * 60 * 60 * 1000;

export const FOTO_TIPOS = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
export const FOTO_MAX_BYTES = 10 * 1024 * 1024;
export const FOTOS_MAX = 5;
export const FOTOS_MIN = 1;

export const MOTIVOS = {
  beach_sand: { amountUsd: 30, needsReceipt: false, label: 'Beach sand' },
  vomit: { amountUsd: 200, needsReceipt: true, label: 'Professional cleaning' },
} as const;

export type MotivoLimpieza = keyof typeof MOTIVOS;

export type EstadoLimpieza =
  | 'collecting'
  | 'pending_review'
  | 'awaiting_receipt'
  | 'charged'
  | 'charge_failed'
  | 'rejected';

export function esMotivo(value: unknown): value is MotivoLimpieza {
  return value === 'beach_sand' || value === 'vomit';
}

/** Segundos que faltan para cerrar la ventana de fotos. 0 si ya venció. */
export function segundosRestantes(completedAt: Date, ahora: Date): number {
  const queda = VENTANA_MS - (ahora.getTime() - completedAt.getTime());
  if (!Number.isFinite(queda) || queda <= 0) return 0;
  return Math.ceil(queda / 1000);
}

export function ventanaAbierta(completedAt: Date, ahora: Date): boolean {
  return segundosRestantes(completedAt, ahora) > 0;
}

export function venceRecibo(completedAt: Date): Date {
  return new Date(completedAt.getTime() + RECIBO_MS);
}

export function estadoAlEnviar(motivo: MotivoLimpieza): 'pending_review' | 'awaiting_receipt' {
  return MOTIVOS[motivo].needsReceipt ? 'awaiting_receipt' : 'pending_review';
}

/** Sitio donde se puedan ver los servicios. Devuelve la URL canónica, o null. */
export function normalizarSitio(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const texto = raw.trim();
  if (!texto || texto.length > 300) return null;
  let url: URL;
  try {
    url = new URL(texto.includes('://') ? texto : `https://${texto}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname.includes('.') || url.hostname.length > 253) return null;
  return url.toString();
}

export function nombreEmpresaValido(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const nombre = raw.trim().replace(/\s+/g, ' ');
  if (nombre.length < 2 || nombre.length > 120) return null;
  return nombre;
}

export function mimeAceptado(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const mime = raw.trim().toLowerCase();
  return FOTO_TIPOS.includes(mime) ? mime : null;
}

/** El recibo sólo se adjunta mientras el caso lo está esperando y no venció. */
export function puedeAdjuntarRecibo(status: string, vence: Date, ahora: Date): boolean {
  return status === 'awaiting_receipt' && ahora.getTime() <= vence.getTime();
}
