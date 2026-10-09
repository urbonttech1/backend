/**
 * Reglas del aviso "¿Estás bien?". No habla con la base.
 *
 * La desviación de ruta ya existía en rideCheck.ts. Aquí se suman la parada
 * larga y la frenada brusca, y se decide cuándo se puede volver a avisar.
 */

export const PARADA_MS = 5 * 60 * 1000;
export const PARADA_MPS = 1.2;
export const CERCA_DESTINO_M = 250;
export const FRENAZO_DESDE_MPS = 11;
export const FRENAZO_HASTA_MPS = 2.5;
export const FRENAZO_VENTANA_MS = 15_000;
export const DESVIO_M = 2000;
export const LEJOS_DE_PUNTA_M = 400;
export const COOLDOWN_MS = 20 * 60 * 1000;
export const PING_RECIENTE_MS = 20 * 60 * 1000;

export type Anomalia = 'long_stop' | 'harsh_brake' | 'off_route';

export interface Punto { lat: number; lng: number }

export interface EstadoChequeo {
  stoppedSince: number | null;
  lastLat: number | null;
  lastLng: number | null;
  lastSpeedMps: number | null;
  lastPingAt: number | null;
  lastAlertAt: number | null;
  lastAlertKind: Anomalia | null;
}

export interface PingChequeo {
  at: number;
  lat: number;
  lng: number;
  speedMps: number | null;
  harshBrake?: boolean;
  pickup: Punto | null;
  dropoff: Punto | null;
  bloqueado: boolean;
}

export const estadoVacio = (): EstadoChequeo => ({
  stoppedSince: null,
  lastLat: null,
  lastLng: null,
  lastSpeedMps: null,
  lastPingAt: null,
  lastAlertAt: null,
  lastAlertKind: null,
});

export function mensaje(kind: Anomalia): { title: string; body: string } {
  if (kind === 'long_stop') {
    return {
      title: 'Are you OK?',
      body: 'We noticed an unexpected long stop. ¿Estás bien? Notamos una parada larga.',
    };
  }
  if (kind === 'harsh_brake') {
    return {
      title: 'Are you OK?',
      body: 'We detected a possible hard stop. ¿Estás bien? Detectamos una frenada brusca.',
    };
  }
  return {
    title: 'Are you OK?',
    body: 'This trip is far off the expected route. ¿Estás bien? La ruta va muy desviada.',
  };
}

export function distanciaMetros(a: Punto, b: Punto): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function aMetros(origen: Punto, p: Punto): { x: number; y: number } {
  const y = ((p.lat - origen.lat) * Math.PI / 180) * 6371000;
  const x = ((p.lng - origen.lng) * Math.PI / 180) * 6371000 * Math.cos((origen.lat * Math.PI) / 180);
  return { x, y };
}

export function distanciaASegmento(p: Punto, a: Punto, b: Punto): number {
  const A = aMetros(a, a);
  const B = aMetros(a, b);
  const P = aMetros(a, p);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const largo2 = dx * dx + dy * dy;
  if (largo2 < 1) return Math.hypot(P.x, P.y);
  const t = Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / largo2));
  return Math.hypot(P.x - dx * t, P.y - dy * t);
}

function cercaDe(p: Punto, destino: Punto | null, metros: number): boolean {
  return !!destino && distanciaMetros(p, destino) <= metros;
}

function enCooldown(estado: EstadoChequeo, kind: Anomalia, ahora: number): boolean {
  if (estado.lastAlertAt == null || estado.lastAlertKind !== kind) return false;
  return ahora - estado.lastAlertAt < COOLDOWN_MS;
}

export function evaluarChequeo(previo: EstadoChequeo, ping: PingChequeo): { estado: EstadoChequeo; anomalia: Anomalia | null } {
  const aqui: Punto = { lat: ping.lat, lng: ping.lng };
  const dt = previo.lastPingAt != null ? ping.at - previo.lastPingAt : null;
  const movido = previo.lastLat != null && previo.lastLng != null
    ? distanciaMetros({ lat: previo.lastLat, lng: previo.lastLng }, aqui)
    : 0;
  const inferida = dt != null && dt > 0 ? movido / (dt / 1000) : null;
  const reportada = ping.speedMps;
  const efectiva = reportada != null && reportada >= PARADA_MPS
    ? reportada
    : inferida != null && inferida >= PARADA_MPS
      ? inferida
      : reportada;

  const parado = efectiva != null && efectiva < PARADA_MPS && movido < 40;
  const stoppedSince = parado ? (previo.stoppedSince ?? ping.at) : null;

  const estado: EstadoChequeo = {
    ...previo,
    stoppedSince,
    lastLat: ping.lat,
    lastLng: ping.lng,
    lastSpeedMps: efectiva,
    lastPingAt: ping.at,
  };

  if (ping.bloqueado) return { estado, anomalia: null };

  const frenazoPorSensor = ping.harshBrake === true && (previo.lastSpeedMps ?? 0) >= 8;
  const frenazoPorGps = previo.lastSpeedMps != null
    && previo.lastSpeedMps >= FRENAZO_DESDE_MPS
    && efectiva != null
    && efectiva <= FRENAZO_HASTA_MPS
    && dt != null
    && dt > 0
    && dt <= FRENAZO_VENTANA_MS;
  if ((frenazoPorSensor || frenazoPorGps) && !enCooldown(previo, 'harsh_brake', ping.at)) {
    return { estado: { ...estado, lastAlertAt: ping.at, lastAlertKind: 'harsh_brake' }, anomalia: 'harsh_brake' };
  }

  const tieneRuta = ping.pickup && ping.dropoff && distanciaMetros(ping.pickup, ping.dropoff) > LEJOS_DE_PUNTA_M;
  if (tieneRuta && ping.pickup && ping.dropoff) {
    const desvio = distanciaASegmento(aqui, ping.pickup, ping.dropoff);
    const enUnaPunta = cercaDe(aqui, ping.pickup, LEJOS_DE_PUNTA_M) || cercaDe(aqui, ping.dropoff, LEJOS_DE_PUNTA_M);
    if (desvio >= DESVIO_M && !enUnaPunta && !enCooldown(previo, 'off_route', ping.at)) {
      return { estado: { ...estado, lastAlertAt: ping.at, lastAlertKind: 'off_route' }, anomalia: 'off_route' };
    }
  }

  const paradaLarga = stoppedSince != null
    && ping.at - stoppedSince >= PARADA_MS
    && !cercaDe(aqui, ping.dropoff, CERCA_DESTINO_M);
  if (paradaLarga && !enCooldown(previo, 'long_stop', ping.at)) {
    return { estado: { ...estado, lastAlertAt: ping.at, lastAlertKind: 'long_stop' }, anomalia: 'long_stop' };
  }

  return { estado, anomalia: null };
}

export function paradaVencidaEnSilencio(estado: EstadoChequeo, dropoff: Punto | null, ahora: number): boolean {
  if (estado.stoppedSince == null || estado.lastPingAt == null || estado.lastLat == null || estado.lastLng == null) return false;
  if (ahora - estado.stoppedSince < PARADA_MS) return false;
  if (ahora - estado.lastPingAt > PING_RECIENTE_MS) return false;
  if (enCooldown(estado, 'long_stop', ahora)) return false;
  return !cercaDe({ lat: estado.lastLat, lng: estado.lastLng }, dropoff, CERCA_DESTINO_M);
}
