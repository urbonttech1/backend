import { Router, Request, Response } from 'express';
import { requireSupabaseAuth } from '../middleware';
import { supabaseAdmin } from '../db/client';
import { createContextLogger } from '../lib/logger';
import { notifyUser } from '../services/fcm';
import { mensaje, type Anomalia } from '../services/rideSafety';

/**
 * El chequeo que RideCheck abre durante el viaje. Conductor y pasajero ven el
 * mismo aviso y cualquiera de los dos puede decir que está bien, pedir ayuda
 * o reportar un accidente.
 */

const log = createContextLogger('SAFETY');
export const safetyRouter = Router();

type Fila = {
  id: string;
  ride_id: string;
  driver_id: string | null;
  passenger_id: string | null;
  kind: Anomalia;
  status: string;
  lat: number | null;
  lng: number | null;
  created_at: string;
};

function esError(v: Fila | null | { error: string; status: number }): v is { error: string; status: number } {
  return !!v && 'error' in v;
}

function vista(row: Fila) {
  const texto = mensaje(row.kind);
  return {
    id: row.id,
    rideId: row.ride_id,
    kind: row.kind,
    status: row.status,
    lat: row.lat,
    lng: row.lng,
    createdAt: row.created_at,
    title: texto.title,
    body: texto.body,
  };
}

async function chequeoAbierto(rideId: string, uid: string): Promise<Fila | null | { error: string; status: number }> {
  const { data: ride, error } = await supabaseAdmin
    .from('rides').select('driver_id, passenger_id').eq('id', rideId).maybeSingle();
  if (error) throw error;
  const r = ride as { driver_id: string | null; passenger_id: string | null } | null;
  if (!r) return { error: 'Ride not found.', status: 404 };
  if (r.driver_id !== uid && r.passenger_id !== uid) return { error: 'This is not your trip.', status: 403 };
  const { data, error: leerErr } = await supabaseAdmin
    .from('ride_safety_checks').select('*').eq('ride_id', rideId).eq('status', 'open').maybeSingle();
  if (leerErr) throw leerErr;
  return (data as Fila | null) ?? null;
}

safetyRouter.get('/rides/:rideId', requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const fila = await chequeoAbierto(req.params.rideId, req.supabaseUid!);
    if (esError(fila)) return res.status(fila.status).json({ error: fila.error });
    return res.json({ check: fila ? vista(fila) : null });
  } catch (err: unknown) {
    log.error({ err: (err as Error)?.message }, 'read safety check failed');
    return res.status(500).json({ error: 'Could not load the safety check.' });
  }
});

safetyRouter.post('/rides/:rideId/resolve', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const action = (req.body as { action?: unknown } | undefined)?.action;
  if (action !== 'ok' && action !== 'emergency' && action !== 'accident') {
    return res.status(400).json({ error: 'Choose ok, emergency or accident.', errorCode: 'INVALID_ACTION' });
  }
  try {
    const fila = await chequeoAbierto(req.params.rideId, uid);
    if (esError(fila)) return res.status(fila.status).json({ error: fila.error });
    if (!fila) return res.status(404).json({ error: 'There is no open safety check.', errorCode: 'NOT_FOUND' });

    const quien = fila.driver_id === uid ? 'driver' : 'passenger';
    const ahora = new Date().toISOString();
    const { error } = await supabaseAdmin.from('ride_safety_checks').update({
      status: action === 'ok' ? 'ok' : action,
      resolved_by: quien,
      resolved_at: ahora,
    }).eq('id', fila.id).eq('status', 'open');
    if (error) throw error;

    if (action === 'accident') {
      const { error: incidenteErr } = await supabaseAdmin.from('incidents').insert({
        ride_id: fila.ride_id,
        driver_id: fila.driver_id,
        passenger_id: fila.passenger_id,
        reported_by_id: uid,
        reporter_role: quien,
        incid_type: 'accident',
        severity: 'high',
        incid_status: 'open',
        description: `RideCheck accident report (${fila.kind}).`,
        lat: fila.lat,
        lng: fila.lng,
        occurred_at: ahora,
      });
      if (incidenteErr) log.warn({ err: incidenteErr.message }, 'accident incident was not saved');
    }

    const otro = quien === 'driver' ? fila.passenger_id : fila.driver_id;
    if (otro && action !== 'ok') {
      const body = action === 'accident'
        ? 'An accident was reported on this trip. Se reportó un accidente en este viaje.'
        : 'Emergency help was requested on this trip. Se pidió ayuda de emergencia en este viaje.';
      notifyUser(otro, {
        title: 'Are you OK?',
        body,
        data: { type: 'safety_check', ride_id: fila.ride_id, screen: 'ride_tracking' },
      }).catch(() => {});
    }
    return res.json({ ok: true, status: action === 'ok' ? 'ok' : action });
  } catch (err: unknown) {
    log.error({ err: (err as Error)?.message }, 'resolve safety check failed');
    return res.status(500).json({ error: 'Could not update the safety check.' });
  }
});
