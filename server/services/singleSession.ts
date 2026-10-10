/**
 * Una sola sesión abierta por cuenta.
 *
 * Cada inicio de sesión genera un identificador (`sid`) que viaja dentro del
 * token y queda guardado en `profiles.session_id`. Un token cuyo `sid` ya no es
 * el guardado es de un dispositivo donde se entró antes que en el actual, y se
 * rechaza con `session_replaced`.
 *
 * Gana el inicio de sesión más reciente, no el último dispositivo en hacer una
 * petición: por eso cada sesión lleva también su hora de inicio (`lat` en el
 * token, `session_login_at` en la base), que se conserva al renovar el token.
 *
 * Pensado para que el despliegue no se note:
 *  - Los tokens emitidos antes, sin `sid`, siguen valiendo mientras la cuenta no
 *    tenga una sesión registrada; es decir, hasta que la persona vuelva a
 *    iniciar sesión en algún dispositivo.
 *  - El inicio con Google que la app hace directo contra Supabase se identifica
 *    con el `session_id` y la hora de autenticación del propio token. Los que
 *    son anteriores al despliegue no registran nada: los frena
 *    `session_login_at`, que la migración rellena con la hora en que se creó.
 *  - Ante cualquier fallo de la base se deja pasar: es preferible a sacar a todos.
 *  - Sólo aplica a pasajeros, choferes y valets. Recepción, concierge y admin
 *    quedan fuera: son cuentas del hotel que comparten varios empleados.
 *  - `SINGLE_SESSION=off` apaga el control sin desplegar código, y
 *    `SINGLE_SESSION_EXEMPT` (ids separados por comas) exime cuentas, como la
 *    de revisión de Apple, que se usan en varios dispositivos a la vez.
 */

import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool';
import { issueToken } from '../db/client';
import { logger } from '../lib/logger';

/** La sesión a la que pertenece un token. `loginAt` en milisegundos. */
export interface SessionRef {
  sid: string | null;
  loginAt: number | null;
}

/** La sesión vigente de una cuenta. `loginAt` es 0 cuando nunca hubo una. */
export interface RegisteredSession {
  sid: string | null;
  loginAt: number;
}

/** Lo que responde una petición rechazada; la app lo reconoce por `error`. */
export const SESSION_REPLACED = {
  error: 'session_replaced',
  message: 'Your session was opened on another device.',
} as const;

/**
 * La lectura se guarda unos segundos para no consultar la base en cada petición.
 * Con una sola instancia el cambio es inmediato, porque el registro actualiza
 * esta caché; con varias, una instancia que no atendió el inicio de sesión tarda
 * hasta esto en enterarse.
 */
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map<string, { reg: RegisteredSession; at: number }>();

/** Roles que pueden tener la cuenta abierta en varios dispositivos. */
const SHARED_ROLES = new Set(['frontdesk', 'concierge', 'admin']);

function enforced(userId: string, role: string): boolean {
  if ((process.env.SINGLE_SESSION ?? '').toLowerCase() === 'off') return false;
  if (SHARED_ROLES.has(role)) return false;
  const exempt = (process.env.SINGLE_SESSION_EXEMPT ?? '').split(',').map(s => s.trim());
  return !exempt.includes(userId);
}

/**
 * La regla, sin base de datos de por medio.
 *
 * `register` indica que el token es de un inicio de sesión más reciente que el
 * guardado y pasa a ser la sesión vigente: cubre el inicio con Google, que no
 * pasa por los endpoints de login de la API.
 */
export function decide(reg: RegisteredSession, token: SessionRef): { ok: boolean; register: boolean } {
  const newer = token.sid !== null && token.loginAt !== null && token.loginAt > reg.loginAt;
  if (!reg.sid) return { ok: true, register: newer };
  if (!token.sid) return { ok: false, register: false };
  if (token.sid === reg.sid) return { ok: true, register: false };
  return newer ? { ok: true, register: true } : { ok: false, register: false };
}

async function getRegistered(userId: string): Promise<RegisteredSession | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.reg;

  const { rows } = await pool.query<{ session_id: string | null; session_login_at: Date | null }>(
    `SELECT session_id, session_login_at FROM profiles WHERE id = $1`,
    [userId],
  );
  // Sin perfil no hay con qué comparar: se deja pasar, como hasta ahora.
  if (!rows[0]) return null;

  const reg = { sid: rows[0].session_id, loginAt: rows[0].session_login_at?.getTime() ?? 0 };
  cache.set(userId, { reg, at: Date.now() });
  return reg;
}

/**
 * Deja `sid` como la sesión vigente y avisa a los demás dispositivos.
 *
 * Sólo escribe si es más reciente que la guardada: si dos dispositivos entran a
 * la vez, gana el que inició sesión último aunque su escritura llegue primero.
 */
async function registerSession(userId: string, role: string, sid: string, loginAt: number): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE profiles SET session_id = $2, session_login_at = $3
      WHERE id = $1 AND (session_login_at IS NULL OR session_login_at < $3)`,
    [userId, sid, new Date(loginAt)],
  );
  if (!rowCount) {
    cache.delete(userId);
    return;
  }
  cache.set(userId, { reg: { sid, loginAt }, at: Date.now() });

  if (!enforced(userId, role)) return;
  // Los otros dispositivos no hacen peticiones mientras están quietos: el aviso
  // por socket les pide que comprueben su sesión, y así se cierran al momento.
  // También lo recibe el dispositivo nuevo si ya estaba conectado; su
  // comprobación sale bien y no pasa nada.
  // Import diferido: el middleware de auth no tiene por qué cargar los sockets.
  const { getIO } = await import('./socketService');
  getIO()?.to(`user:${userId}`).emit('session:replaced');
  logger.info({ userId }, '[Sesión] Nueva sesión registrada; las anteriores quedan cerradas');
}

/** Si el token pertenece a la sesión vigente de la cuenta. Nunca lanza. */
export async function isSessionCurrent(userId: string, role: string, ref: SessionRef): Promise<boolean> {
  try {
    const reg = await getRegistered(userId);
    if (!reg) return true;
    const { ok, register } = decide(reg, ref);
    if (register && ref.sid && ref.loginAt !== null) await registerSession(userId, role, ref.sid, ref.loginAt);
    if (!enforced(userId, role)) return true;
    return ok;
  } catch (err) {
    logger.warn({ userId, err: (err as Error).message }, '[Sesión] No se pudo comprobar; se deja pasar');
    return true;
  }
}

/**
 * Emite el token de un inicio de sesión y lo deja como la única sesión de la
 * cuenta. Todos los logins pasan por aquí: un token emitido sin `sid` se
 * rechazaría en cuanto la cuenta tuviera una sesión registrada.
 */
export async function startSession(user: { id: string; phone: string; role: string }): Promise<string> {
  const sid = randomUUID();
  const loginAt = Date.now();
  const token = issueToken(user, { sid, loginAt });
  try {
    await registerSession(user.id, user.role, sid, loginAt);
  } catch (err) {
    // El token vale igual: mientras no haya sesión registrada, todas pasan.
    logger.warn({ userId: user.id, err: (err as Error).message }, '[Sesión] No se pudo registrar el inicio de sesión');
  }
  return token;
}

/**
 * La sesión de un token emitido por Supabase (inicio con Google desde la app).
 * `amr` trae la hora en que la persona se autenticó, que no cambia al renovar.
 */
export function sessionFromSupabaseToken(token: string): SessionRef {
  const payload = jwt.decode(token) as { session_id?: unknown; amr?: { timestamp?: unknown }[] } | null;
  const sid = typeof payload?.session_id === 'string' && payload.session_id ? `sb:${payload.session_id}` : null;
  const stamps = (Array.isArray(payload?.amr) ? payload.amr : [])
    .map(a => Number(a?.timestamp))
    .filter(n => Number.isFinite(n) && n > 0);
  return { sid, loginAt: stamps.length ? Math.min(...stamps) * 1000 : null };
}
