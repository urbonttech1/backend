/**
 * Borrado de cuentas de pasajeros, valets y conductores desde el panel. Dos modos:
 *
 * - `borrarCuenta` (lógico): el perfil se queda sin datos personales y marcado
 *   'deleted', el usuario de Auth se bloquea y libera su correo, y los viajes
 *   siguen apuntando a ese perfil.
 * - `borrarCuentaDefinitiva`: la cuenta deja de existir (Auth, perfil,
 *   documentos y archivos). Sus viajes se conservan sin dueño, porque son
 *   contabilidad y ganancias de otros conductores.
 *
 * Por qué los viajes no se borran con la cuenta: `rides.passenger_id` es
 * NOT NULL en producción con ON DELETE SET NULL, así que borrar el perfil de
 * quien tiene viajes falla. Antes de borrarlo, sus viajes como pasajero pasan a
 * DUENO_BORRADO, un perfil fijo sin datos; como conductor o valet la propia
 * clave foránea los deja en NULL.
 */
import { supabaseAdmin } from '../db/client';
import { pool } from '../db/pool';
import { logger } from '../lib/logger';

export const ESTADOS_ACTIVOS = ['scheduled', 'searching', 'confirmed', 'driver_arrived', 'in_progress'] as const;

export const CUENTA_BORRADA = 'deleted';

/** Dueño de los viajes de las cuentas borradas definitivamente. */
export const DUENO_BORRADO = '00000000-0000-0000-0000-00000000dead';

const NOMBRE_BORRADO = 'Deleted User';

export type ResultadoBorrado =
  /** `nombre` cae al correo o al id para la auditoría; `persona` es sólo el nombre real, para el saludo del aviso. */
  | { ok: true; email: string | null; nombre: string; persona: string }
  | { ok: false; status: number; error: string; errorCode: string };

export type Tipo = 'passenger' | 'valet' | 'chauffeur';

export const ROLES: Record<Tipo, string[]> = {
  passenger: ['passenger'],
  valet: ['valet', 'frontdesk', 'concierge'],
  chauffeur: ['chauffeur', 'driver'],
};

const NO_ENCONTRADO: Record<Tipo, string> = {
  passenger: 'Pasajero no encontrado.',
  valet: 'Valet no encontrado.',
  chauffeur: 'Conductor no encontrado.',
};

/** Tablas sin clave foránea a `profiles` que guardan datos de la persona. */
const DATOS_PERSONALES: { tabla: string; columna: string }[] = [
  { tabla: 'saved_places', columna: 'user_id' },
  { tabla: 'notifications', columna: 'user_id' },
  { tabla: 'corporate_members', columna: 'user_id' },
  { tabla: 'preferred_drivers', columna: 'passenger_id' },
  { tabla: 'preferred_drivers', columna: 'driver_id' },
  { tabla: 'driver_documents', columna: 'driver_id' },
  { tabla: 'driver_streaks', columna: 'driver_id' },
  { tabla: 'driver_quest_progress', columna: 'driver_id' },
];

/** Carpetas `<uid>/` en Storage: documentos y fotos de perfil o del vehículo. */
const BUCKETS = ['chauffeur-docs', 'avatars'];

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function filtroViajes(uid: string, tipo: Tipo): string {
  if (tipo === 'valet') return `valet_user_id.eq.${uid},passenger_id.eq.${uid}`;
  if (tipo === 'chauffeur') return `driver_id.eq.${uid}`;
  return `passenger_id.eq.${uid}`;
}

function personaDe(perfil: Record<string, unknown>): string {
  return [perfil.first_name, perfil.last_name].filter(Boolean).join(' ');
}

function resultado(perfil: Record<string, unknown>, uid: string): ResultadoBorrado {
  const persona = personaDe(perfil);
  return { ok: true, email: (perfil.email as string | null) ?? null, nombre: persona || String(perfil.email ?? uid), persona };
}

/** Perfil a borrar, o el error que hay que devolver. */
async function validar(
  uid: string, tipo: Tipo, { permitirBorrado }: { permitirBorrado: boolean },
): Promise<{ perfil: Record<string, unknown> } | Extract<ResultadoBorrado, { ok: false }>> {
  const noEncontrado = { ok: false as const, status: 404, error: NO_ENCONTRADO[tipo], errorCode: 'NOT_FOUND' };
  if (uid === DUENO_BORRADO) return noEncontrado;

  const { data: perfil, error: errPerfil } = await supabaseAdmin
    .from('profiles').select('id, email, first_name, last_name, role, account_status').eq('id', uid).maybeSingle();
  if (errPerfil) throw errPerfil;
  if (!perfil || !ROLES[tipo].includes(String(perfil.role))) return noEncontrado;
  if (!permitirBorrado && perfil.account_status === CUENTA_BORRADA) return noEncontrado;

  // Un viaje en curso perdería a su pasajero, su valet o su conductor a mitad de camino.
  const { count, error: errActivos } = await supabaseAdmin
    .from('rides').select('id', { count: 'exact', head: true })
    .or(filtroViajes(uid, tipo)).in('ride_status', [...ESTADOS_ACTIVOS]);
  if (errActivos) throw errActivos;
  if ((count ?? 0) > 0) {
    return { ok: false, status: 409, error: 'Tiene un viaje activo o programado. Márcalo para cancelarlo al borrar, o termínalo antes.', errorCode: 'ACTIVE_RIDES' };
  }
  return { perfil: perfil as Record<string, unknown> };
}

export async function borrarCuenta(uid: string, tipo: Tipo): Promise<ResultadoBorrado> {
  const v = await validar(uid, tipo, { permitirBorrado: false });
  if ('ok' in v) return v;
  const { perfil } = v;
  const ahora = new Date().toISOString();

  // Los viajes conservan sus ids (contabilidad), pero no el nombre.
  const { error: errViajes } = await supabaseAdmin.from('rides')
    .update({ passenger_name: NOMBRE_BORRADO }).eq('passenger_id', uid);
  if (errViajes) throw errViajes;
  if (tipo === 'chauffeur') {
    const { error } = await supabaseAdmin.from('rides').update({ driver_name: NOMBRE_BORRADO }).eq('driver_id', uid);
    if (error) throw error;
  }

  const { error: errBorrar } = await supabaseAdmin.from('profiles').update({
    first_name: 'Deleted',
    last_name: 'User',
    email: null,
    phone: null,
    avatar_url: null,
    business_name: null,
    account_status: CUENTA_BORRADA,
    updated_at: ahora,
  }).eq('id', uid);
  if (errBorrar) {
    logger.error(`[BORRADO] No se pudo anonimizar el perfil ${uid}: ${errBorrar.message}`);
    return { ok: false, status: 500, error: `No se pudo borrar la cuenta: ${errBorrar.message}`, errorCode: 'PROFILE_NOT_DELETED' };
  }

  // Desconectado: si no, el despacho le seguiría ofreciendo viajes.
  if (tipo === 'chauffeur') {
    await supabaseAdmin.from('driver_locations').update({ is_online: false }).eq('driver_id', uid);
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

  return resultado(perfil, uid);
}

/**
 * La cuenta deja de existir; sus viajes se quedan sin dueño. También sirve para
 * terminar de borrar una cuenta que ya tuvo el borrado lógico.
 */
export async function borrarCuentaDefinitiva(uid: string, tipo: Tipo): Promise<ResultadoBorrado> {
  const v = await validar(uid, tipo, { permitirBorrado: true });
  if ('ok' in v) return v;
  const { perfil } = v;

  // Auth primero: si falla no se ha tocado nada. Si después falla la base, el
  // panel puede reintentar, porque un usuario de Auth que ya no existe se ignora.
  const { error: errAuth } = await supabaseAdmin.auth.admin.deleteUser(uid);
  if (errAuth && !/not.?found/i.test(errAuth.message)) {
    logger.error(`[BORRADO] No se pudo eliminar el usuario de Auth ${uid}: ${errAuth.message}`);
    return { ok: false, status: 409, error: `No se pudo eliminar la cuenta: ${errAuth.message}`, errorCode: 'ACCOUNT_NOT_DELETED' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO profiles (id, role, first_name, last_name, account_status)
       VALUES ($1, 'deleted', 'Deleted', 'User', $2) ON CONFLICT (id) DO NOTHING`,
      [DUENO_BORRADO, CUENTA_BORRADA],
    );
    await client.query(
      `UPDATE rides SET passenger_id = $2, passenger_name = $3 WHERE passenger_id = $1`,
      [uid, DUENO_BORRADO, NOMBRE_BORRADO],
    );
    // driver_id y valet_user_id los deja en NULL la clave foránea; el nombre no.
    await client.query(`UPDATE rides SET driver_name = $2 WHERE driver_id = $1`, [uid, NOMBRE_BORRADO]);
    for (const { tabla, columna } of DATOS_PERSONALES) {
      await client.query(`DELETE FROM ${tabla} WHERE ${columna} = $1`, [uid]);
    }
    // Las tablas con clave foránea a profiles se limpian solas (CASCADE / SET NULL).
    await client.query(`DELETE FROM profiles WHERE id = $1`, [uid]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error(`[BORRADO] No se pudo eliminar el perfil ${uid}: ${errMsg(e)}`);
    return { ok: false, status: 409, error: `No se pudo eliminar la cuenta: ${errMsg(e)}`, errorCode: 'ACCOUNT_NOT_DELETED' };
  } finally {
    client.release();
  }

  if (tipo === 'valet' && perfil.email) {
    await supabaseAdmin.from('valet_applications').delete().ilike('email', String(perfil.email));
  }

  // Archivos: la cuenta ya está borrada, así que un fallo aquí sólo se registra.
  for (const bucket of BUCKETS) {
    try {
      const { data: archivos } = await supabaseAdmin.storage.from(bucket).list(uid, { limit: 1000 });
      const rutas = (archivos ?? []).map(a => `${uid}/${a.name}`);
      if (rutas.length) await supabaseAdmin.storage.from(bucket).remove(rutas);
    } catch (e) {
      logger.warn(`[BORRADO] Cuenta ${uid} eliminada, pero quedaron archivos en ${bucket}: ${errMsg(e)}`);
    }
  }

  return resultado(perfil, uid);
}
