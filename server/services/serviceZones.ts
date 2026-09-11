/**
 * Zonas de servicio: dónde opera Urbont.
 *
 * Antes era un círculo con centro y radio hardcodeados en `rides/create.ts`, así
 * que abrir una ciudad exigía un despliegue. Ahora vive en `service_zones` y el
 * panel puede crear, ajustar y desactivar zonas sin tocar código.
 *
 * LA VERIFICACIÓN OCURRE EN MEMORIA, no contra la base. Cuando el pasajero
 * arrastra el destino en el mapa la app pide una cotización por cada movimiento,
 * y cada una valida origen y destino: son decenas de comprobaciones por reserva.
 * Medido, 100 zonas en memoria cuestan 0,27 µs con el prefiltro de caja; una
 * consulta a Postgres son 1-5 ms. La base guarda y el panel edita; el camino
 * caliente no la toca.
 *
 * Mismo esqueleto que `services/fareConfig.ts`, incluida la lección que dejó:
 * el TTL sólo sirve si alguien llama al refresco desde las rutas que consultan.
 */

import { pool } from '../db/pool';
import { logger } from '../lib/logger';

export interface ServiceZone {
  id: string;
  name: string;
  active: boolean;
  /** Zona horaria de la ciudad. El surge se calcula con su hora local. */
  timezone: string;
  /**
   * País de la zona. ISO 3166-1 alpha-2 en mayúscula: 'US', 'CO'.
   *
   * Obligatorio a propósito, sin valor por defecto en el tipo. La restricción de
   * país de la búsqueda de direcciones estaba fija en `country:us` dentro de
   * `geocode.ts`, y al activar Barranquilla el autocompletado dejó de encontrar
   * direcciones colombianas y la geocodificación devolvía un punto en EE. UU. sin
   * error. Una zona sin país declarado es exactamente lo que produjo ese fallo.
   */
  countryCode: string;
  /** Forma de círculo. Se ignora si hay polígono. */
  centerLat: number | null;
  centerLng: number | null;
  radiusKm: number | null;
  /** true si la fila tiene polígono; la prueba exacta se hace en Postgres. */
  hasBoundary: boolean;
  /** Caja envolvente precalculada — el prefiltro que hace barata la búsqueda. */
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null;
}

/**
 * Zona por defecto: el mismo círculo que estaba en el código.
 *
 * Es la red si la base no responde al arrancar. Quedarse sin zonas dejaría la
 * plataforma sin poder aceptar un solo viaje, que es peor que operar con un área
 * desactualizada.
 */
const DEFAULT_ZONE: ServiceZone = {
  id: 'miami',
  name: 'Miami / Sur de Florida',
  active: true,
  timezone: 'America/New_York',
  countryCode: 'US',
  centerLat: 25.7617,
  centerLng: -80.1918,
  radiusKm: 125,
  hasBoundary: false,
  bbox: null,
};

let activeZones: ServiceZone[] = [withBbox(DEFAULT_ZONE)];
let lastLoadedAt = 0;
let loading: Promise<void> | null = null;

const TTL_MS = 5 * 60 * 1000;
const EARTH_RADIUS_KM = 6371;

/* ── Geometría ──────────────────────────────────────────────────────────── */

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Caja que contiene al círculo, con margen.
 *
 * Un grado de latitud son ~111 km en todo el planeta; uno de longitud se encoge
 * con el coseno de la latitud. Se aplica un 1% de holgura para que la caja nunca
 * recorte un punto que el círculo sí aceptaría: un falso negativo aquí sería un
 * viaje rechazado sin motivo.
 */
function withBbox(z: ServiceZone): ServiceZone {
  if (z.centerLat === null || z.centerLng === null || !z.radiusKm) return { ...z, bbox: null };

  const dLat = (z.radiusKm / 111) * 1.01;
  const cos = Math.max(0.01, Math.cos((z.centerLat * Math.PI) / 180));
  const dLng = (z.radiusKm / (111 * cos)) * 1.01;

  return {
    ...z,
    bbox: {
      minLat: z.centerLat - dLat,
      maxLat: z.centerLat + dLat,
      minLng: z.centerLng - dLng,
      maxLng: z.centerLng + dLng,
    },
  };
}

function inBbox(z: ServiceZone, lat: number, lng: number): boolean {
  if (!z.bbox) return true; // sin caja no se puede descartar: pasa a la prueba exacta
  return lat >= z.bbox.minLat && lat <= z.bbox.maxLat && lng >= z.bbox.minLng && lng <= z.bbox.maxLng;
}

/* ── Resolución ─────────────────────────────────────────────────────────── */

/**
 * La zona activa que contiene el punto, o `null` si ninguna.
 *
 * Dos pasos: el prefiltro de caja descarta casi todas las zonas con cuatro
 * comparaciones, y la prueba exacta sólo corre sobre las que sobreviven. El coste
 * crece con las zonas que solapan el punto, no con el total.
 *
 * Las zonas con polígono se omiten aquí — su prueba exacta necesitaría PostGIS.
 * Hoy no existen: todas son círculos, así que esto basta.
 */
export function resolveZone(lat: number, lng: number): ServiceZone | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  for (const z of activeZones) {
    if (z.hasBoundary) continue;
    if (!inBbox(z, lat, lng)) continue;
    if (z.centerLat === null || z.centerLng === null || !z.radiusKm) continue;
    if (haversineKm(z.centerLat, z.centerLng, lat, lng) <= z.radiusKm) return z;
  }
  return null;
}

// Cuando existan polígonos hará falta una variante asíncrona que caiga a PostGIS
// (`ST_Contains`) para las zonas que no sean círculos. No se escribe todavía:
// PostGIS está instalado en el esquema `tiger` y sus tipos no se resuelven, así
// que sería código muerto apuntando a una columna que no existe — exactamente lo
// que veníamos corrigiendo en este backend.

/** Todas las zonas vigentes, activas o no — para el panel. */
export function getZones(): ServiceZone[] {
  return activeZones.map((z) => ({ ...z }));
}

export interface SearchBias {
  /** Centro del círculo de búsqueda: el de la zona del pasajero, o el de la mayor. */
  lat: number;
  lng: number;
  /** Radio del sesgo, en metros — lo que espera la API de Google. */
  radiusM: number;
  /** Esquinas de la caja que cubre todas las zonas activas, `lat,lng`. */
  boundsSw: string;
  boundsNe: string;
  /** Cuántas zonas cubre este sesgo. Con más de una, un solo círculo no alcanza. */
  zonasActivas: number;
  /**
   * Unión de los países de las zonas activas, alpha-2 en minúscula: `['us','co']`.
   * Para el autocompletado, que tolera varios países a la vez.
   */
  countries: string[];
  /**
   * País de la zona en la que está el pasajero, o `null` si no se sabe.
   *
   * Separado de `countries` porque la API de geocodificación NO se comporta igual
   * que la de autocompletado: con varios países devuelve el centroide de la ciudad
   * en vez de la calle pedida. Ahí hace falta uno solo, o ninguno.
   */
  country: string | null;
  /**
   * Zona resuelta a partir del GPS del pasajero, o `null`.
   *
   * Es lo que permite volver a filtrar duro: sabiendo su zona, `lat`+`radiusM`
   * describen un círculo real y `strictbounds` recorta exactamente el área de
   * servicio.
   */
  zoneId: string | null;
}

/**
 * Sesgo de búsqueda de direcciones, derivado de las zonas activas.
 *
 * Existe porque si no, abrir una segunda ciudad dejaría a sus pasajeros buscando
 * direcciones sesgadas hacia Miami — y, mientras el país estuvo fijo en el
 * código, sin poder encontrar ninguna dirección de su propio país.
 *
 * **Con GPS** se resuelve la zona del pasajero y todo sale de ella: centro, radio
 * y país. Es el caso que importa, porque es el que permite filtrar de verdad.
 *
 * **Sin GPS** el centro es el de la zona más grande —con varias abiertas, el
 * mercado principal es la apuesta razonable—, la caja es la unión de todas y el
 * país queda en `null`: preferimos no restringir a arriesgarnos a restringir al
 * país equivocado.
 *
 * @param lat Latitud del pasajero, si la manda. Se ignora si no es finita.
 * @param lng Longitud del pasajero, idem.
 */
export function getSearchBias(lat?: number, lng?: number): SearchBias {
  const zonas = activeZones.filter((z) => z.bbox !== null);

  // Los países salen de TODAS las zonas activas, no sólo de las que tienen caja:
  // una zona con polígono —cuando existan— también tiene que aportar el suyo.
  const countries = [
    ...new Set(
      activeZones
        .map((z) => (z.countryCode ?? '').trim().toLowerCase())
        .filter((c) => c.length === 2),
    ),
  ];

  if (zonas.length === 0) {
    return {
      lat: DEFAULT_ZONE.centerLat!,
      lng: DEFAULT_ZONE.centerLng!,
      radiusM: DEFAULT_ZONE.radiusKm! * 1000,
      boundsSw: '25.10,-80.90',
      boundsNe: '26.70,-80.00',
      zonasActivas: 1,
      countries: countries.length > 0 ? countries : [DEFAULT_ZONE.countryCode.toLowerCase()],
      country: null,
      zoneId: null,
    };
  }

  // La zona del pasajero, si el GPS cae dentro de alguna. `resolveZone` ya
  // descarta coordenadas no finitas, así que no hace falta validarlas aquí.
  const propia = resolveZone(lat as number, lng as number);

  const mayor = zonas.reduce((a, b) => ((b.radiusKm ?? 0) > (a.radiusKm ?? 0) ? b : a));
  const centro = propia ?? mayor;

  const sw = { lat: Infinity, lng: Infinity };
  const ne = { lat: -Infinity, lng: -Infinity };
  for (const z of zonas) {
    sw.lat = Math.min(sw.lat, z.bbox!.minLat);
    sw.lng = Math.min(sw.lng, z.bbox!.minLng);
    ne.lat = Math.max(ne.lat, z.bbox!.maxLat);
    ne.lng = Math.max(ne.lng, z.bbox!.maxLng);
  }

  return {
    lat: centro.centerLat!,
    lng: centro.centerLng!,
    radiusM: Math.round((centro.radiusKm ?? 100) * 1000),
    boundsSw: `${sw.lat.toFixed(2)},${sw.lng.toFixed(2)}`,
    boundsNe: `${ne.lat.toFixed(2)},${ne.lng.toFixed(2)}`,
    zonasActivas: zonas.length,
    countries,
    country: propia ? propia.countryCode.trim().toLowerCase() : null,
    zoneId: propia?.id ?? null,
  };
}

/* ── Carga ──────────────────────────────────────────────────────────────── */

interface ZoneRow {
  id: string;
  name: string;
  active: boolean;
  timezone: string;
  country_code: string | null;
  center_lat: string | null;
  center_lng: string | null;
  radius_km: string | null;
  has_boundary: boolean;
}

function toZone(r: ZoneRow): ServiceZone {
  const num = (v: string | null) => (v === null ? null : Number(v));
  return withBbox({
    id: r.id,
    name: r.name,
    active: r.active,
    timezone: r.timezone,
    // La columna es NOT NULL con default 'US', pero se normaliza igual: una fila
    // creada a mano con 'us' o ' Co ' no debe cambiar el resultado.
    countryCode: (r.country_code ?? 'US').trim().toUpperCase() || 'US',
    centerLat: num(r.center_lat),
    centerLng: num(r.center_lng),
    radiusKm: num(r.radius_km),
    hasBoundary: r.has_boundary,
    bbox: null,
  });
}

/**
 * Lee las zonas activas y las deja vigentes. Nunca lanza: ante un fallo se sigue
 * con lo que haya en memoria.
 */
export async function loadZones(force = false): Promise<void> {
  if (!force && Date.now() - lastLoadedAt < TTL_MS) return;
  if (loading) return loading;

  loading = (async () => {
    try {
      const { rows } = await pool.query<ZoneRow>(
        `SELECT id, name, active, timezone, country_code,
                center_lat, center_lng, radius_km,
                false AS has_boundary
           FROM service_zones
          WHERE active
          ORDER BY id`,
      );

      if (rows.length === 0) {
        // Sin zonas activas nadie podría reservar. Se mantiene la de por defecto
        // y se avisa fuerte: es un estado que sólo puede venir de un error.
        activeZones = [withBbox(DEFAULT_ZONE)];
        lastLoadedAt = Date.now();
        logger.warn('[Zonas] Ninguna zona activa en la base — vigente la de Miami por defecto');
        return;
      }

      activeZones = rows.map(toZone);
      lastLoadedAt = Date.now();
      // El país entra en el log: es lo que decide en qué país se buscan las
      // direcciones, y conviene poder verlo sin consultar la base.
      logger.info(
        `[Zonas] ${rows.length} activa(s): ${activeZones.map((z) => `${z.id}/${z.countryCode}`).join(', ')}`,
      );
    } catch (err) {
      logger.error(`[Zonas] No se pudieron cargar, sigue vigente lo que hubiera: ${(err as Error).message}`);
    } finally {
      loading = null;
    }
  })();

  return loading;
}

/** Fuerza una relectura. La llama el panel tras guardar. */
export async function invalidateZones(): Promise<void> {
  lastLoadedAt = 0;
  await loadZones(true);
}

/**
 * Se llama al principio de cada ruta que valida ubicación.
 *
 * Es lo que hace que el TTL sirva: `loadZones()` sale de inmediato si la lectura
 * es reciente, así que el coste real es una consulta cada cinco minutos por
 * instancia. Sin esto, la caché sólo se refrescaría al arrancar y al guardar — y
 * en ECS la instancia que no atendió el guardado se quedaría con el área vieja.
 */
export async function ensureZonesFresh(): Promise<void> {
  try {
    await loadZones(false);
  } catch {
    /* loadZones ya registra el error */
  }
}

/** Vuelve al estado inicial. Sólo para tests. */
export function resetZones(): void {
  activeZones = [withBbox(DEFAULT_ZONE)];
  lastLoadedAt = 0;
}

/** Reemplaza las zonas vigentes sin tocar la base. Sólo para tests. */
export function setZones(zones: ServiceZone[]): void {
  activeZones = zones.map(withBbox);
}
