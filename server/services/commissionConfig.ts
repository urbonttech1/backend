/**
 * La comisión de Urbont, editable desde el panel.
 *
 * Era una constante del código, así que cambiarla —del 10 % al 15 %, por
 * ejemplo— obligaba a desplegar. Ahora vive en `app_config`, igual que las
 * tarifas por clase y la tasa de impuesto, y el motor de precios la lee en cada
 * cálculo.
 *
 * Sale de DENTRO del precio: el pasajero paga la tarifa de la tabla y de ahí se
 * reparte. Subirla no encarece el viaje, le quita al chofer.
 */
import { pool } from '../db/pool';
import { logger } from '../lib/logger';
import { PLATFORM_COMMISSION, setPlatformCommission, getPlatformCommission } from '../config/pricing';

const CONFIG_KEY = 'commission_config';
const TTL_MS = 60_000;

/** Más de esto es casi seguro un error de tecleo, y se le cobra al chofer. */
export const COMISION_MAXIMA = 0.30;

let ultimaLectura = 0;
let leyendo: Promise<void> | null = null;

/** Lo que el panel escribe (un porcentaje) convertido en tasa. `null` si no vale. */
export function normalizarComision(porcentaje: unknown): number | null {
  const n = typeof porcentaje === 'number' ? porcentaje
    : typeof porcentaje === 'string' && porcentaje.trim() !== '' ? Number(porcentaje.replace(',', '.'))
    : NaN;
  if (!Number.isFinite(n) || n < 0 || n > COMISION_MAXIMA * 100) return null;
  return Math.round(n * 1e4) / 1e6;
}

export const comoPorcentaje = (tasa: number): number => Math.round(tasa * 1e6) / 1e4;

/** Lee la comisión guardada y la deja vigente. Nunca lanza. */
export async function cargarComision(force = false): Promise<void> {
  if (!force && Date.now() - ultimaLectura < TTL_MS) return;
  if (leyendo) return leyendo;

  leyendo = (async () => {
    try {
      const { rows } = await pool.query<{ value: string }>(
        `SELECT value FROM app_config WHERE key = $1`, [CONFIG_KEY],
      );
      const guardada = rows[0]?.value ? normalizarComision(JSON.parse(rows[0].value)?.platformCommissionPercent) : null;
      setPlatformCommission(guardada ?? PLATFORM_COMMISSION);
      ultimaLectura = Date.now();
      if (guardada === null) {
        logger.info(`[Comisión] Sin commission_config en la base — vigente el ${comoPorcentaje(PLATFORM_COMMISSION)} % del código`);
      }
    } catch (err) {
      logger.error(`[Comisión] No se pudo leer, sigue el ${comoPorcentaje(getPlatformCommission())} %: ${(err as Error).message}`);
    } finally {
      leyendo = null;
    }
  })();

  return leyendo;
}

/** Se llama antes de cada cálculo de precio, junto a `ensureFaresFresh`. */
export async function ensureComisionFresh(): Promise<void> {
  try {
    await cargarComision(false);
  } catch { /* cargarComision ya lo registra */ }
}

/** Guarda la comisión desde el panel y la deja vigente al instante. */
export async function guardarComision(porcentaje: unknown, quien: string): Promise<number | null> {
  const tasa = normalizarComision(porcentaje);
  if (tasa === null) return null;

  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [CONFIG_KEY, JSON.stringify({ platformCommissionPercent: comoPorcentaje(tasa), updatedBy: quien })],
  );

  setPlatformCommission(tasa);
  ultimaLectura = Date.now();
  logger.info(`[Comisión] Cambiada a ${comoPorcentaje(tasa)} % por ${quien}`);
  return tasa;
}
