/**
 * Consultas de la revisión de limpieza. Las reglas están en `vehicleInspection.ts`.
 */
import { pool } from '../db/pool';
import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';
import { esRolValet } from './docCatalog';
import { notifyUser } from './fcm';
import { driverNotif } from './notificationTemplates';
import { estadoRevision, type EstadoRevision, type UltimaInspeccion } from './vehicleInspection';

export const BUCKET_INSPECCIONES = 'vehicle-inspections';

/** Desde cuándo se exige la revisión. Lo escribe la migración al activarla. */
export async function inicioDeRevisiones(): Promise<Date> {
  const { rows } = await pool.query<{ value: string }>(
    `SELECT value FROM app_config WHERE key = 'vehicle_inspection_start'`,
  );
  const fecha = rows[0] ? new Date(rows[0].value) : null;
  return fecha && Number.isFinite(fecha.getTime()) ? fecha : new Date();
}

export async function ultimaInspeccion(driverId: string): Promise<UltimaInspeccion | null> {
  const { rows } = await pool.query<{ status: UltimaInspeccion['status']; submitted_at: Date | null; rejection_reason: string | null }>(
    `SELECT status, submitted_at, rejection_reason
       FROM vehicle_inspections
      WHERE driver_id = $1 AND status IN ('submitted', 'approved', 'rejected')
      ORDER BY submitted_at DESC NULLS LAST
      LIMIT 1`,
    [driverId],
  );
  const r = rows[0];
  return r ? { status: r.status, submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null, rejectionReason: r.rejection_reason } : null;
}

export async function revisionDelChofer(driverId: string, ahora = new Date()): Promise<EstadoRevision> {
  const [ultima, inicio] = await Promise.all([ultimaInspeccion(driverId), inicioDeRevisiones()]);
  return estadoRevision(ultima, inicio, ahora);
}

/**
 * Desconecta al chofer si está conectado y no tiene un viaje en curso, para que
 * deje de recibir ofertas. Un viaje empezado nunca se corta. Devuelve si estaba
 * conectado y se lo desconectó.
 */
export async function desconectarSiEstaLibre(driverId: string): Promise<boolean> {
  const { rows } = await pool.query<{ desconectado: string }>(
    `UPDATE driver_locations dl
        SET is_online = false, updated_at = NOW()
      WHERE dl.driver_id = $1
        AND dl.is_online = true
        AND NOT EXISTS (
          SELECT 1 FROM rides r
           WHERE r.driver_id = $1 AND r.ride_status IN ('confirmed', 'driver_arrived', 'in_progress')
        )
      RETURNING dl.driver_id AS desconectado`,
    [driverId],
  );
  if (rows.length === 0) return false;
  await pool.query(`UPDATE profiles SET status_val = 'offline', updated_at = NOW() WHERE id = $1`, [driverId]);
  return true;
}

/**
 * Lo que corre el cron cada 15 minutos sobre los choferes aprobados:
 * - a quien le vence en menos de 4 h, un aviso (uno por plazo);
 * - a quien ya le venció y sigue conectado sin viaje, se lo desconecta y se le
 *   avisa. Si se reconecta con una app vieja que no conoce la revisión, igual
 *   no podrá aceptar viajes: eso lo frena el servidor al aceptar.
 */
export async function revisarVencimientos(ahora = new Date()): Promise<{ avisados: number; desconectados: number }> {
  const inicio = await inicioDeRevisiones();
  const { rows } = await pool.query<{
    id: string; role: string | null; reminded_for: Date | null;
    status: UltimaInspeccion['status'] | null; submitted_at: Date | null; rejection_reason: string | null;
    is_online: boolean | null;
  }>(
    `SELECT p.id, p.role, p.inspection_reminded_for AS reminded_for,
            li.status, li.submitted_at, li.rejection_reason,
            dl.is_online
       FROM profiles p
       LEFT JOIN LATERAL (
         SELECT v.status, v.submitted_at, v.rejection_reason
           FROM vehicle_inspections v
          WHERE v.driver_id = p.id AND v.status IN ('submitted', 'approved', 'rejected')
          ORDER BY v.submitted_at DESC NULLS LAST
          LIMIT 1
       ) li ON true
       LEFT JOIN driver_locations dl ON dl.driver_id = p.id
      WHERE p.role IN ('driver', 'chauffeur') AND p.verification_status = 'approved'`,
  );

  let avisados = 0;
  let desconectados = 0;
  for (const r of rows) {
    if (esRolValet(r.role)) continue;
    const ultima = r.status
      ? { status: r.status, submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null, rejectionReason: r.rejection_reason }
      : null;
    const estado = estadoRevision(ultima, inicio, ahora);

    if (estado.situacion === 'due_soon') {
      const yaAvisado = r.reminded_for && new Date(r.reminded_for).getTime() === estado.venceEl.getTime();
      if (yaAvisado) continue;
      await pool.query(`UPDATE profiles SET inspection_reminded_for = $2 WHERE id = $1`, [r.id, estado.venceEl]);
      notifyUser(r.id, driverNotif.inspectionDueSoon(estado.venceEl.toISOString())).catch(() => {});
      avisados += 1;
    } else if (!estado.habilitado && r.is_online) {
      if (await desconectarSiEstaLibre(r.id)) {
        notifyUser(r.id, driverNotif.inspectionRequired()).catch(() => {});
        desconectados += 1;
      }
    }
  }
  return { avisados, desconectados };
}

/**
 * Si el chofer puede aceptar o reservar viajes. Al valet no se le exige: no
 * tiene auto propio. Ante un fallo de lectura no se bloquea, igual que en
 * `puedeOperar`: dejarlo sin trabajar por un error nuestro es peor.
 */
export async function bloqueoPorRevision(driverId: string): Promise<{ bloqueado: false } | { bloqueado: true; reason: string; code: 'INSPECTION_DUE' }> {
  try {
    const { data } = await supabaseAdmin.from('profiles').select('role').eq('id', driverId).maybeSingle();
    if (esRolValet(data?.role as string | undefined)) return { bloqueado: false };
    const estado = await revisionDelChofer(driverId);
    if (estado.habilitado) return { bloqueado: false };
    return {
      bloqueado: true,
      code: 'INSPECTION_DUE',
      reason: estado.situacion === 'rejected'
        ? 'Your vehicle photos were rejected. Take new ones to keep accepting rides.'
        : 'Your vehicle cleanliness check is due. Take the photos to keep accepting rides.',
    };
  } catch (err: unknown) {
    logger.warn(`[INSPECCION] No se pudo comprobar la revisión de ${driverId}: ${err instanceof Error ? err.message : String(err)}`);
    return { bloqueado: false };
  }
}
