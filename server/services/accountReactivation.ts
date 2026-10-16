/**
 * Reactivar desde el panel una cuenta con borrado lógico.
 *
 * El borrado lógico deja el perfil como "Deleted User", sin correo ni
 * teléfono, cambia el correo de Auth por `deleted+<uid>@deleted.urbont.com` y
 * bloquea el acceso, pero no borra la cuenta: se puede devolver. Lo que hace
 * falta saber es a quién pertenecía, y eso sale de Auth (el correo de Google y
 * su nombre) o del registro de auditoría del borrado. El teléfono no se guarda
 * en ninguna parte, así que no vuelve.
 *
 * Sólo cuentas con borrado lógico: el definitivo ya no tiene nada que devolver.
 */
import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';
import { CUENTA_BORRADA, DUENO_BORRADO, NOMBRE_BORRADO, ROLES, type Tipo } from './accountDeletion';
import { cuentasEliminadas } from './deletedAccounts';

export type ResultadoReactivacion =
  | { ok: true; nombre: string | null; correo: string }
  | { ok: false; status: number; error: string; errorCode: string };

const DOMINIO_BORRADO = '@deleted.urbont.com';

/** "Paulo Andrés Estrada" → nombre "Paulo", apellido "Andrés Estrada". */
export function partirNombre(nombre: string | null | undefined): { first: string | null; last: string | null } {
  const partes = (nombre ?? '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return { first: null, last: null };
  return { first: partes[0], last: partes.slice(1).join(' ') || null };
}

interface UsuarioAuth {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
  identities?: { provider?: string; identity_data?: Record<string, unknown> | null }[] | null;
}

/**
 * De quién era la cuenta. El correo: el de la identidad de Google o de los
 * metadatos (no cambian al borrar), y si no, el que guardó la auditoría. El
 * nombre: el de la auditoría y, si no, el de Google. Regla pura.
 */
export function identidadParaReactivar(
  auditoria: { nombre: string | null; correo: string | null } | null,
  auth: UsuarioAuth | null,
): { nombre: string | null; correo: string | null } {
  const valido = (c: unknown): string | null =>
    typeof c === 'string' && c.includes('@') && !c.toLowerCase().endsWith(DOMINIO_BORRADO) ? c.trim().toLowerCase() : null;
  const meta = auth?.user_metadata ?? {};
  const deIdentidad = (auth?.identities ?? []).map(i => valido(i.identity_data?.email)).find(Boolean) ?? null;
  const correo = deIdentidad ?? valido(meta.email) ?? valido(auditoria?.correo) ?? valido(auth?.email);

  const nombreAuditoria = auditoria?.nombre && auditoria.nombre !== NOMBRE_BORRADO && !auditoria.nombre.includes('@') ? auditoria.nombre : null;
  const deGoogle = typeof meta.full_name === 'string' ? meta.full_name : typeof meta.name === 'string' ? meta.name : null;
  const nombre = (nombreAuditoria ?? deGoogle)?.trim() || null;
  return { nombre, correo };
}

export async function reactivarCuenta(uid: string, tipo: Tipo): Promise<ResultadoReactivacion> {
  const noEncontrada = { ok: false as const, status: 404, error: 'Cuenta eliminada no encontrada.', errorCode: 'NOT_FOUND' };
  if (uid === DUENO_BORRADO) return noEncontrada;

  const { data: perfil, error: errPerfil } = await supabaseAdmin
    .from('profiles').select('id, role, account_status').eq('id', uid).maybeSingle();
  if (errPerfil) throw errPerfil;
  if (!perfil || !ROLES[tipo].includes(String(perfil.role))) return noEncontrada;
  if (perfil.account_status !== CUENTA_BORRADA) {
    return { ok: false, status: 409, error: 'Esta cuenta no está eliminada.', errorCode: 'NOT_DELETED' };
  }

  const { data: authData, error: errAuth } = await supabaseAdmin.auth.admin.getUserById(uid);
  if (errAuth || !authData?.user) {
    return { ok: false, status: 409, error: 'La cuenta ya no tiene acceso que devolver; tiene que registrarse de nuevo.', errorCode: 'NO_AUTH_USER' };
  }

  const auditoria = (await cuentasEliminadas(tipo).catch(() => [])).find(c => c.id === uid) ?? null;
  const { nombre, correo } = identidadParaReactivar(auditoria, authData.user as UsuarioAuth);
  if (!correo) {
    return { ok: false, status: 409, error: 'No se sabe cuál era su correo, así que no se puede reactivar.', errorCode: 'NO_EMAIL' };
  }

  // Si mientras tanto se registró otra cuenta con ese correo, no se pisa.
  const { data: otros, error: errOtros } = await supabaseAdmin
    .from('profiles').select('id, account_status').ilike('email', correo);
  if (errOtros) throw errOtros;
  if ((otros ?? []).some(o => o.id !== uid && o.account_status !== CUENTA_BORRADA)) {
    return { ok: false, status: 409, error: `El correo ${correo} ya lo usa otra cuenta.`, errorCode: 'EMAIL_IN_USE' };
  }

  // Auth primero: si falla no se ha tocado el perfil.
  const { error: errActualizar } = await supabaseAdmin.auth.admin.updateUserById(uid, {
    email: correo,
    email_confirm: true,
    ban_duration: 'none',
    user_metadata: { deleted_at: null },
  });
  if (errActualizar) {
    logger.error(`[REACTIVAR] No se pudo devolver el acceso a ${uid}: ${errActualizar.message}`);
    return { ok: false, status: 409, error: `No se pudo reactivar: ${errActualizar.message}`, errorCode: 'AUTH_NOT_RESTORED' };
  }

  const { first, last } = partirNombre(nombre);
  const ahora = new Date().toISOString();
  const { error: errRestaurar } = await supabaseAdmin.from('profiles').update({
    ...(first ? { first_name: first, last_name: last } : {}),
    email: correo,
    account_status: 'active',
    updated_at: ahora,
  }).eq('id', uid).eq('account_status', CUENTA_BORRADA);
  if (errRestaurar) {
    // Auth ya quedó bien; repetir la reactivación termina el perfil.
    logger.error(`[REACTIVAR] Acceso de ${uid} devuelto, pero no se pudo restaurar el perfil: ${errRestaurar.message}`);
    return { ok: false, status: 500, error: `No se pudo restaurar el perfil: ${errRestaurar.message}`, errorCode: 'PROFILE_NOT_RESTORED' };
  }

  // Sus viajes vuelven a llevar su nombre.
  if (nombre) {
    await supabaseAdmin.from('rides').update({ passenger_name: nombre })
      .eq('passenger_id', uid).eq('passenger_name', NOMBRE_BORRADO);
    if (tipo === 'chauffeur') {
      await supabaseAdmin.from('rides').update({ driver_name: nombre })
        .eq('driver_id', uid).eq('driver_name', NOMBRE_BORRADO);
    }
  }

  logger.info(`[REACTIVAR] Cuenta ${uid} (${tipo}) reactivada`);
  return { ok: true, nombre, correo };
}
