/**
 * La posición del chofer: cómo se guarda y cómo se reenvía.
 *
 * Dos caminos escribían en `driver_locations` con criterios distintos: por REST
 * se conservaba el rumbo anterior cuando el GPS no lo reportaba, y por socket se
 * escribía 0 —norte—, que al pasajero le giraba el mapa de golpe. Aquí está el
 * único camino, para los dos.
 *
 * La columna `location` es de PostGIS y sólo existe si la extensión está
 * habilitada. En producción no lo estaba, así que TODAS las actualizaciones de
 * GPS fallaban con «column "location" does not exist»: la tabla se quedaba
 * vacía, nadie aparecía conectado y los viajes se quedaban en «buscando».
 * Ahora lat/lng se guardan siempre y `location` se rellena cuando se puede.
 */
import { pool } from '../db/pool';
import { logger } from '../lib/logger';

/**
 * Un número que puede no venir. Devuelve `null` en vez de 0 cuando el GPS no
 * reporta rumbo o velocidad: 0 es un dato, «no sé» es otra cosa.
 */
export function numeroOpcional(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export interface UbicacionChofer {
  driverId: string;
  lat: number;
  lng: number;
  /** null = el dispositivo no lo reportó; se conserva el último conocido. */
  heading?: number | null;
  speed?: number | null;
}

/** Se apaga al primer fallo por falta de PostGIS, para no reintentarlo cada segundo. */
let hayPostGIS = true;

const COMUNES = `
  ON CONFLICT (driver_id) DO UPDATE SET
    lat        = EXCLUDED.lat,
    lng        = EXCLUDED.lng,
    -- heading/speed caían a 0 cuando el dispositivo mandaba null (pasa a menudo
    -- con el coche parado, cuando el GPS no calcula rumbo ni velocidad). Al
    -- pasajero la flecha le saltaba al norte. Se conserva el último valor bueno.
    heading    = COALESCE(EXCLUDED.heading, driver_locations.heading),
    speed      = COALESCE(EXCLUDED.speed, driver_locations.speed),
    is_online  = true,
    updated_at = NOW()`;

const CON_GEOGRAFIA = `
  INSERT INTO driver_locations (driver_id, lat, lng, heading, speed, location, is_online, updated_at)
  VALUES ($1, $2::float8, $3::float8, $4::float8, $5::float8,
          ST_SetSRID(ST_MakePoint($3::float8, $2::float8), 4326)::geography, true, NOW())
  ${COMUNES}, location = EXCLUDED.location`;

const SIN_GEOGRAFIA = `
  INSERT INTO driver_locations (driver_id, lat, lng, heading, speed, is_online, updated_at)
  VALUES ($1, $2::float8, $3::float8, $4::float8, $5::float8, true, NOW())
  ${COMUNES}`;

/** Guarda la posición. `updated_at` es siempre hora del servidor de base de datos. */
export async function guardarUbicacion(p: UbicacionChofer): Promise<void> {
  const valores = [p.driverId, p.lat, p.lng, numeroOpcional(p.heading), numeroOpcional(p.speed)];
  const client = await pool.connect();
  try {
    if (hayPostGIS) {
      try {
        await client.query(CON_GEOGRAFIA, valores);
        return;
      } catch (err: unknown) {
        // 42703 columna inexistente, 42883 función inexistente (sin PostGIS).
        const code = (err as { code?: string }).code;
        if (code !== '42703' && code !== '42883') throw err;
        hayPostGIS = false;
        logger.warn(`[GPS] driver_locations sin PostGIS (${code}) — se guarda sólo lat/lng`);
      }
    }
    await client.query(SIN_GEOGRAFIA, valores);
  } finally {
    client.release();
  }
}
