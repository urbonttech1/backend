import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { requireSupabaseAuth } from '../middleware';
import { requireAdminJWT } from './admin-auth';
import { supabaseAdmin } from '../db/client';
import { pool } from '../db/pool';
import { createContextLogger } from '../lib/logger';
import { notifyUser } from '../services/fcm';
import { driverNotif } from '../services/notificationTemplates';
import { huellaDeImagen } from '../services/imageHash';
import {
  FOTOS,
  FOTO_MAX_BYTES,
  MIMES,
  SESION_MINUTOS,
  compararConAnteriores,
  esFoto,
  fotosFaltantes,
  mimeInspeccion,
  sesionAbierta,
  validarOdometro,
} from '../services/vehicleInspection';
import {
  BUCKET_INSPECCIONES,
  desconectarSiEstaLibre,
  revisionDelChofer,
} from '../services/vehicleInspectionStore';

/**
 * Revisión de limpieza del vehículo. Reglas en `services/vehicleInspection.ts`.
 *
 * Montado en /api/vehicle-inspections (chofer) y
 * /api/admin/vehicle-inspections (panel).
 */
const log = createContextLogger('INSPECCION');

export const vehicleInspectionRouter = Router();
export const vehicleInspectionAdminRouter = Router();
vehicleInspectionAdminRouter.use(requireAdminJWT);

interface FotoGuardada {
  slot: string;
  path: string;
  mimeType: string;
  requestedAt: string;
  hash?: string;
  match?: ReturnType<typeof compararConAnteriores>;
}

type Fila = {
  id: string;
  driver_id: string;
  status: string;
  photos: FotoGuardada[] | null;
  flags: string[] | null;
  odometer: number | null;
  expires_at: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
  created_at: string;
};

/** Margen para el envío: la última foto puede terminar de subir justo al cerrar. */
const MARGEN_ENVIO_MS = 2 * 60 * 1000;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const esConductor = (req: Request) => req.supabaseRole === 'chauffeur' || req.supabaseRole === 'driver';
const fotosDe = (fila: Pick<Fila, 'photos'>): FotoGuardada[] => (Array.isArray(fila.photos) ? fila.photos : []);

let bucketListo = false;
async function asegurarBucket(): Promise<void> {
  if (bucketListo) return;
  const opciones = { public: false, fileSizeLimit: FOTO_MAX_BYTES, allowedMimeTypes: [...MIMES] };
  const { data } = await supabaseAdmin.storage.getBucket(BUCKET_INSPECCIONES);
  if (!data) {
    const { error } = await supabaseAdmin.storage.createBucket(BUCKET_INSPECCIONES, opciones);
    if (error && !/already exists/i.test(error.message)) throw error;
  } else if (data.public) {
    const { error } = await supabaseAdmin.storage.updateBucket(BUCKET_INSPECCIONES, opciones);
    if (error) throw error;
  }
  bucketListo = true;
}

async function leer(id: string): Promise<Fila | null> {
  const { data, error } = await supabaseAdmin.from('vehicle_inspections').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as Fila | null) ?? null;
}

/** La revisión `id` si es de este chofer y todavía está tomando fotos. */
async function sesionDelChofer(driverId: string, id: string) {
  const fila = await leer(id);
  if (!fila || fila.driver_id !== driverId) return { error: 'Inspection not found.', errorCode: 'NOT_FOUND', status: 404 as const };
  if (fila.status !== 'collecting') return { error: 'This inspection was already sent.', errorCode: 'WRONG_STATUS', status: 409 as const };
  return { fila };
}

async function estadoParaApp(driverId: string) {
  const ahora = new Date();
  const estado = await revisionDelChofer(driverId, ahora);
  const { data } = await supabaseAdmin
    .from('vehicle_inspections')
    .select('id, photos, expires_at')
    .eq('driver_id', driverId)
    .eq('status', 'collecting')
    .gt('expires_at', ahora.toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const abierta = data as Pick<Fila, 'id' | 'photos' | 'expires_at'> | null;
  return {
    status: estado.situacion,
    dueAt: estado.venceEl.toISOString(),
    canAcceptRides: estado.habilitado,
    rejectionReason: estado.rejectionReason,
    slots: FOTOS,
    sessionMinutes: SESION_MINUTOS,
    openSession: abierta
      ? { id: abierta.id, expiresAt: abierta.expires_at, taken: fotosDe(abierta).map((f) => f.slot) }
      : null,
  };
}

// ── Chofer ───────────────────────────────────────────────────────────────────

vehicleInspectionRouter.get('/status', requireSupabaseAuth, async (req: Request, res: Response) => {
  if (!esConductor(req)) return res.status(403).json({ error: 'Drivers only.', errorCode: 'ACCESS_DENIED' });
  try {
    return res.json(await estadoParaApp(req.supabaseUid!));
  } catch (err: unknown) {
    log.error({ err: errMsg(err) }, 'status failed');
    return res.status(500).json({ error: 'Could not load your vehicle check.' });
  }
});

/** Abre la sesión de 15 minutos. Cierra cualquier otra que quedara abierta. */
vehicleInspectionRouter.post('/start', requireSupabaseAuth, async (req: Request, res: Response) => {
  if (!esConductor(req)) return res.status(403).json({ error: 'Drivers only.', errorCode: 'ACCESS_DENIED' });
  const uid = req.supabaseUid!;
  const { lat, lng } = (req.body ?? {}) as { lat?: unknown; lng?: unknown };
  const coord = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  try {
    await supabaseAdmin.from('vehicle_inspections')
      .update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('driver_id', uid).eq('status', 'collecting');
    const expira = new Date(Date.now() + SESION_MINUTOS * 60_000);
    const { data, error } = await supabaseAdmin.from('vehicle_inspections').insert({
      driver_id: uid,
      status: 'collecting',
      expires_at: expira.toISOString(),
      lat: coord(lat),
      lng: coord(lng),
    }).select('id, expires_at').single();
    if (error) throw error;
    return res.status(201).json({ id: data.id, expiresAt: data.expires_at, slots: FOTOS });
  } catch (err: unknown) {
    log.error({ err: errMsg(err) }, 'start failed');
    return res.status(500).json({ error: 'Could not start the vehicle check.' });
  }
});

/**
 * URL firmada para subir una foto. Pedirla otra vez para la misma posición
 * reemplaza la anterior: el chofer puede repetir una foto que salió mal.
 */
vehicleInspectionRouter.post('/:id/photos', requireSupabaseAuth, async (req: Request, res: Response) => {
  if (!esConductor(req)) return res.status(403).json({ error: 'Drivers only.', errorCode: 'ACCESS_DENIED' });
  const uid = req.supabaseUid!;
  const { slot, mimeType } = (req.body ?? {}) as { slot?: unknown; mimeType?: unknown };
  if (!esFoto(slot)) return res.status(400).json({ error: 'Unknown photo position.', errorCode: 'INVALID_SLOT', field: 'slot' });
  const mime = mimeInspeccion(mimeType);
  if (!mime) return res.status(400).json({ error: 'Use a JPG, PNG or WebP photo.', errorCode: 'INVALID_MIME_TYPE', field: 'mimeType' });
  try {
    const ahora = new Date();
    const sesion = await sesionDelChofer(uid, req.params.id);
    if ('errorCode' in sesion) return res.status(sesion.status).json({ error: sesion.error, errorCode: sesion.errorCode });
    const { fila } = sesion;
    if (!sesionAbierta(new Date(fila.expires_at), ahora)) {
      await supabaseAdmin.from('vehicle_inspections').update({ status: 'expired', updated_at: ahora.toISOString() }).eq('id', fila.id).eq('status', 'collecting');
      return res.status(409).json({ error: `The ${SESION_MINUTOS}-minute window closed. Start again.`, errorCode: 'SESSION_EXPIRED' });
    }

    await asegurarBucket();
    const ext = mime.split('/')[1].replace('jpeg', 'jpg');
    // Sin subcarpetas: el borrado de cuenta lista sólo el primer nivel de <uid>/.
    const path = `${uid}/${fila.id}-${slot}-${randomUUID()}.${ext}`;
    const { data: firmada, error: firmarErr } = await supabaseAdmin.storage.from(BUCKET_INSPECCIONES).createSignedUploadUrl(path);
    if (firmarErr || !firmada) throw firmarErr ?? new Error('no signed upload url');

    const anteriores = fotosDe(fila);
    const reemplazada = anteriores.find((f) => f.slot === slot);
    const fotos = [...anteriores.filter((f) => f.slot !== slot), { slot, path, mimeType: mime, requestedAt: ahora.toISOString() }];
    const { error: anotarErr } = await supabaseAdmin.from('vehicle_inspections')
      .update({ photos: fotos, updated_at: ahora.toISOString() })
      .eq('id', fila.id).eq('status', 'collecting');
    if (anotarErr) throw anotarErr;
    if (reemplazada) void supabaseAdmin.storage.from(BUCKET_INSPECCIONES).remove([reemplazada.path]);

    return res.status(201).json({
      uploadUrl: firmada.signedUrl,
      method: 'PUT',
      headers: { 'Content-Type': mime },
      maxBytes: FOTO_MAX_BYTES,
      missing: fotosFaltantes(fotos),
    });
  } catch (err: unknown) {
    log.error({ err: errMsg(err) }, 'photo url failed');
    return res.status(500).json({ error: 'Could not prepare the photo upload.' });
  }
});

/**
 * Cierra la revisión. Comprueba que estén todas las fotos, el odómetro y que
 * ninguna foto sea una ya enviada antes. Si alguna lo es, se quita de la sesión
 * para que el chofer la repita mientras le quede tiempo.
 */
vehicleInspectionRouter.post('/:id/submit', requireSupabaseAuth, async (req: Request, res: Response) => {
  if (!esConductor(req)) return res.status(403).json({ error: 'Drivers only.', errorCode: 'ACCESS_DENIED' });
  const uid = req.supabaseUid!;
  try {
    const ahora = new Date();
    const sesion = await sesionDelChofer(uid, req.params.id);
    if ('errorCode' in sesion) return res.status(sesion.status).json({ error: sesion.error, errorCode: sesion.errorCode });
    const { fila } = sesion;
    if (ahora.getTime() > new Date(fila.expires_at).getTime() + MARGEN_ENVIO_MS) {
      await supabaseAdmin.from('vehicle_inspections').update({ status: 'expired', updated_at: ahora.toISOString() }).eq('id', fila.id).eq('status', 'collecting');
      return res.status(409).json({ error: `The ${SESION_MINUTOS}-minute window closed. Start again.`, errorCode: 'SESSION_EXPIRED' });
    }

    const fotos = fotosDe(fila);
    const faltan = fotosFaltantes(fotos);
    if (faltan.length) return res.status(409).json({ error: 'Some photos are missing.', errorCode: 'PHOTOS_MISSING', missing: faltan });

    const { rows: odo } = await pool.query<{ max: number | null }>(
      `SELECT MAX(odometer) AS max FROM vehicle_inspections WHERE driver_id = $1 AND status IN ('submitted', 'approved')`,
      [uid],
    );
    const odometro = validarOdometro((req.body as { odometer?: unknown } | undefined)?.odometer, odo[0]?.max ?? null);
    if ('error' in odometro) return res.status(400).json({ error: odometro.error, errorCode: odometro.code, field: 'odometer' });

    // Huellas de las fotos que ya mandó este chofer en los últimos 60 días.
    const { rows: previas } = await pool.query<{ photos: FotoGuardada[] }>(
      `SELECT photos FROM vehicle_inspections
        WHERE driver_id = $1 AND id <> $2
          AND status IN ('submitted', 'approved', 'rejected')
          AND submitted_at > NOW() - INTERVAL '60 days'`,
      [uid, fila.id],
    );
    const huellasPrevias = previas.flatMap((p) => (Array.isArray(p.photos) ? p.photos : [])).map((f) => f.hash).filter((h): h is string => !!h);

    const flags = new Set<string>();
    const repetidas: string[] = [];
    const procesadas: FotoGuardada[] = [];
    const huellasDeEsta: string[] = [];
    for (const foto of fotos) {
      const { data: archivo, error: bajarErr } = await supabaseAdmin.storage.from(BUCKET_INSPECCIONES).download(foto.path);
      if (bajarErr || !archivo || archivo.size === 0) {
        return res.status(409).json({ error: 'A photo did not finish uploading. Take it again.', errorCode: 'PHOTO_NOT_UPLOADED', missing: [foto.slot] });
      }
      try {
        const hash = await huellaDeImagen(Buffer.from(await archivo.arrayBuffer()));
        // También contra las otras fotos de esta misma revisión: la misma
        // imagen no sirve para dos posiciones.
        const match = compararConAnteriores(hash, [...huellasPrevias, ...huellasDeEsta]);
        if (match === 'repetida') repetidas.push(foto.slot);
        if (match === 'parecida') flags.add(`similar:${foto.slot}`);
        huellasDeEsta.push(hash);
        procesadas.push({ ...foto, hash, match });
      } catch (err: unknown) {
        log.warn({ err: errMsg(err), slot: foto.slot }, 'no se pudo calcular la huella');
        flags.add(`hash_failed:${foto.slot}`);
        procesadas.push(foto);
      }
    }

    if (repetidas.length) {
      const restantes = fotos.filter((f) => !repetidas.includes(f.slot));
      await supabaseAdmin.from('vehicle_inspections').update({ photos: restantes, updated_at: ahora.toISOString() }).eq('id', fila.id).eq('status', 'collecting');
      void supabaseAdmin.storage.from(BUCKET_INSPECCIONES).remove(fotos.filter((f) => repetidas.includes(f.slot)).map((f) => f.path));
      return res.status(409).json({
        error: 'Some photos were already sent before. Take new ones of your vehicle as it is now.',
        errorCode: 'DUPLICATE_PHOTO',
        missing: repetidas,
      });
    }

    const { data: enviada, error: guardarErr } = await supabaseAdmin.from('vehicle_inspections').update({
      status: 'submitted',
      photos: procesadas,
      flags: [...flags],
      odometer: odometro.valor,
      submitted_at: ahora.toISOString(),
      updated_at: ahora.toISOString(),
    }).eq('id', fila.id).eq('status', 'collecting').select('id').maybeSingle();
    if (guardarErr) throw guardarErr;
    if (!enviada) return res.status(409).json({ error: 'This inspection was already sent.', errorCode: 'WRONG_STATUS' });

    log.info({ driverId: uid, id: fila.id, flags: [...flags] }, 'revisión enviada');
    return res.json(await estadoParaApp(uid));
  } catch (err: unknown) {
    log.error({ err: errMsg(err) }, 'submit failed');
    return res.status(500).json({ error: 'Could not send the vehicle check.' });
  }
});

// ── Panel ────────────────────────────────────────────────────────────────────

async function urlsFirmadas(fotos: FotoGuardada[]) {
  if (!fotos.length) return [];
  const { data } = await supabaseAdmin.storage.from(BUCKET_INSPECCIONES).createSignedUrls(fotos.map((f) => f.path), 3600);
  return fotos.map((f, i) => ({ slot: f.slot, match: f.match ?? null, url: data?.[i]?.signedUrl ?? null }));
}

/** ?status=submitted (por defecto) | approved | rejected | all */
vehicleInspectionAdminRouter.get('/', async (req: Request, res: Response) => {
  const pedido = String(req.query.status ?? 'submitted');
  const estados = pedido === 'all' ? ['submitted', 'approved', 'rejected'] : [pedido];
  try {
    const { rows } = await pool.query<Fila & { driver_name: string | null; phone: string | null; previous_odometer: number | null }>(
      `SELECT v.*,
              NULLIF(TRIM(CONCAT(p.first_name, ' ', p.last_name)), '') AS driver_name,
              p.phone,
              (SELECT MAX(o.odometer) FROM vehicle_inspections o
                WHERE o.driver_id = v.driver_id AND o.id <> v.id
                  AND o.status IN ('submitted', 'approved') AND o.submitted_at < v.submitted_at) AS previous_odometer
         FROM vehicle_inspections v
         LEFT JOIN profiles p ON p.id = v.driver_id
        WHERE v.status = ANY($1)
        ORDER BY v.submitted_at DESC NULLS LAST
        LIMIT 200`,
      [estados],
    );
    const inspections = await Promise.all(rows.map(async (r) => ({
      id: r.id,
      driverId: r.driver_id,
      driverName: r.driver_name,
      phone: r.phone,
      status: r.status,
      odometer: r.odometer,
      previousOdometer: r.previous_odometer,
      flags: r.flags ?? [],
      submittedAt: r.submitted_at,
      reviewedAt: r.reviewed_at,
      reviewedBy: r.reviewed_by,
      rejectionReason: r.rejection_reason,
      photos: await urlsFirmadas(fotosDe(r)),
    })));
    return res.json({ inspections });
  } catch (err: unknown) {
    log.error({ err: errMsg(err) }, 'admin list failed');
    return res.status(500).json({ error: 'Could not list vehicle checks.' });
  }
});

vehicleInspectionAdminRouter.post('/:id/approve', async (req: Request, res: Response) => {
  const admin = req.adminUser!;
  try {
    const ahora = new Date().toISOString();
    const { data, error } = await supabaseAdmin.from('vehicle_inspections').update({
      status: 'approved', reviewed_at: ahora, reviewed_by: admin.email, updated_at: ahora,
    }).eq('id', req.params.id).eq('status', 'submitted').select('id').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'Only a check waiting for review can be approved.', errorCode: 'WRONG_STATUS' });
    return res.json({ success: true });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), id: req.params.id }, 'approve failed');
    return res.status(500).json({ error: 'Could not approve this vehicle check.' });
  }
});

/**
 * Rechazar deja al chofer con la revisión vencida: si está libre se lo
 * desconecta y se le avisa con el motivo para que tome fotos nuevas.
 */
vehicleInspectionAdminRouter.post('/:id/reject', async (req: Request, res: Response) => {
  const admin = req.adminUser!;
  const motivo = typeof (req.body as { reason?: unknown })?.reason === 'string' ? (req.body as { reason: string }).reason.trim() : '';
  if (motivo.length < 3 || motivo.length > 300) {
    return res.status(400).json({ error: 'Write a short reason for the rejection.', errorCode: 'INVALID_REASON', field: 'reason' });
  }
  try {
    const ahora = new Date().toISOString();
    const { data, error } = await supabaseAdmin.from('vehicle_inspections').update({
      status: 'rejected', rejection_reason: motivo, reviewed_at: ahora, reviewed_by: admin.email, updated_at: ahora,
    }).eq('id', req.params.id).in('status', ['submitted', 'approved']).select('driver_id').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'This check can no longer be rejected.', errorCode: 'WRONG_STATUS' });

    const driverId = String((data as { driver_id: string }).driver_id);
    await desconectarSiEstaLibre(driverId).catch((err: unknown) => log.warn({ err: errMsg(err), driverId }, 'no se pudo desconectar'));
    notifyUser(driverId, driverNotif.inspectionRejected(motivo)).catch(() => {});
    return res.json({ success: true });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), id: req.params.id }, 'reject failed');
    return res.status(500).json({ error: 'Could not reject this vehicle check.' });
  }
});
