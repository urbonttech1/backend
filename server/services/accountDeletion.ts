/**
 * Borrado de cuentas de pasajeros y valets desde el panel. Dos modos:
 *
 * - `borrarCuenta` (lógico, el normal) se explica abajo.
 * - `borrarCuentaDefinitiva` elimina la cuenta y sus viajes. Solo se permite
 *   si no tiene viajes completados ni pagados: esos son contabilidad y las
 *   ganancias de los choferes, y no se pueden conservar sin la cuenta.
 *
 * Borrado lógico. Borrar la fila no es posible: `rides.passenger_id` es
 * NOT NULL en producción y los viajes que despacha un valet llevan su id como
 * pasajero, así que la clave foránea rechaza el borrado. Y el perfil cuelga del
 * usuario de Auth en cascada, así que borrar éste falla igual.
 *
 * En su lugar: el perfil se queda sin datos personales y marcado 'deleted', el
 * usuario de Auth se bloquea y libera su correo, y los viajes se conservan.
 */
import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';

export const ESTADOS_ACTIVOS = ['scheduled', 'searching', 'confirmed', 'driver_arrived', 'in_progress'] as const;

export const CUENTA_BORRADA = 'deleted';

export type ResultadoBorrado =
  | { ok: true; email: string | null; nombre: string }
  | { ok: false; status: number; error: string; errorCode: string };

type Tipo = 'passenger' | 'valet';

const ROLES: Record<Tipo, string[]> = {
  passenger: ['passenger'],
  valet: ['valet', 'frontdesk', 'concierge'],
};

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export async function borrarCuenta(uid: string, tipo: Tipo): Promise<ResultadoBorrado> {
  const { data: perfil, error: errPerfil } = await supabaseAdmin
    .from('profiles').select('id, email, first_name, last_name, role, account_status').eq('id', uid).maybeSingle();
  if (errPerfil) throw errPerfil;
  if (!perfil || !ROLES[tipo].includes(String(perfil.role)) || perfil.account_status === CUENTA_BORRADA) {
    return { ok: false, status: 404, error: tipo === 'valet' ? 'Valet no encontrado.' : 'Pasajero no encontrado.', errorCode: 'NOT_FOUND' };
  }

  // Un viaje en curso perdería a su pasajero o a su valet a mitad de camino.
  const filtro = tipo === 'valet' ? `valet_user_id.eq.${uid},passenger_id.eq.${uid}` : `passenger_id.eq.${uid}`;
  const { count, error: errActivos } = await supabaseAdmin
    .from('rides').select('id', { count: 'exact', head: true })
    .or(filtro).in('ride_status', [...ESTADOS_ACTIVOS]);
  if (errActivos) throw errActivos;
  if ((count ?? 0) > 0) {
    return { ok: false, status: 409, error: 'Tiene un viaje activo o programado. Termínalo o cancélalo antes de borrar la cuenta.', errorCode: 'ACTIVE_RIDES' };
  }

  const ahora = new Date().toISOString();

  // Los viajes conservan sus ids (contabilidad), pero no el nombre ni el teléfono.
  const { error: errViajes } = await supabaseAdmin.from('rides')
    .update({ passenger_name: 'Deleted User', passenger_phone: null })
    .eq('passenger_id', uid);
  if (errViajes) throw errViajes;

  const { error: errBorrar } = await supabaseAdmin.from('profiles').update({
    first_name: 'Deleted',
    last_name: 'User',
    email: null,
    phone: null,
    avatar_url: null,
    business_name: null,
    account_status: CUENTA_BORRADA,
    is_online: false,
    updated_at: ahora,
  }).eq('id', uid);
  if (errBorrar) {
    logger.error(`[BORRADO] No se pudo anonimizar el perfil ${uid}: ${errBorrar.message}`);
    return { ok: false, status: 500, error: `No se pudo borrar la cuenta: ${errBorrar.message}`, errorCode: 'PROFILE_NOT_DELETED' };
  }

  // Sin esto la solicitud reaparece en el panel como un valet sin cuenta.
  if (tipo === 'valet' && perfil.email) {
    await supabaseAdmin.from('valet_applications').delete().ilike('email', String(perfil.email));
  }

  // Bloqueado y con otro correo: no puede entrar y su correo queda libre para
  // una cuenta nueva. El perfil ya no tiene datos aunque esto fallara.
  const { error: errAuth } = await supabaseAdmin.auth.admin.updateUserById(uid, {
    email: `deleted+${uid}@deleted.urbont.com`,
    ban_duration: '876000h',
    user_metadata: { deleted_at: ahora },
  });
  if (errAuth) logger.warn(`[BORRADO] Perfil ${uid} anonimizado, pero no se pudo bloquear su usuario de Auth: ${errMsg(errAuth)}`);

  return {
    ok: true,
    email: (perfil.email as string | null) ?? null,
    nombre: [perfil.first_name, perfil.last_name].filter(Boolean).join(' ') || String(perfil.email ?? uid),
  };
}

/** Elimina la cuenta, su perfil y sus viajes (solo cancelados o sin cobrar). */
export async function borrarCuentaDefinitiva(uid: string, tipo: Tipo): Promise<ResultadoBorrado> {
  const { data: perfil, error: errPerfil } = await supabaseAdmin
    .from('profiles').select('id, email, first_name, last_name, role').eq('id', uid).maybeSingle();
  if (errPerfil) throw errPerfil;
  if (!perfil || !ROLES[tipo].includes(String(perfil.role))) {
    return { ok: false, status: 404, error: tipo === 'valet' ? 'Valet no encontrado.' : 'Pasajero no encontrado.', errorCode: 'NOT_FOUND' };
  }

  const filtro = tipo === 'valet' ? `valet_user_id.eq.${uid},passenger_id.eq.${uid}` : `passenger_id.eq.${uid}`;
  const { data: viajes, error: errViajes } = await supabaseAdmin
    .from('rides').select('id, ride_status, payment_status').or(filtro);
  if (errViajes) throw errViajes;

  const lista = (viajes ?? []) as { id: string; ride_status: string | null; payment_status: string | null }[];
  if (lista.some(v => (ESTADOS_ACTIVOS as readonly string[]).includes(String(v.ride_status)))) {
    return { ok: false, status: 409, error: 'Tiene un viaje activo o programado. Termínalo o cancélalo antes de borrar la cuenta.', errorCode: 'ACTIVE_RIDES' };
  }
  const conHistorial = lista.filter(v => v.ride_status === 'completed' || v.payment_status === 'paid').length;
  if (conHistorial > 0) {
    return {
      ok: false, status: 409,
      error: `Tiene ${conHistorial} viaje(s) completados o pagados, que son contabilidad y ganancias de choferes. Usa el borrado lógico.`,
      errorCode: 'HAS_COMPLETED_RIDES',
    };
  }

  if (lista.length > 0) {
    const { error } = await supabaseAdmin.from('rides').delete().in('id', lista.map(v => v.id));
    if (error) {
      logger.error(`[BORRADO] No se pudieron borrar los viajes de ${uid}: ${error.message}`);
      return { ok: false, status: 409, error: `No se pudieron borrar sus viajes: ${error.message}`, errorCode: 'RIDES_NOT_DELETED' };
    }
  }

  if (tipo === 'valet' && perfil.email) {
    await supabaseAdmin.from('valet_applications').delete().ilike('email', String(perfil.email));
  }

  // El perfil cuelga del usuario de Auth en cascada: borrar éste borra los dos.
  const { error: errAuth } = await supabaseAdmin.auth.admin.deleteUser(uid);
  if (errAuth && !/not.?found/i.test(errAuth.message)) {
    logger.error(`[BORRADO] No se pudo eliminar ${uid}: ${errAuth.message}`);
    return { ok: false, status: 409, error: `No se pudo eliminar la cuenta: ${errAuth.message}`, errorCode: 'ACCOUNT_NOT_DELETED' };
  }
  // Si el usuario de Auth ya no existía, el perfil puede haber quedado suelto.
  await supabaseAdmin.from('profiles').delete().eq('id', uid);

  return {
    ok: true,
    email: (perfil.email as string | null) ?? null,
    nombre: [perfil.first_name, perfil.last_name].filter(Boolean).join(' ') || String(perfil.email ?? uid),
  };
}
