/**
 * Verificación de conductores — fuente única de verdad.
 *
 * Antes, `profiles.verification_status` se escribía desde cinco lugares con
 * criterios distintos: dos de ellos marcaban `pending_review` sin comprobar
 * nada, y el de admin contaba filas en vez de tipos de documento. El resultado
 * era que el perfil, `background_check` y `driver_documents` se contradecían
 * entre sí, y un conductor con los once documentos revisados podía quedar sin
 * aprobar para siempre.
 *
 * Todo el que necesite cambiar ese campo debe pasar por `recalcularVerificacion`.
 */

import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';

/* ── Catálogo de documentos ────────────────────────────────────────────────
 *
 * Las listas, los metadatos y la normalización de estados viven en
 * `docCatalog.ts`, que no importa nada y por eso se puede probar sin base ni
 * variables de entorno. Se re-exportan aquí para que quien ya importaba desde
 * este módulo no tenga que cambiar nada.
 */
import {
  REQUIRED_DOC_KEYS,
  LEGACY_DOC_KEYS,
  WEB_DOC_KEYS,
  normalizarEstadoDoc,
  type DocKey,
  type VerificationStatus,
} from './docCatalog';

export {
  REQUIRED_DOC_KEYS,
  LEGACY_DOC_KEYS,
  WEB_DOC_KEYS,
  ACCEPTED_DOC_KEYS,
  DOC_CATALOG,
  docMeta,
  normalizarEstadoDoc,
} from './docCatalog';
export type { DocKey, DocMeta, VerificationStatus } from './docCatalog';

export interface EstadoVerificacion {
  status: VerificationStatus;
  /** Tipos requeridos que el conductor nunca subió. */
  missingDocs: DocKey[];
  /** Tipos requeridos rechazados por el admin. */
  rejectedDocs: DocKey[];
  /** Tipos requeridos subidos pero aún sin revisar. */
  pendingDocs: DocKey[];
  hasVehicle: boolean;
  reason: string | null;
}

/** Un vehículo cuenta como cargado cuando el JSONB trae algo. */
function tieneVehiculo(vehicle: unknown): boolean {
  return vehicle != null && Object.keys(vehicle as Record<string, unknown>).length > 0;
}

/**
 * Calcula el estado de verificación de un conductor a partir de sus documentos
 * y su vehículo, y lo persiste. Es la única función que debe escribir
 * `verification_status`.
 *
 * Nunca lanza: un fallo al recalcular no debe tumbar la petición que la invocó.
 */
export async function recalcularVerificacion(driverId: string): Promise<EstadoVerificacion> {
  const vacio: EstadoVerificacion = {
    status: 'pending_documents',
    missingDocs: [...REQUIRED_DOC_KEYS] as DocKey[],
    rejectedDocs: [],
    pendingDocs: [],
    hasVehicle: false,
    reason: 'No se pudo verificar el estado del conductor.',
  };

  try {
    const [perfilRes, docsRes] = await Promise.all([
      supabaseAdmin.from('profiles').select('vehicle').eq('id', driverId).maybeSingle(),
      supabaseAdmin.from('driver_documents').select('doc_key, status').eq('driver_id', driverId),
    ]);

    if (docsRes.error) {
      logger.error(`[VERIFICACION] No se pudieron leer los documentos de ${driverId}: ${docsRes.error.message}`);
      return vacio;
    }

    const hasVehicle = tieneVehiculo(perfilRes.data?.vehicle);

    // Un mismo tipo puede tener varias filas si el conductor volvió a subirlo:
    // se queda el estado más favorable, que es el que refleja la última carga
    // aceptada.
    const porTipo = new Map<string, 'aprobado' | 'rechazado' | 'pendiente'>();
    for (const fila of (docsRes.data ?? []) as Record<string, unknown>[]) {
      const key = String(fila.doc_key);
      const estado = normalizarEstadoDoc(fila.status);
      const previo = porTipo.get(key);
      if (previo === 'aprobado') continue;
      if (previo === 'pendiente' && estado === 'rechazado') continue;
      porTipo.set(key, estado);
    }

    // Se evalúa contra el esquema que el conductor haya empezado. Sin esto, los
    // que completaron un esquema aparecerían con todo faltando al medirlos
    // contra otro, porque las listas sólo comparten una parte de los nombres.
    //
    // Se compara por PROPORCIÓN cubierta, no por número de claves. Contando
    // claves, un conductor con el esquema de limusina completo (11 de 11)
    // empataba con las 11 que ese mismo esquema cubre del web, y al desempatar
    // hacia el web le aparecían seis documentos faltantes: conductores ya
    // aprobados volvían a `pending_documents`. La proporción da 1.0 al esquema
    // que sí completó. A igualdad de proporción gana el que cubre más claves,
    // que es el esquema más específico de los dos.
    const cubiertos = (lista: readonly string[]) => lista.filter(k => porTipo.has(k)).length;
    const esquema: readonly string[] = [WEB_DOC_KEYS, REQUIRED_DOC_KEYS, LEGACY_DOC_KEYS]
      .map(lista => ({ lista, n: cubiertos(lista) }))
      .sort((a, b) => (b.n / b.lista.length) - (a.n / a.lista.length) || b.n - a.n)[0].lista;

    const missingDocs  = esquema.filter(k => !porTipo.has(k)) as DocKey[];
    const rejectedDocs = esquema.filter(k => porTipo.get(k) === 'rechazado') as DocKey[];
    const pendingDocs  = esquema.filter(k => porTipo.get(k) === 'pendiente') as DocKey[];

    let status: VerificationStatus;
    let reason: string | null = null;

    if (rejectedDocs.length > 0) {
      status = 'rejected';
      reason = `Documentos rechazados: ${rejectedDocs.join(', ')}. Vuelve a subirlos.`;
    } else if (missingDocs.length > 0) {
      status = 'pending_documents';
      reason = `Faltan documentos: ${missingDocs.join(', ')}.`;
    } else if (pendingDocs.length > 0) {
      status = 'pending_review';
    } else if (!hasVehicle) {
      // Los papeles están completos pero sin vehículo no puede operar, así que
      // no se aprueba: aprobar aquí era lo que dejaba conductores habilitados
      // sin auto registrado.
      status = 'pending_documents';
      reason = 'Falta registrar el vehículo.';
    } else {
      status = 'approved';
    }

    const { error: updErr } = await supabaseAdmin
      .from('profiles')
      .update({
        verification_status: status,
        rejection_reason: reason,
        updated_at: new Date().toISOString(),
      })
      .eq('id', driverId);

    if (updErr) {
      logger.error(`[VERIFICACION] No se pudo guardar el estado de ${driverId}: ${updErr.message}`);
    } else {
      logger.info(`[VERIFICACION] ${driverId} → ${status} (faltan ${missingDocs.length}, rechazados ${rejectedDocs.length}, vehículo ${hasVehicle ? 'sí' : 'no'})`);
    }

    return { status, missingDocs, rejectedDocs, pendingDocs, hasVehicle, reason };
  } catch (err) {
    logger.error(`[VERIFICACION] Error recalculando ${driverId}: ${(err as Error)?.message}`);
    return vacio;
  }
}

export interface PermisoOperar {
  ok: boolean;
  reason: string | null;
  code: 'NOT_APPROVED' | 'NO_VEHICLE' | null;
}

/**
 * Comprueba si un conductor puede ponerse en línea. Se consulta contra el
 * estado guardado, no se recalcula: el recálculo ocurre cuando cambian sus
 * documentos o su vehículo.
 */
export async function puedeOperar(driverId: string): Promise<PermisoOperar> {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('verification_status, vehicle')
    .eq('id', driverId)
    .maybeSingle();

  // Ante un fallo de lectura no se bloquea al conductor: dejarlo sin trabajar
  // por un error nuestro es peor que el riesgo que cubre esta comprobación.
  if (error || !data) {
    logger.warn(`[VERIFICACION] No se pudo comprobar el permiso de ${driverId}: ${error?.message ?? 'perfil no encontrado'}`);
    return { ok: true, reason: null, code: null };
  }

  if (!tieneVehiculo(data.vehicle)) {
    return { ok: false, reason: 'Debes registrar tu vehículo antes de conectarte.', code: 'NO_VEHICLE' };
  }
  if (data.verification_status !== 'approved') {
    return { ok: false, reason: 'Tu cuenta aún no está aprobada.', code: 'NOT_APPROVED' };
  }
  return { ok: true, reason: null, code: null };
}
