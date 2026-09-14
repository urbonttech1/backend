import { Router, Request, Response } from "express";
import { requireSupabaseAuth } from "../middleware";
import { createContextLogger } from "../lib/logger";
import { pool } from "../db/pool";
import { getTimeSurge, getFareClasses, VEHICLE_ALIAS } from "../config/pricing";
import { ensureZonesFresh, getZones, resolveZone } from "../services/serviceZones";

const log = createContextLogger('CONFIG');
export const configRouter = Router();

const DEFAULTS = {
  maintenance_mode: false,
  min_version: '1.0.0',
  surge_multiplier: 1.0,
};

/**
 * Surge que un admin fijó a mano en `app_config`, combinado con el de franja
 * horaria. Se toma el MAYOR de los dos, que es la regla que la app ya aplica
 * (`screen-renderer.tsx:917`): un recargo manual por un evento puntual no debe
 * quedar anulado por la franja, ni al revés.
 *
 * Cachea 60 s: se consulta en cada cotización y el valor cambia muy de vez en
 * cuando. Ante un fallo de lectura devuelve sólo el de franja horaria — nunca
 * lanza, porque dejaría sin precio a toda la app.
 */
let surgeCache: { value: number; at: number } | null = null;
const SURGE_TTL_MS = 60_000;

export async function getEffectiveSurge(now: Date = new Date()): Promise<number> {
  const timeSurge = getTimeSurge(now);

  if (surgeCache && Date.now() - surgeCache.at < SURGE_TTL_MS) {
    return Math.max(timeSurge, surgeCache.value);
  }

  try {
    const { rows } = await pool.query<{ value: string }>(
      `SELECT value FROM app_config WHERE key = 'surge_multiplier'`
    );
    const manual = parseFloat(rows[0]?.value ?? '1') || 1;
    surgeCache = { value: manual, at: Date.now() };
    return Math.max(timeSurge, manual);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'no se pudo leer surge_multiplier — se usa sólo la franja horaria');
    return timeSurge;
  }
}

/**
 * Categorías de vehículo, con sus alias.
 *
 * Hay tres vocabularios en circulación: el registro de la app ofrece `SUV` y
 * `Sedan`, el editor de perfil usa `executive`/`suv`/`van`/`signature`, y las
 * tarifas se guardan bajo `sedan`/`suv`/`van`. Hoy no rompe nada porque
 * `normalizeVehicleCategory` y `VEHICLE_ALIAS` traducen entre ellos, pero son
 * tres listas que se mantienen por acuerdo tácito y ya hay una grieta:
 * `signature` y `concierge` tienen sala de reparto y **no tienen tarifa**.
 *
 * Publicarlas es el primer paso para que la app deje de llevar la suya. El campo
 * `bookable` es el que expone la grieta sin taparla.
 */
function categoriasVehiculo() {
  const tarifas = getFareClasses();
  const canonicas = ['sedan', 'suv', 'van'] as const;

  const aliasDe = (clave: string) =>
    Object.entries(VEHICLE_ALIAS).filter(([, v]) => v === clave).map(([k]) => k);

  return canonicas.map((clave) => ({
    key:      clave,
    label:    tarifas[clave]?.name ?? clave,
    aliases:  aliasDe(clave),
    bookable: !!tarifas[clave],
    minFare:  tarifas[clave]?.minFare ?? null,
    perHour:  tarifas[clave]?.perHour ?? null,
  }));
}

// GET /api/config/vehicle-categories — público
configRouter.get('/vehicle-categories', (_req: Request, res: Response) => {
  res.json({ categories: categoriasVehiculo() });
});

// GET /api/config — public: returns maintenance_mode, min_version, surge_multiplier, googleMapsApiKey
configRouter.get("/", async (_req: Request, res: Response) => {
  const stripePublishableKey = process.env.VITE_STRIPE_PUBLISHABLE_KEY || process.env.STRIPE_PUBLISHABLE_KEY || '';
  const googleMapsApiKey = process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
  const googleMapsMapId   = process.env.VITE_GOOGLE_MAPS_MAP_ID  || process.env.GOOGLE_MAPS_MAP_ID  || '';
  try {
    const { rows } = await pool.query<{ key: string; value: string }>(
      'SELECT key, value FROM app_config'
    );
    const cfg: Record<string, string> = {};
    for (const row of rows) cfg[row.key] = row.value;
    res.json({
      maintenance_mode: cfg['maintenance_mode'] === 'true',
      min_version:      cfg['min_version'] ?? DEFAULTS.min_version,
      surge_multiplier: parseFloat(cfg['surge_multiplier'] ?? String(DEFAULTS.surge_multiplier)),
      multiplier:       parseFloat(cfg['surge_multiplier'] ?? String(DEFAULTS.surge_multiplier)),
      surgeReason:      cfg['surge_reason'] ?? null,
      stripePublishableKey,
      googleMapsApiKey,
      googleMapsMapId,
    });
  } catch (err: any) {
    log.warn({ err: err.message }, 'config fetch error — returning defaults');
    res.json({ ...DEFAULTS, stripePublishableKey, googleMapsApiKey, googleMapsMapId });
  }
});

/**
 * GET /api/config/cities — público: ciudades donde el conductor puede darse de alta.
 *
 * POR QUÉ — la app lleva una lista fija de 20 ciudades de EE. UU. escrita a mano,
 * así que un conductor de Barranquilla no puede elegir su ciudad aunque el
 * servidor ya opere allí. Abrir una ciudad exigía publicar una versión del APK.
 *
 * Sale de cruzar dos cosas que ya existen y no se estaban usando juntas: las
 * zonas activas (`service_zones`, con su país) y el catálogo `cities` de
 * geonames. Se devuelven las ciudades del catálogo que caen dentro de una zona
 * activa, ordenadas por población.
 *
 * Es un selector, no la geocerca: quién puede pedir un viaje lo sigue decidiendo
 * `resolveZone` sobre coordenadas. Una ciudad de esta lista es donde el conductor
 * dice que va a trabajar.
 */
configRouter.get('/cities', async (req: Request, res: Response) => {
  await ensureZonesFresh();
  const zonas = getZones().filter((z) => z.active && z.centerLat !== null && z.centerLng !== null);

  // El GPS del conductor, si lo manda. Decide cuál se le propone por defecto —
  // sin esto, a un conductor de Barranquilla se le proponía Miami por ser la
  // zona más grande. Mismo criterio que ya usa la búsqueda de direcciones.
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const zonaPropia = resolveZone(lat, lng);

  if (zonas.length === 0) return res.json({ cities: [], default: null });

  try {
    // Una consulta por zona, con su caja envolvente. Son dos o tres zonas: no
    // compensa montar nada más elaborado.
    const porZona = await Promise.all(
      zonas.map(async (z) => {
        const gradoLat = (z.radiusKm ?? 100) / 111;
        const cos = Math.max(0.01, Math.cos((z.centerLat! * Math.PI) / 180));
        const gradoLng = (z.radiusKm ?? 100) / (111 * cos);

        const { rows } = await pool.query<{
          geoname_id: number; name: string; admin1: string | null;
          country_code: string; population: number; timezone: string;
        }>(
          `SELECT geoname_id, name, admin1, country_code, population, timezone
             FROM cities
            WHERE country_code = $1
              AND lat BETWEEN $2 AND $3
              AND lng BETWEEN $4 AND $5
            ORDER BY population DESC
            LIMIT 40`,
          [
            z.countryCode,
            z.centerLat! - gradoLat, z.centerLat! + gradoLat,
            z.centerLng! - gradoLng, z.centerLng! + gradoLng,
          ],
        );

        return rows.map((r) => ({
          id:       `${r.name.toLowerCase().replace(/\s+/g, '-')}-${r.country_code.toLowerCase()}`,
          name:     r.name,
          region:   r.admin1,
          country:  r.country_code,
          timezone: r.timezone,
          zoneId:   z.id,
        }));
      }),
    );

    // Por defecto, la ciudad principal de la zona DEL CONDUCTOR si mandó GPS; si
    // no, la de la zona más grande. Sin ninguna de las dos cosas se abriría en la
    // primera que devuelva la base, que van ordenadas por id: el selector
    // proponía Barranquilla por ir antes que Miami en el alfabeto.
    const mayor = zonas.reduce((a, b) => ((b.radiusKm ?? 0) > (a.radiusKm ?? 0) ? b : a));
    const zonaDefecto = zonaPropia ?? mayor;
    const cities = porZona.flat();
    const porDefecto = cities.find((c) => c.zoneId === zonaDefecto.id) ?? cities[0];

    res.json({
      cities,
      default: porDefecto?.id ?? null,
      /** 'gps' si salió de las coordenadas del conductor; 'largest_zone' si no. */
      defaultFrom: zonaPropia ? 'gps' : 'largest_zone',
    });
  } catch (err: any) {
    // Si el catálogo no está cargado, se responde con las zonas a secas en vez
    // de un error: es preferible ofrecer dos opciones que ninguna, y la app
    // conserva su lista de respaldo igualmente.
    log.warn({ err: err.message }, 'cities fetch error — se devuelven sólo las zonas');
    const cities = zonas.map((z) => ({
      id: `${z.id}-${z.countryCode.toLowerCase()}`,
      name: z.name, region: null, country: z.countryCode,
      timezone: z.timezone, zoneId: z.id,
    }));
    res.json({ cities, default: cities[0]?.id ?? null });
  }
});

// GET /api/config/surge — public: returns current surge multiplier and reason
configRouter.get("/surge", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM app_config WHERE key IN ('surge_multiplier', 'surge_reason')`
    );
    const cfg: Record<string, string> = {};
    for (const row of rows) cfg[row.key] = row.value;
    res.json({
      surge_multiplier: parseFloat(cfg['surge_multiplier'] ?? '1.0'),
      surge_reason:     cfg['surge_reason'] ?? null,
    });
  } catch {
    res.json({ surge_multiplier: 1.0, surge_reason: null });
  }
});

// PUT /api/config/surge — admin only: set surge multiplier
configRouter.put("/surge", requireSupabaseAuth, async (req: Request, res: Response) => {
  const role = req.supabaseRole || 'passenger';
  if (role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { multiplier } = req.body as { multiplier?: number };
  if (!multiplier || multiplier < 1.0 || multiplier > 5.0) {
    return res.status(400).json({ error: 'multiplier must be between 1.0 and 5.0' });
  }
  try {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      ['surge_multiplier', String(multiplier)]
    );
    log.info({ multiplier }, 'surge multiplier updated');
    res.json({ applied: true, surge_multiplier: multiplier });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update surge multiplier' });
  }
});

// PUT /api/config/maintenance — admin only: toggle maintenance mode
configRouter.put("/maintenance", requireSupabaseAuth, async (req: Request, res: Response) => {
  const role = req.supabaseRole || 'passenger';
  if (role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
  try {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      ['maintenance_mode', String(enabled)]
    );
    log.info({ enabled }, 'maintenance mode updated');
    res.json({ applied: true, maintenance_mode: enabled });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update maintenance mode' });
  }
});

// PUT /api/config/version — admin only: set minimum app version
configRouter.put("/version", requireSupabaseAuth, async (req: Request, res: Response) => {
  const role = req.supabaseRole || 'passenger';
  if (role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { min_version } = req.body as { min_version?: string };
  if (!min_version || !/^\d+\.\d+\.\d+$/.test(min_version)) {
    return res.status(400).json({ error: 'min_version must be in x.y.z format' });
  }
  try {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      ['min_version', min_version]
    );
    res.json({ applied: true, min_version });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update min_version' });
  }
});
