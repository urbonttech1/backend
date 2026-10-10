import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { requireSupabaseAuth } from '../middleware';
import { requireAdminJWT } from './admin-auth';
import { supabaseAdmin } from '../db/client';
import { createContextLogger } from '../lib/logger';
import { notifyUser } from '../services/fcm';
import { getStripe } from './rides/helpers';
import {
  MOTIVOS,
  FOTO_MAX_BYTES,
  FOTOS_MAX,
  FOTOS_MIN,
  esMotivo,
  VENTANA_MS,
  segundosRestantes,
  ventanaAbierta,
  venceRecibo,
  estadoAlEnviar,
  normalizarSitio,
  nombreEmpresaValido,
  mimeAceptado,
  puedeAdjuntarRecibo,
  type MotivoLimpieza,
} from '../services/cleaningCharge';
import { cobrarLimpieza } from '../services/cleaningChargePayment';

/**
 * Cargo de limpieza después del viaje.
 *
 * El chofer abre el caso con fotos dentro de las 2 horas. La arena pasa a
 * revisión. El vómito espera el recibo (72 h). Nada se cobra hasta que un
 * admin aprueba.
 *
 * Montado en /api/cleaning. El panel usa /api/admin/cleaning-charges.
 */

const log = createContextLogger('CLEANING');
const BUCKET = 'cleaning-photos';
const SUBIDA_VALIDA_SEGUNDOS = 2 * 60 * 60;

export const cleaningRouter = Router();
export const cleaningAdminRouter = Router();
cleaningAdminRouter.use(requireAdminJWT);

type Fila = Record<string, unknown>;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const esConductor = (req: Request) => req.supabaseRole === 'chauffeur' || req.supabaseRole === 'driver';

function fotosDe(row: Fila): { path: string; mimeType: string; createdAt: string }[] {
  if (!Array.isArray(row.photos)) return [];
  return row.photos.filter((p): p is { path: string; mimeType: string; createdAt: string } =>
    !!p && typeof p === 'object' && typeof (p as { path?: unknown }).path === 'string');
}

function vista(row: Fila, ahora = new Date()) {
  const completedAt = new Date(String(row.ride_completed_at));
  const motivo = String(row.reason) as MotivoLimpieza;
  const catalogo = MOTIVOS[motivo];
  return {
    id: row.id,
    rideId: row.ride_id,
    reason: row.reason,
    label: catalogo?.label ?? row.reason,
    amountUsd: Number(row.amount_usd),
    status: row.status,
    photoCount: fotosDe(row).length,
    submittedAt: row.submitted_at ?? null,
    receiptDueAt: row.receipt_due_at ?? null,
    companyName: row.company_name ?? null,
    companyWebsite: row.company_website ?? null,
    hasReceipt: Boolean(row.receipt_path),
    rejectionReason: row.rejection_reason ?? null,
    chargeError: row.charge_error ?? null,
    secondsLeft: segundosRestantes(completedAt, ahora),
  };
}

let bucketListo = false;

async function asegurarBucket(): Promise<void> {
  if (bucketListo) return;
  const opciones = { public: false, fileSizeLimit: FOTO_MAX_BYTES, allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] };
  const { data } = await supabaseAdmin.storage.getBucket(BUCKET);
  if (!data) {
    const { error } = await supabaseAdmin.storage.createBucket(BUCKET, opciones);
    if (error && !/already exists/i.test(error.message)) throw error;
  } else if (data.public) {
    const { error } = await supabaseAdmin.storage.updateBucket(BUCKET, opciones);
    if (error) throw error;
  }
  bucketListo = true;
}

async function viajeDelConductor(rideId: string, driverId: string) {
  const { data, error } = await supabaseAdmin
    .from('rides')
    .select('id, driver_id, passenger_id, ride_status, completed_at, payment_method')
    .eq('id', rideId)
    .maybeSingle();
  if (error) throw error;
  const ride = data as {
    id: string; driver_id: string | null; passenger_id: string | null;
    ride_status: string; completed_at: string | null;
  } | null;
  if (!ride) return { error: 'Ride not found.', errorCode: 'RIDE_NOT_FOUND', status: 404 as const };
  if (ride.driver_id !== driverId) return { error: 'This is not your trip.', errorCode: 'NOT_YOUR_RIDE', status: 403 as const };
  if (ride.ride_status !== 'completed' || !ride.completed_at || !ride.passenger_id) {
    return { error: 'Cleaning charges are only available after the trip is completed.', errorCode: 'NOT_COMPLETED', status: 409 as const };
  }
  return { ride };
}

async function leerCargo(rideId: string): Promise<Fila | null> {
  const { data, error } = await supabaseAdmin.from('cleaning_charges').select('*').eq('ride_id', rideId).maybeSingle();
  if (error) throw error;
  return (data as Fila | null) ?? null;
}

function avisoPasajero(passengerId: string, rideId: string, motivo: MotivoLimpieza, amount: number, esperaRecibo: boolean) {
  const label = MOTIVOS[motivo].label.toLowerCase();
  notifyUser(passengerId, {
    title: 'Cleaning charge under review',
    body: esperaRecibo
      ? `Your driver reported a $${amount.toFixed(2)} ${label} charge. It will not be billed until URBONT reviews the photos and the cleaning receipt.`
      : `Your driver reported a $${amount.toFixed(2)} ${label} charge. It will not be billed until URBONT reviews the photos.`,
    data: { type: 'cleaning_submitted', ride_id: rideId, screen: 'ride_history' },
  }).catch(() => {});
}

// ── Política que el pasajero acepta antes de reservar ────────────────────────

cleaningRouter.get('/policy', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles').select('cleaning_policy_accepted_at').eq('id', uid).maybeSingle();
    if (error) throw error;
    const acceptedAt = (data as { cleaning_policy_accepted_at?: string | null } | null)?.cleaning_policy_accepted_at ?? null;
    return res.json({
      accepted: Boolean(acceptedAt),
      acceptedAt,
      beachSandUsd: MOTIVOS.beach_sand.amountUsd,
      vomitUsd: MOTIVOS.vomit.amountUsd,
      windowMinutes: 10,
      receiptHours: 72,
    });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), uid }, 'policy read failed');
    return res.status(500).json({ error: 'Could not load the cleaning policy.', errorCode: 'POLICY_UNAVAILABLE' });
  }
});

cleaningRouter.post('/policy', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const ahora = new Date().toISOString();
  try {
    const { data: actual } = await supabaseAdmin
      .from('profiles').select('cleaning_policy_accepted_at').eq('id', uid).maybeSingle();
    const ya = (actual as { cleaning_policy_accepted_at?: string | null } | null)?.cleaning_policy_accepted_at;
    if (!ya) {
      const { error } = await supabaseAdmin
        .from('profiles')
        .update({ cleaning_policy_accepted_at: ahora, updated_at: ahora })
        .eq('id', uid);
      if (error) throw error;
    }
    return res.json({ accepted: true, acceptedAt: ya ?? ahora });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), uid }, 'policy accept failed');
    return res.status(500).json({ error: 'Could not save your acceptance.', errorCode: 'POLICY_NOT_SAVED' });
  }
});

// ── Lo que el chofer todavía puede reportar ──────────────────────────────────

cleaningRouter.get('/open', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  if (!esConductor(req)) return res.status(403).json({ error: 'Drivers only.', errorCode: 'ACCESS_DENIED' });
  try {
    const { data: abiertos, error } = await supabaseAdmin
      .from('cleaning_charges')
      .select('*')
      .eq('driver_id', uid)
      .in('status', ['collecting', 'awaiting_receipt'])
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    const cargo = (abiertos?.[0] as Fila | undefined) ?? null;
    if (cargo) {
      return res.json({ rideId: cargo.ride_id, charge: vista(cargo) });
    }

    const desde = new Date(Date.now() - VENTANA_MS).toISOString();
    const { data: viajes, error: viajesErr } = await supabaseAdmin
      .from('rides')
      .select('id, completed_at')
      .eq('driver_id', uid)
      .eq('ride_status', 'completed')
      .gte('completed_at', desde)
      .order('completed_at', { ascending: false })
      .limit(1);
    if (viajesErr) throw viajesErr;
    const viaje = viajes?.[0] as { id: string; completed_at: string } | undefined;
    if (!viaje) return res.json({ rideId: null, charge: null });
    return res.json({
      rideId: viaje.id,
      charge: null,
      secondsLeft: segundosRestantes(new Date(viaje.completed_at), new Date()),
    });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), uid }, 'open cleaning lookup failed');
    return res.status(500).json({ error: 'Could not check cleaning charges.', errorCode: 'CLEANING_UNAVAILABLE' });
  }
});

cleaningRouter.get('/rides/:rideId', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const rideId = req.params.rideId;
  try {
    const { data: ride, error } = await supabaseAdmin
      .from('rides')
      .select('id, driver_id, passenger_id, ride_status, completed_at')
      .eq('id', rideId)
      .maybeSingle();
    if (error) throw error;
    const r = ride as { driver_id: string | null; passenger_id: string | null; ride_status: string; completed_at: string | null } | null;
    if (!r) return res.status(404).json({ error: 'Ride not found.', errorCode: 'RIDE_NOT_FOUND' });
    const esSuyo = r.driver_id === uid || r.passenger_id === uid;
    if (!esSuyo) return res.status(403).json({ error: 'This is not your trip.', errorCode: 'NOT_YOUR_RIDE' });

    const cargo = await leerCargo(rideId);
    const completedAt = r.completed_at ? new Date(r.completed_at) : null;
    const secondsLeft = completedAt && r.ride_status === 'completed' ? segundosRestantes(completedAt, new Date()) : 0;
    if (r.passenger_id === uid && r.driver_id !== uid) {
      if (!cargo || cargo.status === 'collecting') return res.json({ rideId, secondsLeft: 0, charge: null });
    }
    return res.json({
      rideId,
      secondsLeft,
      windowOpen: secondsLeft > 0,
      charge: cargo ? vista(cargo) : null,
    });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), uid, rideId }, 'read cleaning charge failed');
    return res.status(500).json({ error: 'Could not load this cleaning charge.', errorCode: 'CLEANING_UNAVAILABLE' });
  }
});

cleaningRouter.post('/rides/:rideId', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  if (!esConductor(req)) return res.status(403).json({ error: 'Drivers only.', errorCode: 'ACCESS_DENIED' });
  const motivoRaw = (req.body as { reason?: unknown } | undefined)?.reason;
  if (!esMotivo(motivoRaw)) {
    return res.status(400).json({ error: 'Choose beach sand or professional cleaning.', errorCode: 'INVALID_REASON', field: 'reason' });
  }
  const motivo = motivoRaw;
  try {
    const viaje = await viajeDelConductor(req.params.rideId, uid);
    if ('errorCode' in viaje) return res.status(viaje.status).json({ error: viaje.error, errorCode: viaje.errorCode });
    const completedAt = new Date(viaje.ride.completed_at!);
    if (!ventanaAbierta(completedAt, new Date())) {
      return res.status(409).json({
        error: 'The 10-minute window to report cleaning has closed.',
        errorCode: 'WINDOW_CLOSED',
      });
    }
    const existente = await leerCargo(viaje.ride.id);
    if (existente) return res.status(409).json({ error: 'This trip already has a cleaning charge.', errorCode: 'ALREADY_EXISTS', charge: vista(existente) });

    const ahora = new Date();
    const fila = {
      ride_id: viaje.ride.id,
      driver_id: uid,
      passenger_id: viaje.ride.passenger_id,
      reason: motivo,
      amount_usd: MOTIVOS[motivo].amountUsd,
      status: 'collecting',
      ride_completed_at: completedAt.toISOString(),
      receipt_due_at: MOTIVOS[motivo].needsReceipt ? venceRecibo(completedAt).toISOString() : null,
      photos: [],
      created_at: ahora.toISOString(),
      updated_at: ahora.toISOString(),
    };
    const { data, error } = await supabaseAdmin.from('cleaning_charges').insert(fila).select('*').single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'This trip already has a cleaning charge.', errorCode: 'ALREADY_EXISTS' });
      throw error;
    }
    return res.status(201).json({ charge: vista(data as Fila) });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), uid, rideId: req.params.rideId }, 'create cleaning charge failed');
    return res.status(500).json({ error: 'Could not start the cleaning charge.', errorCode: 'CLEANING_NOT_SAVED' });
  }
});

cleaningRouter.post('/rides/:rideId/photos', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  if (!esConductor(req)) return res.status(403).json({ error: 'Drivers only.', errorCode: 'ACCESS_DENIED' });
  const mime = mimeAceptado((req.body as { mimeType?: unknown } | undefined)?.mimeType);
  if (!mime) {
    return res.status(400).json({ error: 'Use a JPG, PNG, WebP or HEIC photo.', errorCode: 'INVALID_MIME_TYPE', field: 'mimeType' });
  }
  try {
    const viaje = await viajeDelConductor(req.params.rideId, uid);
    if ('errorCode' in viaje) return res.status(viaje.status).json({ error: viaje.error, errorCode: viaje.errorCode });
    const cargo = await leerCargo(viaje.ride.id);
    if (!cargo) return res.status(404).json({ error: 'Start the cleaning charge before adding photos.', errorCode: 'NOT_FOUND' });
    if (cargo.status !== 'collecting') {
      return res.status(409).json({ error: 'Photos can only be added before the charge is submitted.', errorCode: 'WRONG_STATUS' });
    }
    if (!ventanaAbierta(new Date(String(cargo.ride_completed_at)), new Date())) {
      return res.status(409).json({ error: 'The 10-minute window to report cleaning has closed.', errorCode: 'WINDOW_CLOSED' });
    }
    const actuales = fotosDe(cargo);
    if (actuales.length >= FOTOS_MAX) {
      return res.status(409).json({ error: `You can attach up to ${FOTOS_MAX} photos.`, errorCode: 'TOO_MANY_PHOTOS' });
    }

    await asegurarBucket();
    const ext = mime.split('/')[1].replace('jpeg', 'jpg');
    const path = `${uid}/${cargo.id}/${randomUUID()}.${ext}`;
    const { data: firmada, error: firmarErr } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(path);
    if (firmarErr || !firmada) throw firmarErr ?? new Error('no signed upload url');

    const { error: anotarErr } = await supabaseAdmin.from('cleaning_charges').update({
      photos: [...actuales, { path, mimeType: mime, createdAt: new Date().toISOString() }],
      updated_at: new Date().toISOString(),
    }).eq('id', cargo.id).eq('status', 'collecting');
    if (anotarErr) throw anotarErr;

    return res.status(201).json({
      uploadUrl: firmada.signedUrl,
      method: 'PUT',
      headers: { 'Content-Type': mime },
      path,
      maxBytes: FOTO_MAX_BYTES,
      remaining: FOTOS_MAX - actuales.length - 1,
    });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), uid, rideId: req.params.rideId }, 'cleaning photo url failed');
    return res.status(500).json({ error: 'Could not prepare the photo upload.', errorCode: 'UPLOAD_URL_FAILED' });
  }
});

cleaningRouter.post('/rides/:rideId/submit', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  if (!esConductor(req)) return res.status(403).json({ error: 'Drivers only.', errorCode: 'ACCESS_DENIED' });
  try {
    const viaje = await viajeDelConductor(req.params.rideId, uid);
    if ('errorCode' in viaje) return res.status(viaje.status).json({ error: viaje.error, errorCode: viaje.errorCode });
    const cargo = await leerCargo(viaje.ride.id);
    if (!cargo) return res.status(404).json({ error: 'Start the cleaning charge before submitting it.', errorCode: 'NOT_FOUND' });
    if (cargo.status !== 'collecting') {
      return res.status(409).json({ error: 'This cleaning charge was already submitted.', errorCode: 'WRONG_STATUS', charge: vista(cargo) });
    }
    const completedAt = new Date(String(cargo.ride_completed_at));
    if (!ventanaAbierta(completedAt, new Date())) {
      return res.status(409).json({ error: 'The 10-minute window to report cleaning has closed.', errorCode: 'WINDOW_CLOSED' });
    }
    if (fotosDe(cargo).length < FOTOS_MIN) {
      return res.status(400).json({ error: 'Add at least one photo of the vehicle before submitting.', errorCode: 'PHOTO_REQUIRED' });
    }
    const motivo = String(cargo.reason) as MotivoLimpieza;
    const status = estadoAlEnviar(motivo);
    const ahora = new Date().toISOString();
    const { data, error } = await supabaseAdmin.from('cleaning_charges').update({
      status,
      submitted_at: ahora,
      updated_at: ahora,
    }).eq('id', cargo.id).eq('status', 'collecting').select('*').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'This cleaning charge was already submitted.', errorCode: 'WRONG_STATUS' });
    avisoPasajero(String(cargo.passenger_id), viaje.ride.id, motivo, Number(cargo.amount_usd), status === 'awaiting_receipt');
    return res.json({ charge: vista(data as Fila) });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), uid, rideId: req.params.rideId }, 'submit cleaning charge failed');
    return res.status(500).json({ error: 'Could not submit the cleaning charge.', errorCode: 'CLEANING_NOT_SAVED' });
  }
});

cleaningRouter.post('/rides/:rideId/receipt', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  if (!esConductor(req)) return res.status(403).json({ error: 'Drivers only.', errorCode: 'ACCESS_DENIED' });
  const body = (req.body ?? {}) as { companyName?: unknown; website?: unknown; mimeType?: unknown };
  const nombre = nombreEmpresaValido(body.companyName);
  const sitio = normalizarSitio(body.website);
  const mime = mimeAceptado(body.mimeType);
  if (!nombre) return res.status(400).json({ error: 'Enter the cleaning company name.', errorCode: 'INVALID_COMPANY', field: 'companyName' });
  if (!sitio) return res.status(400).json({ error: 'Enter the company website, including the page where its services are listed.', errorCode: 'INVALID_WEBSITE', field: 'website' });
  if (!mime) return res.status(400).json({ error: 'Use a JPG, PNG, WebP or HEIC photo of the receipt.', errorCode: 'INVALID_MIME_TYPE', field: 'mimeType' });

  try {
    const viaje = await viajeDelConductor(req.params.rideId, uid);
    if ('errorCode' in viaje) return res.status(viaje.status).json({ error: viaje.error, errorCode: viaje.errorCode });
    const cargo = await leerCargo(viaje.ride.id);
    if (!cargo) return res.status(404).json({ error: 'Cleaning charge not found.', errorCode: 'NOT_FOUND' });
    if (cargo.reason !== 'vomit') return res.status(409).json({ error: 'Only the professional cleaning charge needs a receipt.', errorCode: 'NOT_VOMIT' });
    const vence = new Date(String(cargo.receipt_due_at ?? venceRecibo(new Date(String(cargo.ride_completed_at)))));
    if (!puedeAdjuntarRecibo(String(cargo.status), vence, new Date())) {
      return res.status(409).json({ error: 'The receipt window for this trip has closed.', errorCode: 'RECEIPT_WINDOW_CLOSED' });
    }

    await asegurarBucket();
    const ext = mime.split('/')[1].replace('jpeg', 'jpg');
    const path = `${uid}/${cargo.id}/receipt-${randomUUID()}.${ext}`;
    const { data: firmada, error: firmarErr } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(path);
    if (firmarErr || !firmada) throw firmarErr ?? new Error('no signed upload url');

    const ahora = new Date().toISOString();
    // El estado no cambia aquí. Si la foto no llega a subirse, el chofer puede
    // pedir otro enlace. Pasa a revisión en /receipt/confirm.
    const { error } = await supabaseAdmin.from('cleaning_charges').update({
      company_name: nombre,
      company_website: sitio,
      receipt_path: path,
      receipt_mime: mime,
      updated_at: ahora,
    }).eq('id', cargo.id).eq('status', 'awaiting_receipt');
    if (error) throw error;

    return res.status(201).json({
      uploadUrl: firmada.signedUrl,
      method: 'PUT',
      headers: { 'Content-Type': mime },
      path,
      maxBytes: FOTO_MAX_BYTES,
    });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), uid, rideId: req.params.rideId }, 'cleaning receipt url failed');
    return res.status(500).json({ error: 'Could not prepare the receipt upload.', errorCode: 'UPLOAD_URL_FAILED' });
  }
});

cleaningRouter.post('/rides/:rideId/receipt/confirm', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  if (!esConductor(req)) return res.status(403).json({ error: 'Drivers only.', errorCode: 'ACCESS_DENIED' });
  try {
    const viaje = await viajeDelConductor(req.params.rideId, uid);
    if ('errorCode' in viaje) return res.status(viaje.status).json({ error: viaje.error, errorCode: viaje.errorCode });
    const cargo = await leerCargo(viaje.ride.id);
    if (!cargo || cargo.status !== 'awaiting_receipt' || !cargo.receipt_path || !cargo.company_name || !cargo.company_website) {
      return res.status(409).json({ error: 'Upload the receipt before sending it for review.', errorCode: 'RECEIPT_REQUIRED' });
    }
    const ahora = new Date().toISOString();
    const { data, error } = await supabaseAdmin.from('cleaning_charges').update({
      status: 'pending_review',
      updated_at: ahora,
    }).eq('id', cargo.id).eq('status', 'awaiting_receipt').select('*').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'This receipt was already sent.', errorCode: 'WRONG_STATUS' });
    return res.json({ charge: vista(data as Fila) });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), uid, rideId: req.params.rideId }, 'confirm cleaning receipt failed');
    return res.status(500).json({ error: 'Could not send the receipt for review.', errorCode: 'CLEANING_NOT_SAVED' });
  }
});

// ── Revisión del panel ────────────────────────────────────────────────────────

async function urlsFirmadas(paths: string[]): Promise<{ path: string; url: string | null }[]> {
  const salidas: { path: string; url: string | null }[] = [];
  for (const path of paths) {
    const { data } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
    salidas.push({ path, url: data?.signedUrl ?? null });
  }
  return salidas;
}

cleaningAdminRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('cleaning_charges')
      .select('id, ride_id, driver_id, passenger_id, reason, amount_usd, status, submitted_at, receipt_due_at, company_name, created_at, reviewed_at, reviewed_by, rejection_reason')
      // Los resueltos también: el panel los muestra abajo como historial.
      // 'collecting' es el chofer todavía subiendo fotos.
      .neq('status', 'collecting')
      .order('submitted_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    // Nombres para que el panel no muestre solo ids.
    const filas = (data ?? []) as Record<string, unknown>[];
    const ids = [...new Set(filas.flatMap(f => [f.driver_id, f.passenger_id]).filter(Boolean).map(String))];
    const nombres = new Map<string, string>();
    if (ids.length) {
      const { data: perfiles } = await supabaseAdmin.from('profiles').select('id, first_name, last_name').in('id', ids);
      for (const p of (perfiles ?? []) as { id: string; first_name?: string | null; last_name?: string | null }[]) {
        nombres.set(p.id, [p.first_name, p.last_name].filter(Boolean).join(' '));
      }
    }
    return res.json({
      charges: filas.map(f => ({
        ...f,
        driver_name: nombres.get(String(f.driver_id)) || null,
        passenger_name: nombres.get(String(f.passenger_id)) || null,
        label: MOTIVOS[String(f.reason) as MotivoLimpieza]?.label ?? f.reason,
      })),
    });
  } catch (err: unknown) {
    log.error({ err: errMsg(err) }, 'admin list failed');
    return res.status(500).json({ error: 'Could not list cleaning charges.' });
  }
});

cleaningAdminRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin.from('cleaning_charges').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Cleaning charge not found.' });
    const row = data as Fila;
    const fotos = await urlsFirmadas(fotosDe(row).map(f => f.path));
    const recibo = row.receipt_path ? await urlsFirmadas([String(row.receipt_path)]) : [];
    return res.json({ charge: vista(row), photos: fotos, receipt: recibo[0] ?? null });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), id: req.params.id }, 'admin detail failed');
    return res.status(500).json({ error: 'Could not load this cleaning charge.' });
  }
});

cleaningAdminRouter.post('/:id/approve', async (req: Request, res: Response) => {
  const admin = req.adminUser!;
  try {
    const { data, error } = await supabaseAdmin.from('cleaning_charges').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    const cargo = data as Fila | null;
    if (!cargo) return res.status(404).json({ error: 'Cleaning charge not found.' });
    if (cargo.status !== 'pending_review') {
      return res.status(409).json({ error: 'Only a charge waiting for review can be approved.', errorCode: 'WRONG_STATUS' });
    }
    if (cargo.reason === 'vomit' && !cargo.receipt_path) {
      return res.status(409).json({ error: 'The professional cleaning receipt is missing.', errorCode: 'RECEIPT_REQUIRED' });
    }
    if (fotosDe(cargo).length < FOTOS_MIN) {
      return res.status(409).json({ error: 'This charge has no photos.', errorCode: 'PHOTO_REQUIRED' });
    }

    const motivo = String(cargo.reason) as MotivoLimpieza;
    const resultado = await cobrarLimpieza({
      stripe: getStripe(),
      chargeId: String(cargo.id),
      rideId: String(cargo.ride_id),
      passengerId: String(cargo.passenger_id),
      driverId: String(cargo.driver_id),
      motivo,
      amountUsd: Number(cargo.amount_usd),
    });
    const ahora = new Date().toISOString();
    const { data: actualizado, error: guardarErr } = await supabaseAdmin.from('cleaning_charges').update({
      status: resultado.status,
      payment_intent_id: resultado.paymentIntentId ?? null,
      transfer_id: resultado.status === 'charged' ? (resultado.transferId ?? null) : null,
      charge_error: resultado.status === 'charged' ? (resultado.chargeError ?? null) : resultado.chargeError,
      reviewed_at: ahora,
      reviewed_by: admin.email,
      updated_at: ahora,
    }).eq('id', cargo.id).eq('status', 'pending_review').select('*').maybeSingle();
    if (guardarErr) throw guardarErr;
    if (!actualizado) return res.status(409).json({ error: 'This charge was already reviewed.', errorCode: 'WRONG_STATUS' });
    return res.json({ charge: vista(actualizado as Fila) });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), id: req.params.id }, 'approve cleaning charge failed');
    return res.status(500).json({ error: 'Could not approve this cleaning charge.' });
  }
});

cleaningAdminRouter.post('/:id/reject', async (req: Request, res: Response) => {
  const admin = req.adminUser!;
  const motivoRechazo = typeof (req.body as { reason?: unknown })?.reason === 'string'
    ? (req.body as { reason: string }).reason.trim()
    : '';
  if (motivoRechazo.length < 3 || motivoRechazo.length > 500) {
    return res.status(400).json({ error: 'Write a short reason for the rejection.', errorCode: 'INVALID_REASON', field: 'reason' });
  }
  try {
    const { data: cargo, error } = await supabaseAdmin.from('cleaning_charges').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!cargo) return res.status(404).json({ error: 'Cleaning charge not found.' });
    const fila = cargo as Fila;
    if (fila.status !== 'pending_review' && fila.status !== 'awaiting_receipt') {
      return res.status(409).json({ error: 'This charge can no longer be rejected.', errorCode: 'WRONG_STATUS' });
    }
    const ahora = new Date().toISOString();
    const { data, error: guardarErr } = await supabaseAdmin.from('cleaning_charges').update({
      status: 'rejected',
      rejection_reason: motivoRechazo,
      reviewed_at: ahora,
      reviewed_by: admin.email,
      updated_at: ahora,
    }).eq('id', fila.id).eq('status', fila.status).select('*').maybeSingle();
    if (guardarErr) throw guardarErr;
    if (!data) return res.status(409).json({ error: 'This charge was already reviewed.', errorCode: 'WRONG_STATUS' });

    const amount = Number(fila.amount_usd);
    notifyUser(String(fila.passenger_id), {
      title: 'Cleaning charge declined',
      body: `The $${amount.toFixed(2)} cleaning charge was not applied.`,
      data: { type: 'cleaning_rejected', ride_id: String(fila.ride_id), screen: 'ride_history' },
    }).catch(() => {});
    notifyUser(String(fila.driver_id), {
      title: 'Cleaning charge declined',
      body: motivoRechazo,
      data: { type: 'cleaning_rejected', ride_id: String(fila.ride_id), screen: 'driver_home' },
    }).catch(() => {});
    return res.json({ charge: vista(data as Fila) });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), id: req.params.id }, 'reject cleaning charge failed');
    return res.status(500).json({ error: 'Could not reject this cleaning charge.' });
  }
});
