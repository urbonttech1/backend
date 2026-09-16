import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { requireSupabaseAuth } from '../middleware';
import { supabaseAdmin } from '../db/client';
import { createContextLogger } from '../lib/logger';
import { sendAdminEmail } from './support';
import { recordDriverRelease } from '../services/driverRideHistory';
import { broadcastRideStatus, notifyAvailableDrivers } from '../services/socketService';
import { notifyUser } from '../services/fcm';
import {
  normalizarIncidente,
  ETIQUETA_INCIDENTE,
  FOTO_TIPOS,
  FOTO_MAX_BYTES,
  FOTOS_POR_INCIDENTE,
} from '../services/driverIncident';

/**
 * Incidentes reportados por el conductor desde la pantalla Help.
 *
 * Escribe en `incidents`, la tabla de la pantalla Incidentes del panel. Hasta
 * ahora sólo el panel podía crear incidentes, así que los formularios de la app
 * (accidente, no puedo recoger, avería, otro) no llegaban a ningún sitio.
 *
 * Montado en /api/drivers, junto a driverRouter.
 */

const log = createContextLogger('DRIVER_INCIDENTS');
export const driverIncidentsRouter = Router();

/** Privado siempre: son fotos de accidentes, con placas y daños. */
const BUCKET = 'incident-photos';
/** Vigencia de las URLs firmadas de subida que genera Supabase. */
const SUBIDA_VALIDA_SEGUNDOS = 2 * 60 * 60;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const esConductor = (req: Request) => req.supabaseRole === 'chauffeur' || req.supabaseRole === 'driver';

/** Columnas añadidas en la migración; si aún no existen, el insert se repite sin ellas. */
const COLUMNAS_NUEVAS = ['lat', 'lng', 'occurred_at', 'attachments'];

function esErrorDeColumna(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42703' || error.code === 'PGRST204' || /column|schema cache/i.test(error.message ?? '');
}

let bucketListo = false;

/** Crea el bucket privado la primera vez que hace falta, y lo corrige si alguien lo hizo público. */
async function asegurarBucket(): Promise<void> {
  if (bucketListo) return;
  const opciones = { public: false, fileSizeLimit: FOTO_MAX_BYTES, allowedMimeTypes: [...FOTO_TIPOS] };
  const { data } = await supabaseAdmin.storage.getBucket(BUCKET);
  if (!data) {
    const { error } = await supabaseAdmin.storage.createBucket(BUCKET, opciones);
    if (error && !/already exists/i.test(error.message)) throw error;
  } else if (data.public) {
    log.warn({ bucket: BUCKET }, 'incident photo bucket was public — making it private');
    const { error } = await supabaseAdmin.storage.updateBucket(BUCKET, opciones);
    if (error) throw error;
  }
  bucketListo = true;
}

/**
 * «Cannot Pick Up»: libera el viaje para que lo tome otro conductor.
 *
 * Misma condición y mismos pasos que la cancelación del conductor en
 * rides/cancel.ts: sólo si el viaje es suyo y todavía no empezó. Cuenta como
 * cancelación del conductor. El pasajero no paga nada.
 */
async function liberarViaje(rideId: string, driverId: string): Promise<boolean> {
  const { data: ride } = await supabaseAdmin
    .from('rides')
    .select('ride_status, driver_id, passenger_id, vehicle_type, pickup_address, pickup_lat, pickup_lng')
    .eq('id', rideId)
    .maybeSingle();
  const r = ride as {
    ride_status: string; driver_id: string | null; passenger_id: string | null;
    vehicle_type: string | null; pickup_address: string | null;
    pickup_lat: number | null; pickup_lng: number | null;
  } | null;
  if (!r || r.driver_id !== driverId || !['confirmed', 'accepted', 'driver_arrived'].includes(r.ride_status)) {
    return false;
  }

  // Condición atómica: si el estado cambió desde la lectura, no se toca.
  const { data: cambiadas, error } = await supabaseAdmin
    .from('rides')
    .update({ ride_status: 'searching', driver_id: null, accepted_at: null, updated_at: new Date().toISOString() })
    .eq('id', rideId)
    .eq('driver_id', driverId)
    .eq('ride_status', r.ride_status)
    .select('id');
  if (error || !cambiadas || cambiadas.length === 0) return false;

  recordDriverRelease(rideId, driverId, 'driver_cancelled', 'cannot_pickup');
  broadcastRideStatus(rideId, 'searching', {
    driverCancelled: true,
    reason: 'cannot_pickup',
    passengerId: r.passenger_id ?? '',
    driverId,
  });
  if (r.passenger_id) {
    notifyUser(r.passenger_id, {
      title: 'Finding you a new chauffeur',
      body: "Your driver couldn't make the pickup. We're searching for another chauffeur right now.",
      data: { type: 'driver_cancelled_reassigning', ride_id: rideId, screen: 'ride_tracking' },
    }).catch(() => {});
  }
  try {
    notifyAvailableDrivers(rideId, r.vehicle_type || 'executive', r.pickup_address || '', r.pickup_lat ?? null, r.pickup_lng ?? null);
  } catch { /* el cron de reasignación lo recoge */ }

  log.info({ rideId, driverId }, 'cannot_pickup — ride released for reassignment');
  return true;
}

// POST /api/drivers/incidents — reportar un incidente
driverIncidentsRouter.post('/incidents', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  if (!esConductor(req)) return res.status(403).json({ error: 'Drivers only.', errorCode: 'ACCESS_DENIED' });

  const resultado = normalizarIncidente((req.body ?? {}) as Record<string, unknown>);
  if ('errorCode' in resultado) {
    return res.status(400).json({ error: resultado.error, errorCode: resultado.errorCode, field: resultado.field });
  }
  const inc = resultado.incidente;

  try {
    const { data: perfil } = await supabaseAdmin
      .from('profiles').select('first_name, last_name, phone').eq('id', uid).maybeSingle();
    const p = perfil as { first_name?: string; last_name?: string; phone?: string } | null;
    const nombre = `${p?.first_name ?? ''} ${p?.last_name ?? ''}`.trim() || 'Driver';
    const telefono = p?.phone || 'N/A';

    // El viaje sólo se asocia si existe y es de este conductor.
    let rideId: string | null = null;
    let passengerId: string | null = null;
    if (inc.rideId) {
      const { data: ride } = await supabaseAdmin
        .from('rides').select('driver_id, passenger_id').eq('id', inc.rideId).maybeSingle();
      const r = ride as { driver_id: string | null; passenger_id: string | null } | null;
      if (r && r.driver_id === uid) {
        rideId = inc.rideId;
        passengerId = r.passenger_id;
      } else {
        log.warn({ uid, rideId: inc.rideId }, 'incident ride not found or not this driver — saved without ride');
      }
    }

    const fila: Record<string, unknown> = {
      ride_id:        rideId,
      driver_id:      uid,
      passenger_id:   passengerId,
      reported_by_id: uid,
      reporter_role:  'driver',
      reporter_name:  nombre,
      incid_type:     inc.tipo,
      severity:       inc.severidad,
      incid_status:   'open',
      // Texto para la pantalla del panel; las coordenadas exactas van aparte.
      location:       inc.lat !== null ? `${inc.lat},${inc.lng}` : null,
      description:    inc.descripcion || null,
      lat:            inc.lat,
      lng:            inc.lng,
      occurred_at:    inc.occurredAt,
      attachments:    [],
    };
    const insertar = (datos: Record<string, unknown>) =>
      supabaseAdmin.from('incidents').insert(datos).select('id, incid_status, created_at').single();

    let resp = await insertar(fila);
    if (esErrorDeColumna(resp.error)) {
      // Base sin migrar todavía: se guarda lo esencial en lugar de perder el reporte.
      log.warn({ err: resp.error?.message }, 'incidents new columns missing — saving without them');
      const basica = { ...fila };
      for (const c of COLUMNAS_NUEVAS) delete basica[c];
      resp = await insertar(basica);
    }
    if (resp.error || !resp.data) throw resp.error ?? new Error('insert returned no row');
    const creado = resp.data as { id: string; incid_status: string | null; created_at: string };

    const rideReleased = inc.tipo === 'cannot_pickup' && rideId ? await liberarViaje(rideId, uid) : false;

    if (inc.avisarYa) {
      const detalle = [
        inc.descripcion || '(sin descripción)',
        '',
        `Ocurrió: ${inc.occurredAt}`,
        inc.lat !== null ? `Ubicación: https://maps.google.com/?q=${inc.lat},${inc.lng}` : 'Ubicación: no enviada',
      ].join('\n');
      sendAdminEmail({
        id: creado.id,
        category: 'safety',
        subject: `SEVERE ACCIDENT — ${nombre}`,
        description: detalle,
        priority: 'urgent',
        ride_id: rideId,
        userName: nombre,
        userPhone: telefono,
      }).catch((err) => log.warn({ err: errMsg(err) }, 'severe accident alert email failed'));
      log.warn({ incidentId: creado.id, uid, rideId }, 'SEVERE ACCIDENT reported');
    }

    return res.status(201).json({
      incidentId: creado.id,
      category: inc.tipo,
      label: ETIQUETA_INCIDENTE[inc.tipo],
      severity: inc.severidad,
      status: creado.incid_status ?? 'open',
      createdAt: creado.created_at,
      rideId,
      rideReleased,
      photos: {
        maxCount: FOTOS_POR_INCIDENTE,
        maxBytes: FOTO_MAX_BYTES,
        acceptedMimeTypes: FOTO_TIPOS,
      },
    });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), uid }, 'create incident error');
    return res.status(500).json({
      error: 'We could not save your report. Please try again.',
      errorCode: 'INCIDENT_NOT_SAVED',
    });
  }
});

// GET /api/drivers/incidents — los incidentes que reportó este conductor
driverIncidentsRouter.get('/incidents', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  if (!esConductor(req)) return res.status(403).json({ error: 'Drivers only.', errorCode: 'ACCESS_DENIED' });

  try {
    const { data, error } = await supabaseAdmin
      .from('incidents')
      .select('*')
      .eq('reported_by_id', uid)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    const incidents = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      incidentId:  r.id,
      category:    r.incid_type,
      severity:    r.severity ?? 'low',
      status:      r.incid_status ?? 'open',
      description: r.description ?? null,
      resolution:  r.resolution ?? null,
      rideId:      r.ride_id ?? null,
      occurredAt:  r.occurred_at ?? null,
      createdAt:   r.created_at,
      updatedAt:   r.updated_at,
      photoCount:  Array.isArray(r.attachments) ? r.attachments.length : 0,
    }));
    return res.json({ incidents });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), uid }, 'list incidents error');
    return res.status(500).json({
      error: 'We could not load your reports right now. Please try again.',
      errorCode: 'INCIDENTS_UNAVAILABLE',
    });
  }
});

// POST /api/drivers/incidents/:id/attachments — URL firmada para subir una foto
driverIncidentsRouter.post('/incidents/:id/attachments', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  if (!esConductor(req)) return res.status(403).json({ error: 'Drivers only.', errorCode: 'ACCESS_DENIED' });

  const mimeType = String((req.body as { mimeType?: unknown } | undefined)?.mimeType ?? '').trim().toLowerCase();
  if (!FOTO_TIPOS.includes(mimeType)) {
    return res.status(400).json({
      error: 'This file type is not accepted. Use a JPG, PNG, WebP or HEIC photo.',
      errorCode: 'INVALID_MIME_TYPE',
      field: 'mimeType',
      acceptedMimeTypes: FOTO_TIPOS,
    });
  }

  try {
    const { data: incidente, error: leerErr } = await supabaseAdmin
      .from('incidents').select('*').eq('id', req.params.id).eq('reported_by_id', uid).maybeSingle();
    if (leerErr) throw leerErr;
    if (!incidente) return res.status(404).json({ error: 'Incident not found.', errorCode: 'INCIDENT_NOT_FOUND' });

    const actuales = Array.isArray((incidente as Record<string, unknown>).attachments)
      ? ((incidente as Record<string, unknown>).attachments as unknown[])
      : [];
    if (actuales.length >= FOTOS_POR_INCIDENTE) {
      return res.status(409).json({
        error: `You can attach up to ${FOTOS_POR_INCIDENTE} photos per report.`,
        errorCode: 'TOO_MANY_PHOTOS',
      });
    }

    await asegurarBucket();

    const ext = mimeType.split('/')[1].replace('jpeg', 'jpg');
    const path = `${uid}/${req.params.id}/${randomUUID()}.${ext}`;
    const { data: firmada, error: firmarErr } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(path);
    if (firmarErr || !firmada) throw firmarErr ?? new Error('no signed upload url');

    // Se anota al firmar: si la foto nunca se sube, el panel simplemente no la
    // encuentra al firmar la descarga y no la muestra.
    const { error: anotarErr } = await supabaseAdmin
      .from('incidents')
      .update({
        attachments: [...actuales, { path, mimeType, createdAt: new Date().toISOString() }],
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);
    if (anotarErr) throw anotarErr;

    return res.status(201).json({
      uploadUrl: firmada.signedUrl,
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      path,
      maxBytes: FOTO_MAX_BYTES,
      expiresInSeconds: SUBIDA_VALIDA_SEGUNDOS,
      remaining: FOTOS_POR_INCIDENTE - actuales.length - 1,
    });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), uid, incidentId: req.params.id }, 'attachment url error');
    return res.status(500).json({
      error: 'We could not prepare the photo upload. Please try again.',
      errorCode: 'UPLOAD_URL_FAILED',
    });
  }
});
