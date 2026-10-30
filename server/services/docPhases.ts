/**
 * El alta del conductor en dos fases: qué puede subir y cuándo se le avisa.
 *
 * Las reglas puras están en `docCatalog.ts` (`estadoDeFases`). Aquí vive lo que
 * necesita base de datos: leer en qué punto está un conductor, y avisarle por
 * correo y por push la primera vez que su fase 1 queda aprobada.
 *
 * Nada de esto lanza. Si falla la lectura se responde la fase 1 desbloqueada,
 * que es como se comportaba el alta antes de que existieran las fases: es
 * preferible dejar subir de más a dejar a un conductor sin poder avanzar.
 */
import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';
import {
  documentosDeLaFase, estadoDeFases, normalizarEstadoDoc,
  type DocumentoCatalogo, type EstadoDeFases, type EstadoDoc,
} from './docCatalog';
import { documentosVigentes } from './docCatalogStore';
import { notifyUser } from './fcm';
import { driverNotif } from './notificationTemplates';
import { enviarAvisoFase1Aprobada } from './accountEmails';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/** Sin fases que aplicar: todo accesible. El alta de siempre. */
const TODO_ABIERTO: EstadoDeFases = {
  fase: 2, desbloqueada: true, motivo: 'sin_fase_2',
  faltanFase1: [], pendientesFase1: [], bloqueados: [],
};

/** El estado de cada documento del conductor, el más favorable si hay repetidos. */
export async function estadosDeSusDocumentos(driverId: string): Promise<Map<string, EstadoDoc>> {
  const porTipo = new Map<string, EstadoDoc>();
  const { data, error } = await supabaseAdmin
    .from('driver_documents').select('doc_key, status').eq('driver_id', driverId);
  if (error) throw error;
  for (const fila of (data ?? []) as Array<{ doc_key: string; status: unknown }>) {
    const key = String(fila.doc_key);
    const estado = normalizarEstadoDoc(fila.status);
    const previo = porTipo.get(key);
    if (previo === 'aprobado') continue;
    if (previo === 'pendiente' && estado === 'rechazado') continue;
    porTipo.set(key, estado);
  }
  return porTipo;
}

export interface FasesDelConductor {
  fases: EstadoDeFases;
  /** Los activos del catálogo, de las dos fases. */
  activos: DocumentoCatalogo[];
  /** Los que puede subir ahora mismo. */
  disponibles: DocumentoCatalogo[];
}

/** En qué punto del alta está un conductor. Nunca lanza. */
export async function fasesDelConductor(driverId: string, role?: string | null): Promise<FasesDelConductor> {
  try {
    const [activos, estados] = await Promise.all([
      documentosVigentes(role),
      estadosDeSusDocumentos(driverId),
    ]);
    const fases = estadoDeFases(activos, estados);
    return { fases, activos, disponibles: documentosDeLaFase(activos, fases) };
  } catch (err) {
    logger.warn(`[FASES] No se pudo calcular la fase de ${driverId}: ${errMsg(err)}`);
    return { fases: TODO_ABIERTO, activos: [], disponibles: [] };
  }
}

/**
 * Si el conductor todavía no puede subir este documento, devuelve el cuerpo del
 * error; si puede, `null`. Un documento que no está en el catálogo activo no se
 * bloquea aquí: de eso se encarga la validación de clave de cada ruta.
 */
export async function bloqueoDeFase(
  driverId: string,
  role: string | null | undefined,
  docKey: string,
): Promise<{ error: string; errorCode: 'PHASE_LOCKED'; docKey: string; phase: 1; missingPhase1: string[] } | null> {
  const { fases } = await fasesDelConductor(driverId, role);
  if (!fases.bloqueados.includes(docKey)) return null;
  return {
    error: 'This document belongs to the second step. We will ask for it once your first documents are approved.',
    errorCode: 'PHASE_LOCKED',
    docKey,
    phase: 1,
    missingPhase1: [...fases.faltanFase1],
  };
}

/**
 * El aviso de que la fase 1 quedó aprobada: correo y push, una sola vez.
 *
 * El sello `profiles.docs_phase1_notified_at` es lo que lo hace idempotente —se
 * llama desde cada aprobación de documento, y sólo la que completa la fase
 * dispara el aviso—. Se sella ANTES de enviar: si el correo falla, es mejor que
 * no salga a que salga repetido cada vez que el admin toque otro documento.
 */
export async function avisarFase1Aprobada(driverId: string): Promise<boolean> {
  try {
    const { fases } = await fasesDelConductor(driverId);
    // Sólo cuando de verdad se acaba de abrir la fase 2 por aprobación.
    if (fases.motivo !== 'fase_1_aprobada') return false;

    const { data: perfil } = await supabaseAdmin
      .from('profiles')
      .select('first_name, last_name, email, docs_phase1_notified_at')
      .eq('id', driverId)
      .maybeSingle();
    const p = perfil as {
      first_name?: string; last_name?: string; email?: string; docs_phase1_notified_at?: string | null;
    } | null;
    if (!p || p.docs_phase1_notified_at) return false;

    const { error: sello } = await supabaseAdmin
      .from('profiles')
      .update({ docs_phase1_notified_at: new Date().toISOString() })
      .eq('id', driverId)
      .is('docs_phase1_notified_at', null);
    if (sello) {
      logger.warn(`[FASES] No se pudo sellar el aviso de ${driverId}: ${sello.message}`);
      return false;
    }

    const nombre = [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || null;
    void notifyUser(driverId, driverNotif.docsPhase1Approved()).catch(() => {});
    if (p.email) {
      void enviarAvisoFase1Aprobada({ email: p.email, name: nombre })
        .catch((err: unknown) => logger.warn(`[FASES] Correo de fase 1 a ${driverId}: ${errMsg(err)}`));
    }
    logger.info(`[FASES] ${driverId}: fase 1 aprobada — avisado por push${p.email ? ' y correo' : ''}.`);
    return true;
  } catch (err) {
    // Un fallo aquí no puede tumbar la aprobación del documento.
    logger.error(`[FASES] No se pudo avisar a ${driverId}: ${errMsg(err)}`);
    return false;
  }
}
