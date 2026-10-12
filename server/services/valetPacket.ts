/**
 * Los tres estados que el panel muestra para la documentación del valet.
 * Puro: no consulta la base.
 */

export type EstadoAcuerdo = 'accepted' | 'pending';
export type EstadoW9 = 'missing' | 'received' | 'pending_review' | 'approved';
export type EstadoExpediente = 'pending_documentation' | 'ready';

/** El archivo existe y ya no está rechazado. */
export function estadoW9(status: string | null | undefined): EstadoW9 {
  if (!status || status === 'rejected') return 'missing';
  if (status === 'approved' || status === 'valid') return 'approved';
  if (status === 'pending_review') return 'pending_review';
  if (status === 'received') return 'received';
  return 'pending_review';
}

export function expediente(opts: {
  company: boolean;
  agreement: EstadoAcuerdo;
  w9: EstadoW9;
}): EstadoExpediente {
  if (!opts.company || opts.agreement !== 'accepted' || opts.w9 === 'missing') return 'pending_documentation';
  return 'ready';
}

/**
 * Lo que impide activar la cuenta. Presentar el W-9 basta;
 * aprobarlo sigue siendo la revisión de documentos, aparte de esta lista.
 */
export function faltantesActivacion(opts: {
  company: boolean;
  agreement: EstadoAcuerdo;
  w9: EstadoW9;
}): string[] {
  const falta: string[] = [];
  if (!opts.company) falta.push('Company information');
  if (opts.agreement !== 'accepted') falta.push('Independent Valet Participation Agreement');
  if (opts.w9 === 'missing') falta.push('IRS Form W-9');
  return falta;
}
