/**
 * Carga las tarifas desde la base y las deja vigentes en `pricing.ts`.
 *
 * Vive aparte a propósito: `pricing.ts` no importa nada, y así sigue siendo puro
 * y testeable sin base de datos. Este módulo es el único que sabe que las
 * tarifas se guardan en `app_config.fares_config`.
 *
 * POR QUÉ HACE FALTA — hasta ahora el editor del panel guardaba en esa clave y
 * **nadie la leía**: un admin cambiaba una tarifa, se guardaba, el panel se la
 * mostraba de vuelta, y al pasajero se le seguía cobrando la constante del
 * código. La clave ni siquiera existía en la base, así que nada se había
 * desincronizado todavía — el problema habría aparecido la primera vez que
 * alguien usara el editor.
 */

import { pool } from '../db/pool';
import { logger } from '../lib/logger';
import { DEFAULT_FARE_CLASSES, setFareClasses, type FareClass } from '../config/pricing';

const CONFIG_KEY = 'fares_config';

/**
 * Cada cuánto se relee la base. En ECS corren varias instancias: sin esto, un
 * admin que guarda en una dejaría a las demás con el valor viejo hasta el
 * próximo deploy.
 */
const TTL_MS = 5 * 60 * 1000;

let lastLoadedAt = 0;
let loading: Promise<void> | null = null;

/** Nombres viejos de clase → canónicos. El panel usaba `businessClass` por `sedan`. */
const LEGACY_CLASS_KEYS: Record<string, string> = {
  businessClass: 'sedan',
  business_class: 'sedan',
  standard: 'sedan',
};

/**
 * Normaliza una clase guardada y rellena con el default lo que falte, de modo que
 * una config parcial nunca deje un campo en `undefined` y produzca un `NaN` en el
 * precio.
 *
 * Tolera el esquema anterior a los tramos: si una config sólo trae el `perMile`
 * de antes, se usa en los tres tramos. Y `baseFare` sigue valiendo por `minFare`.
 *
 * OJO con `waitPerMin`: en el esquema viejo del editor era un alias de `perMin`
 * (tiempo de trayecto). Ahora es la tarifa de ESPERA, un concepto distinto, así
 * que ya no se lee como `perMin`. En producción nunca hubo `fares_config`
 * guardada, así que no hay datos viejos que malinterpretar.
 */
function normalizeClass(key: string, raw: Record<string, unknown>): FareClass {
  const base = DEFAULT_FARE_CLASSES[key] ?? DEFAULT_FARE_CLASSES.sedan;
  const num = (v: unknown, fallback: number): number => {
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const perMileViejo = raw.perMile;

  return {
    name:         typeof raw.name === 'string' && raw.name.trim() ? raw.name : base.name,
    minFare:      num(raw.minFare ?? raw.baseFare, base.minFare),
    perMileTier1: num(raw.perMileTier1 ?? perMileViejo, base.perMileTier1),
    perMileTier2: num(raw.perMileTier2 ?? perMileViejo, base.perMileTier2),
    perMileTier3: num(raw.perMileTier3 ?? perMileViejo, base.perMileTier3),
    perMin:       num(raw.perMin, base.perMin),
    waitPerMin:   num(raw.waitPerMin, base.waitPerMin),
    serviceFee:   num(raw.serviceFee, base.serviceFee),
    perHour:      num(raw.perHour, base.perHour),
    minHours:     num(raw.minHours, base.minHours),
  };
}

/** Convierte lo guardado en clases canónicas, descartando lo que no es un vehículo. */
export function parseStoredFares(stored: unknown): Record<string, FareClass> {
  if (!stored || typeof stored !== 'object') return {};

  const out: Record<string, FareClass> = {};
  for (const [rawKey, rawValue] of Object.entries(stored as Record<string, unknown>)) {
    if (!rawValue || typeof rawValue !== 'object') continue;

    const key = LEGACY_CLASS_KEYS[rawKey] ?? rawKey;
    // `concierge` y `valet` viven en el editor pero no son clases de vehículo:
    // tienen su propio flujo de cobro y no participan del cálculo por distancia.
    if (!(key in DEFAULT_FARE_CLASSES)) continue;

    out[key] = normalizeClass(key, rawValue as Record<string, unknown>);
  }
  return out;
}

/**
 * Lee `fares_config` y la deja vigente. Nunca lanza: si la base no responde, se
 * sigue cobrando con los valores por defecto, que es preferible a dejar la app
 * sin precios.
 */
export async function loadFares(force = false): Promise<void> {
  if (!force && Date.now() - lastLoadedAt < TTL_MS) return;
  if (loading) return loading;   // una sola lectura concurrente

  loading = (async () => {
    try {
      const { rows } = await pool.query<{ value: string }>(
        `SELECT value FROM app_config WHERE key = $1`,
        [CONFIG_KEY],
      );

      if (!rows[0]?.value) {
        // Todavía nadie guardó tarifas: los defaults son la verdad.
        setFareClasses(DEFAULT_FARE_CLASSES);
        lastLoadedAt = Date.now();
        // Se registra igual: el silencio no distingue entre "cargó los defaults"
        // y "esto nunca corrió", y en el camino del dinero eso importa.
        logger.info('[Tarifas] Sin fares_config en la base — vigentes los valores por defecto de pricing.ts');
        return;
      }

      const parsed = parseStoredFares(JSON.parse(rows[0].value));
      setFareClasses(parsed);
      lastLoadedAt = Date.now();
      logger.info(`[Tarifas] Cargadas desde la base: ${Object.keys(parsed).join(', ') || 'ninguna clase válida'}`);
    } catch (err) {
      logger.error(`[Tarifas] No se pudieron cargar, se siguen usando los valores por defecto: ${(err as Error).message}`);
    } finally {
      loading = null;
    }
  })();

  return loading;
}

/** Fuerza una relectura. La llama el editor del panel tras guardar. */
export async function invalidateFares(): Promise<void> {
  lastLoadedAt = 0;
  await loadFares(true);
}

/**
 * Se llama al principio de cada ruta que calcula precios.
 *
 * Es lo que hace que el TTL sirva de algo: `loadFares()` sale de inmediato si la
 * última lectura es reciente, así que el coste real es una consulta cada cinco
 * minutos por instancia. Sin esto, la caché sólo se refrescaba al arrancar y al
 * guardar desde el panel — y como en ECS corren varias instancias, la que no
 * atendió el guardado se quedaba con el precio viejo hasta el próximo deploy.
 *
 * Nunca lanza ni bloquea: ante un fallo se sigue cobrando con lo que haya en
 * memoria.
 */
export async function ensureFaresFresh(): Promise<void> {
  try {
    await loadFares(false);
  } catch {
    /* loadFares ya registra el error; acá no hay nada que decidir */
  }
}
