/**
 * Clasificación de los errores de Supabase Auth en altas de cuenta.
 *
 * POR QUÉ EXISTE — el alta de conductor detectaba el email duplicado
 * comparando texto: `authError.message.includes('already registered')`.
 * Supabase responde «A user with this email address has already been
 * registered», con un "been" en medio, así que la comparación daba `false`,
 * el `409 EMAIL_IN_USE` que estaba escrito justo para ese caso nunca se
 * alcanzaba, y el conductor recibía un `500 «Registration failed. Please try
 * again.»`. Reintentar no podía funcionar: el email no va a dejar de existir.
 *
 * Visto en producción el 2026-09-11 a las 00:31 UTC, dos intentos seguidos del
 * mismo conductor.
 *
 * La lección es que un mensaje de un proveedor no es un contrato: puede
 * reescribirse en cualquier versión del SDK. Lo que sí es estable es el
 * `code` —y en su defecto el `status`—, así que la decisión se toma con esos y
 * el texto queda sólo como última red.
 */

/** Forma mínima de un error de Supabase Auth, que el SDK no exporta completa. */
export interface SupabaseAuthErrorLike {
  message?: string;
  code?: string;
  status?: number;
}

/**
 * ¿Este error significa «ese email ya tiene cuenta»?
 *
 * Tres capas, de la más estable a la menos:
 *  1. `code: 'email_exists'` — lo que devuelve GoTrue hoy.
 *  2. `status: 422` en una creación de usuario: el único motivo por el que
 *     Supabase rechaza un alta con esa clase de error es el duplicado.
 *  3. El texto, tolerando cualquier palabra intermedia. Es la red que cubre
 *     versiones del SDK que no traigan `code`.
 */
export function esEmailDuplicado(err: SupabaseAuthErrorLike | null | undefined): boolean {
  if (!err) return false;
  if (err.code === 'email_exists' || err.code === 'user_already_exists') return true;
  if (err.status === 422) return true;
  return /already\b.*\b(registered|exists|taken)/i.test(err.message ?? '');
}

/** ¿El fallo es de configuración o disponibilidad del servicio de Auth, no del usuario? */
export function esFalloDeServicio(err: SupabaseAuthErrorLike | null | undefined): boolean {
  if (!err) return false;
  if (typeof err.status === 'number' && err.status >= 500) return true;
  return /fetch failed|network|timeout|ECONNREFUSED|ENOTFOUND|service unavailable|invalid api key|jwt/i
    .test(err.message ?? '');
}
