/**
 * Las cuentas eliminadas, para el panel.
 *
 * Las listas de pasajeros, conductores y valets las ocultan, el borrado lógico
 * deja el perfil sin nombre ni correo ("Deleted User") y el definitivo ni
 * siquiera deja perfil, así que no había forma de saber a quién se había
 * borrado. Quién era sale del registro de auditoría (`audit_logs`), que guarda
 * nombre y correo al borrar: desde ahora con el id entre corchetes, y para los
 * borrados lógicos anteriores se empareja el perfil por la hora.
 */
import { pool } from '../db/pool';
import { DUENO_BORRADO, ROLES, type Tipo } from './accountDeletion';

export interface CuentaEliminada {
  /** `null` en un borrado definitivo anterior a guardar el id. */
  id: string | null;
  rol: string | null;
  /** true: la cuenta ya no existe; sólo queda el registro. */
  definitivo: boolean;
  /** Cuándo se borró (la última escritura del perfil, que es el borrado). */
  borradaEl: string | null;
  /** Tal como estaba al borrarla, según la auditoría. */
  nombre: string | null;
  correo: string | null;
  borradaPor: string | null;
  /** Viajes que conserva; `null` si la cuenta ya no existe. */
  viajes: number | null;
}

export interface PerfilBorrado { id: string; role: string; updated_at: string | Date | null; viajes: number }
export interface RegistroBorrado { admin_name: string | null; action?: string | null; target: string | null; created_at: string | Date }

const ACCION: Record<Tipo, string> = { passenger: 'passenger.delete', chauffeur: 'driver.delete', valet: 'valet.delete' };

/** Un borrado anterior a guardar el id se empareja si está a menos de esto. */
export const VENTANA_MS = 5 * 60 * 1000;

const ms = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : NaN);

/** "Paulo Estrada (paulo@x.com) · 2 viaje(s) cancelados [uuid]" → nombre y correo. */
export function leerObjetivo(target: string | null | undefined): { nombre: string | null; correo: string | null; id: string | null } {
  const t = (target ?? '').trim();
  const id = /\[([0-9a-f-]{36})\]\s*$/i.exec(t)?.[1] ?? null;
  const sinId = t.replace(/\s*\[[0-9a-f-]{36}\]\s*$/i, '').replace(/\s*·.*$/, '');
  const correo = /\(([^()\s]+@[^()\s]+)\)\s*$/.exec(sinId)?.[1] ?? null;
  const nombre = sinId.replace(/\s*\([^()]*@[^()]*\)\s*$/, '').trim() || null;
  return { nombre, correo, id };
}

/**
 * Une cada perfil con borrado lógico con su registro de auditoría y añade los
 * borrados definitivos, que sólo existen en el registro. La más reciente
 * primero. Regla pura.
 */
export function emparejar(perfiles: readonly PerfilBorrado[], registros: readonly RegistroBorrado[]): CuentaEliminada[] {
  const usados = new Set<number>();
  const todos = registros.map(r => ({ ...r, ...leerObjetivo(r.target), hard: String(r.action ?? '').endsWith('.hard') }));
  // Un perfil que sigue existiendo sólo puede venir de un borrado lógico.
  const leidos = todos.map(r => (r.hard ? null : r));

  const logicos = perfiles.map(p => {
    let i = leidos.findIndex((r, j) => r !== null && !usados.has(j) && r.id === p.id);
    if (i < 0) {
      // Borrados de antes del id: el registro más cercano en el tiempo, si lo hay.
      const hora = ms(p.updated_at);
      let mejor = -1; let distancia = Infinity;
      leidos.forEach((r, j) => {
        if (!r || usados.has(j) || r.id) return;
        const d = Math.abs(ms(r.created_at) - hora);
        if (d <= VENTANA_MS && d < distancia) { mejor = j; distancia = d; }
      });
      i = mejor;
    }
    const r = i >= 0 ? leidos[i] : null;
    if (i >= 0) usados.add(i);
    return {
      id: p.id,
      rol: p.role,
      definitivo: false,
      borradaEl: p.updated_at ? new Date(p.updated_at).toISOString() : null,
      nombre: r?.nombre ?? null,
      correo: r?.correo ?? null,
      borradaPor: r?.admin_name ?? null,
      viajes: Number(p.viajes) || 0,
    } satisfies CuentaEliminada;
  });

  const definitivos: CuentaEliminada[] = todos.filter(r => r.hard).map(r => ({
    id: r.id,
    rol: null,
    definitivo: true,
    borradaEl: new Date(r.created_at).toISOString(),
    nombre: r.nombre,
    correo: r.correo,
    borradaPor: r.admin_name ?? null,
    viajes: null,
  }));

  return [...logicos, ...definitivos].sort((a, b) => ms(b.borradaEl) - ms(a.borradaEl));
}

const COLUMNA_VIAJES: Record<Tipo, string> = {
  passenger: 'r.passenger_id = p.id',
  chauffeur: 'r.driver_id = p.id',
  valet: '(r.valet_user_id = p.id OR r.passenger_id = p.id)',
};

/** Las cuentas de ese tipo eliminadas (lógicas y definitivas), la más reciente primero. */
export async function cuentasEliminadas(tipo: Tipo): Promise<CuentaEliminada[]> {
  const { rows: perfiles } = await pool.query<PerfilBorrado>(
    `SELECT p.id, p.role, p.updated_at,
            (SELECT COUNT(*)::int FROM rides r WHERE ${COLUMNA_VIAJES[tipo]}) AS viajes
       FROM profiles p
      WHERE p.account_status = 'deleted' AND p.id <> $1 AND p.role = ANY($2)
      ORDER BY p.updated_at DESC NULLS LAST`,
    [DUENO_BORRADO, ROLES[tipo]],
  );
  // `created_at` es un timestamp sin zona guardado en UTC: se manda como tal
  // para no depender de la zona horaria del proceso.
  const { rows: registros } = await pool.query<RegistroBorrado>(
    `SELECT admin_name, action, target,
            to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
       FROM audit_logs WHERE action IN ($1, $2) ORDER BY created_at DESC LIMIT 500`,
    [ACCION[tipo], `${ACCION[tipo]}.hard`],
  ).catch(() => ({ rows: [] as RegistroBorrado[] }));
  return emparejar(perfiles, registros);
}
