import { Router, Request, Response } from "express";
import { createContextLogger } from "../lib/logger";
import { getSearchBias, ensureZonesFresh } from "../services/serviceZones";
import { claveDeServidor } from '../services/mapsKeys';

export const geocodeRouter = Router();

const log = createContextLogger('GEOCODE');
const GOOGLE_KEY = claveDeServidor(process.env);

// ── In-memory geocode cache ───────────────────────────────────────────────────
// Each bucket is a Map<key, {value, expiresAt}>. When a bucket reaches its cap
// the oldest 20 % of entries are evicted (expired-first, then FIFO) so memory
// stays bounded without a full scan on every write.
interface CacheEntry { value: unknown; expiresAt: number }
type CacheBucket = Map<string, CacheEntry>;

// ── Google Maps API response shape interfaces ─────────────────────────────────
interface GeoStep {
  maneuver?: string; html_instructions?: string;
  distance?: { value: number }; duration?: { value: number };
  polyline?: { points: string };
}
interface GeoLeg {
  distance?: { value: number; text: string };
  duration?: { value: number; text: string };
  steps?: GeoStep[];
}
interface DirectionsResponse {
  routes?: Array<{ legs?: GeoLeg[]; overview_polyline?: { points: string } }>;
  status?: string;
}
interface AutocompleteResponse {
  predictions?: Array<{ description: string; place_id?: string }>;
  status?: string; error_message?: string;
}
interface GeocodingResponse {
  results?: Array<{ formatted_address?: string; geometry?: { location?: { lat: number; lng: number } } }>;
  status?: string;
}
interface PlaceDetailsResponse {
  result?: { geometry?: { location?: { lat: number; lng: number } }; formatted_address?: string };
  status?: string;
}

function makeBucket(): CacheBucket { return new Map(); }

function cacheGet(bucket: CacheBucket, key: string): unknown | undefined {
  const entry = bucket.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { bucket.delete(key); return undefined; }
  return entry.value;
}

function cacheSet(bucket: CacheBucket, key: string, value: unknown, ttlMs: number, maxEntries: number): void {
  if (bucket.size >= maxEntries) {
    const evict = Math.ceil(maxEntries * 0.2);
    const now = Date.now();
    let removed = 0;
    for (const [k, v] of bucket) {
      if (removed >= evict) break;
      if (now > v.expiresAt) { bucket.delete(k); removed++; }
    }
    if (removed < evict) {
      let extra = evict - removed;
      for (const k of bucket.keys()) {
        if (extra-- <= 0) break;
        bucket.delete(k);
      }
    }
  }
  bucket.set(key, { value, expiresAt: Date.now() + ttlMs });
}

const TTL = {
  SUGGEST:    5  * 60 * 1000,          // 5 min  — autocomplete is stable but not permanent
  REVERSE:    24 * 60 * 60 * 1000,     // 24 h   — an address at a lat/lng rarely changes
  PLACE:      7  * 24 * 60 * 60 * 1000,// 7 days — place_id is permanent
  FORWARD:    24 * 60 * 60 * 1000,     // 24 h   — same address text → same coords
  DIRECTIONS: 3  * 60 * 1000,          // 3 min  — traffic changes, keep short
};
const MAX = { SUGGEST: 2000, REVERSE: 5000, PLACE: 10000, FORWARD: 2000, DIRECTIONS: 1000 };

const cache = {
  suggest:    makeBucket(),
  reverse:    makeBucket(),
  place:      makeBucket(),
  forward:    makeBucket(),
  directions: makeBucket(),
};

// Purge all expired entries every 10 minutes to keep memory tidy on long-lived containers
setInterval(() => {
  const now = Date.now();
  for (const bucket of Object.values(cache)) {
    for (const [k, v] of bucket) {
      if (now > v.expiresAt) bucket.delete(k);
    }
  }
}, 10 * 60 * 1000).unref();

// ── Decode a Google polyline encoded string into [lng, lat] pairs ─────────────
function decodePolyline(encoded: string): Array<[number, number]> {
  const coords: Array<[number, number]> = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b: number, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lng / 1e5, lat / 1e5]);
  }
  return coords;
}

// ── GET /api/geocode/directions — proxy to Google Directions API ──────────────
geocodeRouter.get('/directions', async (req: Request, res: Response) => {
  const { originLat, originLng, destLat, destLng, waypoints } = req.query as Record<string, string>;
  if (!originLat || !originLng || !destLat || !destLng) { res.status(400).json(null); return; }
  if (!GOOGLE_KEY) { res.status(503).json(null); return; }

  // Normalise coords to 5 dp (~1 m) so minor GPS jitter reuses cached routes
  const oLat  = parseFloat(originLat).toFixed(5);
  const oLng  = parseFloat(originLng).toFixed(5);
  const dLat  = parseFloat(destLat).toFixed(5);
  const dLng  = parseFloat(destLng).toFixed(5);
  const wpKey = waypoints ? `|wp:${waypoints}` : '';
  const cacheKey = `${oLat},${oLng}->${dLat},${dLng}${wpKey}`;

  const cached = cacheGet(cache.directions, cacheKey);
  if (cached !== undefined) { res.json(cached); return; }

  const wpParam = waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : '';
  const url = [
    'https://maps.googleapis.com/maps/api/directions/json',
    `?origin=${oLat},${oLng}`,
    `&destination=${dLat},${dLng}`,
    `&mode=driving`,
    wpParam,
    `&key=${GOOGLE_KEY}`,
  ].join('');

  try {
    const r = await fetch(url);
    if (!r.ok) { res.json(null); return; }
    const data = await r.json() as DirectionsResponse;
    if (!data.routes || data.routes.length === 0) { res.json(null); return; }

    const route = data.routes[0];
    const leg = route.legs?.[0];
    if (!leg) { res.json(null); return; }
    const coordinates = decodePolyline(route.overview_polyline?.points ?? '');
    const distanceMeters: number = leg.distance?.value ?? 0;
    const durationSeconds: number = leg.duration?.value ?? 0;
    const distKm = distanceMeters / 1000;
    const durationMin = Math.round(durationSeconds / 60);

    const steps = (leg.steps ?? []).map((s) => {
      const maneuver: string = s.maneuver || 'straight';
      const parts = maneuver.split('-');
      const maneuverType = parts[0] || 'straight';
      const maneuverModifier = parts.slice(1).join('-') || undefined;
      const instruction = s.html_instructions?.replace(/<[^>]*>/g, '') ?? '';
      const stepCoords = decodePolyline(s.polyline?.points ?? '');
      return {
        distance: s.distance?.value ?? 0,
        duration: s.duration?.value ?? 0,
        instruction,
        maneuverType,
        maneuverModifier,
        streetName: '',
        coordinates: stepCoords,
      };
    });

    const result = {
      coordinates,
      distanceMeters,
      durationSeconds,
      distanceText: distKm < 1 ? `${Math.round(distanceMeters)} m` : `${distKm.toFixed(1)} km`,
      durationText: `${durationMin} min`,
      steps,
    };
    cacheSet(cache.directions, cacheKey, result, TTL.DIRECTIONS, MAX.DIRECTIONS);
    res.json(result);
  } catch {
    res.json(null);
  }
});

// El centro, el radio, la caja y EL PAÍS con que se busca una dirección salen de
// `service_zones` (ver services/serviceZones.ts). Antes eran constantes con las
// coordenadas de Miami y un `country:us` fijo: abrir una segunda ciudad dejaba a
// sus pasajeros con el autocompletado apuntando a Florida, y abrir un segundo
// país los dejaba sin poder encontrar una sola dirección de su propio país.
//
// Cuando el pasajero manda GPS y cae en una zona, esto pasa de ser un sesgo a
// filtrar de verdad: ver `strictbounds` en /suggest.

// GET /api/geocode/suggest?q=...&lat=...&lng=...&lang=...
// `location` + `radius` orientan la búsqueda al área de servicio. Ojo con
// `strictbounds` más abajo: con él la pareja deja de ser una sugerencia y pasa a
// filtrar de verdad.
geocodeRouter.get('/suggest', async (req: Request, res: Response) => {
  const { q, lat, lng, lang } = req.query as Record<string, string>;
  if (!q || q.trim().length < 2) { res.json([]); return; }
  if (!GOOGLE_KEY) { log.info('[GEOCODE/suggest] NO API KEY'); res.json([]); return; }

  await ensureZonesFresh();

  const latNum = (lat !== undefined && lat !== '') ? Number(lat) : NaN;
  const lngNum = (lng !== undefined && lng !== '') ? Number(lng) : NaN;
  const sesgo = getSearchBias(latNum, lngNum);

  // Con la zona del pasajero resuelta, el círculo que se manda a Google ES su
  // zona —centro y radio de la zona, no el punto del pasajero—, porque abajo se
  // aplica `strictbounds` y el círculo pasa a ser el filtro: centrado en el
  // pasajero dejaría entrar direcciones a un radio entero fuera del área.
  // Sin zona resuelta se mantiene el sesgo blando de siempre, centrado en su GPS.
  const biasLat  = sesgo.zoneId ? String(sesgo.lat) : (Number.isFinite(latNum) ? String(latNum) : String(sesgo.lat));
  const biasLng  = sesgo.zoneId ? String(sesgo.lng) : (Number.isFinite(lngNum) ? String(lngNum) : String(sesgo.lng));
  const language = (lang && /^[a-z]{2}(-[A-Z]{2})?$/.test(lang)) ? lang : 'en';

  // Los países salen de las zonas activas. Esta línea estuvo fija en
  // `country:us`, y al activar Barranquilla el autocompletado dejó de encontrar
  // direcciones colombianas: devolvía vacío, o calles de Florida a quien escribía
  // desde Colombia. La API de autocompletado acepta hasta cinco países.
  const componentes = sesgo.countries.length > 0
    ? `&components=${sesgo.countries.map((c) => `country:${c}`).join('%7C')}`
    : '';

  // La clave incluye el sesgo y los países, así que ampliar una zona o abrir un
  // país desde el panel no sirve sugerencias cacheadas con el área anterior.
  // Se redondea a 3 decimales (~110 m): un paso del pasajero no debe fallar la caché.
  const cacheKey = [
    q.trim().toLowerCase(),
    `${parseFloat(biasLat).toFixed(3)},${parseFloat(biasLng).toFixed(3)}`,
    sesgo.radiusM,
    language,
    sesgo.countries.join(','),
    sesgo.zoneId ?? '-',
  ].join('|');
  const cached = cacheGet(cache.suggest, cacheKey);
  if (cached !== undefined) { res.json(cached); return; }

  const url = [
    'https://maps.googleapis.com/maps/api/place/autocomplete/json',
    `?input=${encodeURIComponent(q)}`,
    `&key=${GOOGLE_KEY}`,
    `&location=${biasLat},${biasLng}`,
    `&radius=${sesgo.radiusM}`,
    componentes,
    // `strictbounds` no sesga: FILTRA todo lo que quede fuera de location+radius.
    // Se aplica cuando sabemos en qué zona está ESTE pasajero, porque entonces el
    // círculo es real —el de su zona— y nadie puede escribir una dirección que no
    // podemos servir. Antes la condición era «hay una sola zona en todo el
    // sistema», así que al abrir la segunda ciudad el filtro se apagó para todos,
    // incluidos los pasajeros de Miami, que empezaron a ver Orlando y Seattle.
    sesgo.zoneId ? `&strictbounds=true` : '',
    `&language=${language}`,
  ].join('');

  try {
    const r = await fetch(url);
    if (!r.ok) { log.info(` Google API not ok: ${r.status}`); res.json([]); return; }
    const data = await r.json() as AutocompleteResponse;

    if (!data.predictions) {
      // Surface the actual Google status so it's easy to diagnose API key / billing issues.
      // Common statuses: ZERO_RESULTS (no match), REQUEST_DENIED (key/billing problem),
      // INVALID_REQUEST (bad params), OVER_QUERY_LIMIT (quota exceeded).
      const status = data.status || 'UNKNOWN';
      if (status === 'REQUEST_DENIED') {
        log.error(` REQUEST_DENIED — Places API may not be enabled for this key, or billing is not active. Error: ${data.error_message || '(no message)'}`);
      } else {
        log.info(` No predictions for "${q}", status=${status}`);
      }
      res.json([]);
      return;
    }

    const suggestions = data.predictions
      .filter(p => !!p.description)
      .map(p => ({
        description: p.description as string,
        place_id: (p.place_id ?? '') as string,
      }));

    log.info(` Returning ${suggestions.length} results for "${q}"`);
    cacheSet(cache.suggest, cacheKey, suggestions, TTL.SUGGEST, MAX.SUGGEST);
    res.json(suggestions);
  } catch (err) {
    log.error(`[GEOCODE/suggest] Error: ${err}`);
    res.json([]);
  }
});

// GET /api/geocode/reverse?lat=...&lng=...
geocodeRouter.get('/reverse', async (req: Request, res: Response) => {
  const { lat, lng } = req.query as Record<string, string>;
  if (!lat || !lng) { res.json({ address: 'Current Location' }); return; }
  if (!GOOGLE_KEY) { res.json({ address: 'Current Location' }); return; }

  // Round to 4 dp (~11 m) — two readings that close share the same address
  const rLat = parseFloat(lat).toFixed(4);
  const rLng = parseFloat(lng).toFixed(4);
  const cacheKey = `${rLat},${rLng}`;

  const cached = cacheGet(cache.reverse, cacheKey);
  if (cached !== undefined) { res.json(cached); return; }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${rLat},${rLng}&key=${GOOGLE_KEY}`;

  try {
    const r = await fetch(url);
    if (!r.ok) { res.json({ address: 'Current Location' }); return; }
    const data = await r.json() as GeocodingResponse;

    const result = (data.results && data.results.length > 0)
      ? { address: data.results[0].formatted_address ?? 'Current Location' }
      : { address: 'Current Location' };

    cacheSet(cache.reverse, cacheKey, result, TTL.REVERSE, MAX.REVERSE);
    res.json(result);
  } catch {
    res.json({ address: 'Current Location' });
  }
});

// GET /api/geocode/place?place_id=...
// Resolves a Google Places place_id to exact coordinates + formatted address.
// This is the recommended way to get coords for a user-selected autocomplete
// suggestion — never re-geocode the description text, which can match elsewhere.
geocodeRouter.get('/place', async (req: Request, res: Response) => {
  const { place_id } = req.query as Record<string, string>;
  if (!place_id || !/^[A-Za-z0-9_-]+$/.test(place_id)) { res.json(null); return; }
  if (!GOOGLE_KEY) { res.json(null); return; }

  const cached = cacheGet(cache.place, place_id);
  if (cached !== undefined) { res.json(cached); return; }

  const url = [
    'https://maps.googleapis.com/maps/api/place/details/json',
    `?place_id=${encodeURIComponent(place_id)}`,
    `&fields=geometry/location,formatted_address`,
    `&key=${GOOGLE_KEY}`,
  ].join('');

  try {
    const r = await fetch(url);
    if (!r.ok) { res.json(null); return; }
    const data = await r.json() as PlaceDetailsResponse;
    const loc = data?.result?.geometry?.location;
    if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
      res.json(null);
      return;
    }
    const result = {
      lat: loc.lat,
      lng: loc.lng,
      address: data.result?.formatted_address ?? null,
    };
    cacheSet(cache.place, place_id, result, TTL.PLACE, MAX.PLACE);
    res.json(result);
  } catch {
    res.json(null);
  }
});

// GET /api/geocode/forward?q=...&lat=...&lng=...
// `bounds` es sólo una pista de encuadre: prioriza resultados dentro del área de
// servicio, no los limita a ella. La caja es la unión de las zonas activas.
// `lat`/`lng` son opcionales —el GPS del pasajero— y sólo sirven para saber en qué
// país buscar; los APK que no los mandan siguen funcionando.
geocodeRouter.get('/forward', async (req: Request, res: Response) => {
  const { q, lat, lng } = req.query as Record<string, string>;
  if (!q) { res.json(null); return; }
  if (!GOOGLE_KEY) { res.json(null); return; }

  await ensureZonesFresh();

  const latNum = (lat !== undefined && lat !== '') ? Number(lat) : NaN;
  const lngNum = (lng !== undefined && lng !== '') ? Number(lng) : NaN;
  const sesgo = getSearchBias(latNum, lngNum);

  // UN solo país —el de la zona del pasajero—, y si no se sabe, NINGUNO.
  //
  // Aquí no vale la unión que sí usa el autocompletado: comprobado contra Google,
  // `country:US|country:CO` sobre «Calle 84 #45-20, Barranquilla» responde con el
  // centroide de la ciudad, a unos 2 km de la calle pedida, mientras un solo país
  // o ninguna restricción devuelven el portal exacto.
  //
  // Y por eso el caso sin GPS va sin restricción en vez de caer a 'us': forzar
  // EE. UU. era lo que geocodificaba esa dirección de Barranquilla en Colorado —
  // un 200 con un punto equivocado a 4.000 km, que es peor que no responder.
  const componentes = sesgo.country ? `&components=country:${sesgo.country}` : '';

  // La caja y el país entran en la clave: si cambia el área o el país del
  // pasajero, la respuesta puede cambiar.
  const cacheKey = [
    q.trim().toLowerCase(),
    sesgo.boundsSw,
    sesgo.boundsNe,
    sesgo.country ?? 'any',
  ].join('|');
  const cached = cacheGet(cache.forward, cacheKey);
  if (cached !== undefined) { res.json(cached); return; }

  const url = [
    'https://maps.googleapis.com/maps/api/geocode/json',
    `?address=${encodeURIComponent(q)}`,
    `&key=${GOOGLE_KEY}`,
    componentes,
    `&bounds=${sesgo.boundsSw}|${sesgo.boundsNe}`,
  ].join('');

  try {
    const r = await fetch(url);
    if (!r.ok) { res.json(null); return; }
    const data = await r.json() as GeocodingResponse;

    if (data.results && data.results.length > 0) {
      const location = data.results[0].geometry?.location;
      if (!location) { res.json(null); return; }
      const result = { lat: location.lat, lng: location.lng };
      cacheSet(cache.forward, cacheKey, result, TTL.FORWARD, MAX.FORWARD);
      res.json(result);
    } else {
      res.json(null);
    }
  } catch {
    res.json(null);
  }
});
