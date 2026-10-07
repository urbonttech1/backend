/**
 * Entradas y puntos de navegación de un lugar, tal como los devuelve
 * Places API (New). `entrances` son puertas (casi nunca tienen nombre).
 * `navigationPoints` son los sitios al borde de la vía donde debe terminar
 * el viaje, y suelen traer nombre ("Terminal internacional", "Garaje").
 *
 * `choices` es lo que se le pregunta al pasajero: los puntos con nombre si
 * hay al menos dos; si no, las puertas, distinguidas por el punto cardinal
 * respecto al centro del lugar. Un solo punto no se pregunta: se usa directo.
 */

export type Brujula = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export interface PuntoDeAcceso {
  id: string;
  source: 'entrance' | 'navigation';
  label: string | null;
  compass: Brujula | null;
  disambiguator: number | null;
  lat: number;
  lng: number;
  travelModes: string[];
  usages: string[];
  token: string | null;
}

export interface AccesosDeLugar {
  placeId: string;
  name: string;
  location: { lat: number; lng: number } | null;
  entrances: PuntoDeAcceso[];
  navigationPoints: PuntoDeAcceso[];
  choices: PuntoDeAcceso[];
}

interface LatLngGoogle { latitude?: number; longitude?: number }

export interface LugarGoogle {
  id?: string;
  displayName?: { text?: string };
  location?: LatLngGoogle;
  entrances?: Array<{ location?: LatLngGoogle }>;
  navigationPoints?: Array<{
    navigationPointToken?: string;
    displayName?: { text?: string };
    location?: LatLngGoogle;
    travelModes?: string[];
    usages?: string[];
  }>;
}

const DEDUPE_METROS = 35;
const BRUJULAS: Brujula[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

function coord(raw: LatLngGoogle | undefined): { lat: number; lng: number } | null {
  const lat = raw?.latitude;
  const lng = raw?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function texto(value: string | undefined): string | null {
  const limpio = value?.trim();
  return limpio ? limpio : null;
}

export function distanciaMetros(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function brujula(
  desde: { lat: number; lng: number },
  hasta: { lat: number; lng: number },
): Brujula {
  const dLng = ((hasta.lng - desde.lng) * Math.PI) / 180;
  const la1 = (desde.lat * Math.PI) / 180;
  const la2 = (hasta.lat * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  const grados = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return BRUJULAS[Math.round(grados / 45) % 8];
}

function dedupe(puntos: PuntoDeAcceso[]): PuntoDeAcceso[] {
  const salida: PuntoDeAcceso[] = [];
  for (const punto of puntos) {
    if (salida.some((ya) => distanciaMetros(ya, punto) < DEDUPE_METROS)) continue;
    salida.push(punto);
  }
  return salida;
}

function numerarMismaBrujula(puntos: PuntoDeAcceso[]): void {
  const totales = new Map<string, number>();
  for (const punto of puntos) {
    if (punto.label || !punto.compass) continue;
    totales.set(punto.compass, (totales.get(punto.compass) ?? 0) + 1);
  }
  const vistos = new Map<string, number>();
  for (const punto of puntos) {
    if (punto.label || !punto.compass) continue;
    const n = (vistos.get(punto.compass) ?? 0) + 1;
    vistos.set(punto.compass, n);
    punto.disambiguator = (totales.get(punto.compass) ?? 0) > 1 ? n : null;
  }
}

function idDe(prefijo: string, lat: number, lng: number, token: string | null): string {
  if (token) return token;
  return `${prefijo}:${lat.toFixed(5)},${lng.toFixed(5)}`;
}

export function organizarAccesos(raw: LugarGoogle | null | undefined): AccesosDeLugar {
  const location = coord(raw?.location);
  const entrances: PuntoDeAcceso[] = [];
  for (const puerta of raw?.entrances ?? []) {
    const donde = coord(puerta.location);
    if (!donde) continue;
    entrances.push({
      id: idDe('e', donde.lat, donde.lng, null),
      source: 'entrance',
      label: null,
      compass: location ? brujula(location, donde) : null,
      disambiguator: null,
      lat: donde.lat,
      lng: donde.lng,
      travelModes: [],
      usages: [],
      token: null,
    });
  }
  numerarMismaBrujula(entrances);

  const navigationPoints: PuntoDeAcceso[] = [];
  for (const punto of raw?.navigationPoints ?? []) {
    const donde = coord(punto.location);
    if (!donde) continue;
    const token = texto(punto.navigationPointToken);
    navigationPoints.push({
      id: idDe('n', donde.lat, donde.lng, token),
      source: 'navigation',
      label: texto(punto.displayName?.text),
      compass: location ? brujula(location, donde) : null,
      disambiguator: null,
      lat: donde.lat,
      lng: donde.lng,
      travelModes: Array.isArray(punto.travelModes) ? punto.travelModes.filter((m) => typeof m === 'string') : [],
      usages: Array.isArray(punto.usages) ? punto.usages.filter((u) => typeof u === 'string') : [],
      token,
    });
  }

  const conNombre = dedupe(navigationPoints.filter((p) => p.label));
  const puertas = dedupe(entrances);
  const choices = conNombre.length >= 2
    ? conNombre
    : puertas.length >= 2
      ? puertas
      : conNombre.length === 1
        ? conNombre
        : puertas.length === 1
          ? puertas
          : [];

  choices.sort((a, b) => (a.label ?? a.compass ?? '').localeCompare(b.label ?? b.compass ?? ''));

  return {
    placeId: raw?.id ?? '',
    name: texto(raw?.displayName?.text) ?? '',
    location,
    entrances,
    navigationPoints,
    choices,
  };
}
