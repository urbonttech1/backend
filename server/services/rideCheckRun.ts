/**
 * Aplica RideCheck a un ping de GPS y a las paradas que se quedaron en silencio.
 * El aviso sale una sola vez por chequeo abierto: push a los dos y un evento
 * de socket para la pantalla que ya está en el viaje.
 */

import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';
import { notifyUser } from './fcm';
import { broadcastSafetyCheck } from './socketService';
import {
  evaluarChequeo,
  estadoVacio,
  mensaje,
  paradaVencidaEnSilencio,
  type Anomalia,
  type EstadoChequeo,
  type Punto,
} from './rideSafety';

type FilaEstado = {
  ride_id: string;
  stopped_since: string | null;
  last_lat: number | null;
  last_lng: number | null;
  last_speed_mps: number | null;
  last_ping_at: string | null;
  last_alert_at: string | null;
  last_alert_kind: string | null;
};

type Viaje = {
  id: string;
  passenger_id: string | null;
  driver_id: string | null;
  ride_status: string;
  pickup_lat: number | null;
  pickup_lng: number | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
};

function punto(lat: number | null, lng: number | null): Punto | null {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function aEstado(fila: FilaEstado | null): EstadoChequeo {
  if (!fila) return estadoVacio();
  return {
    stoppedSince: fila.stopped_since ? Date.parse(fila.stopped_since) : null,
    lastLat: fila.last_lat,
    lastLng: fila.last_lng,
    lastSpeedMps: fila.last_speed_mps,
    lastPingAt: fila.last_ping_at ? Date.parse(fila.last_ping_at) : null,
    lastAlertAt: fila.last_alert_at ? Date.parse(fila.last_alert_at) : null,
    lastAlertKind: (fila.last_alert_kind as Anomalia | null) ?? null,
  };
}

async function viajeEnCurso(driverId: string): Promise<Viaje | null> {
  const { data, error } = await supabaseAdmin
    .from('rides')
    .select('id, passenger_id, driver_id, ride_status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng')
    .eq('driver_id', driverId)
    .eq('ride_status', 'in_progress')
    .order('started_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0] as Viaje | undefined) ?? null;
}

async function hayAbierto(rideId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('ride_safety_checks')
    .select('id')
    .eq('ride_id', rideId)
    .eq('status', 'open')
    .limit(1);
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

async function guardarEstado(rideId: string, estado: EstadoChequeo): Promise<void> {
  const fila = {
    ride_id: rideId,
    stopped_since: estado.stoppedSince ? new Date(estado.stoppedSince).toISOString() : null,
    last_lat: estado.lastLat,
    last_lng: estado.lastLng,
    last_speed_mps: estado.lastSpeedMps,
    last_ping_at: estado.lastPingAt ? new Date(estado.lastPingAt).toISOString() : null,
    last_alert_at: estado.lastAlertAt ? new Date(estado.lastAlertAt).toISOString() : null,
    last_alert_kind: estado.lastAlertKind,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabaseAdmin.from('ride_safety_state').upsert(fila, { onConflict: 'ride_id' });
  if (error) throw error;
}

async function abrirChequeo(viaje: Viaje, kind: Anomalia, lat: number, lng: number): Promise<void> {
  const texto = mensaje(kind);
  const ahora = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from('ride_safety_checks').insert({
    ride_id: viaje.id,
    driver_id: viaje.driver_id,
    passenger_id: viaje.passenger_id,
    kind,
    status: 'open',
    lat,
    lng,
    created_at: ahora,
  }).select('id').maybeSingle();
  if (error) {
    if (error.code === '23505') return;
    throw error;
  }
  const checkId = String((data as { id: string } | null)?.id ?? '');
  const dataPush = { type: 'safety_check', ride_id: viaje.id, check_id: checkId, kind, screen: 'ride_tracking' };
  if (viaje.passenger_id) notifyUser(viaje.passenger_id, { title: texto.title, body: texto.body, data: dataPush }).catch(() => {});
  if (viaje.driver_id) notifyUser(viaje.driver_id, { title: texto.title, body: texto.body, data: dataPush }).catch(() => {});
  broadcastSafetyCheck(viaje.id, viaje.driver_id ?? '', { checkId, kind, ...texto });
  logger.info(`[RIDECHECK] ${viaje.id} ${kind}`);
}

export async function revisarPing(opts: {
  driverId: string;
  lat: number;
  lng: number;
  speedMps: number | null;
  harshBrake?: boolean;
  at?: number;
}): Promise<void> {
  const viaje = await viajeEnCurso(opts.driverId);
  if (!viaje) return;
  const { data: fila } = await supabaseAdmin.from('ride_safety_state').select('*').eq('ride_id', viaje.id).maybeSingle();
  const previo = aEstado(fila as FilaEstado | null);
  const bloqueado = await hayAbierto(viaje.id);
  const { estado, anomalia } = evaluarChequeo(previo, {
    at: opts.at ?? Date.now(),
    lat: opts.lat,
    lng: opts.lng,
    speedMps: opts.speedMps,
    harshBrake: opts.harshBrake,
    pickup: punto(viaje.pickup_lat, viaje.pickup_lng),
    dropoff: punto(viaje.dropoff_lat, viaje.dropoff_lng),
    bloqueado,
  });
  await guardarEstado(viaje.id, estado);
  if (anomalia) await abrirChequeo(viaje, anomalia, opts.lat, opts.lng);
}

/** Cada minuto: la parada cumplió 5 minutos y no llegó otro ping. */
export async function revisarParadasEnSilencio(ahora = Date.now()): Promise<void> {
  const desde = new Date(ahora - 20 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('ride_safety_state')
    .select('*')
    .not('stopped_since', 'is', null)
    .gte('last_ping_at', desde)
    .limit(50);
  if (error) throw error;
  for (const cruda of (data ?? []) as FilaEstado[]) {
    const estado = aEstado(cruda);
    const { data: viaje } = await supabaseAdmin
      .from('rides')
      .select('id, passenger_id, driver_id, ride_status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng')
      .eq('id', cruda.ride_id)
      .maybeSingle();
    const r = viaje as Viaje | null;
    if (!r || r.ride_status !== 'in_progress') continue;
    if (await hayAbierto(r.id)) continue;
    if (!paradaVencidaEnSilencio(estado, punto(r.dropoff_lat, r.dropoff_lng), ahora)) continue;
    const marcado: EstadoChequeo = { ...estado, lastAlertAt: ahora, lastAlertKind: 'long_stop' };
    await guardarEstado(r.id, marcado);
    await abrirChequeo(r, 'long_stop', estado.lastLat ?? 0, estado.lastLng ?? 0);
  }
}
