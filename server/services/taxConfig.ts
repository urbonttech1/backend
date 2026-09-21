/**
 * La tasa de impuesto de respaldo, editable desde el panel.
 *
 * El impuesto real lo calcula Stripe Tax según la jurisdicción del viaje, y eso
 * NO se toca desde el panel a propósito: es dinero del estado y fijarlo a mano
 * haría cobrar de menos —o de más— en cuanto se opere en otro condado.
 *
 * Esta tasa sólo se usa cuando Stripe Tax no responde o no aplica, que es el
 * caso de los países donde no está habilitado. Antes era un 6,5 % escrito en el
 * código —el punto medio de Florida—, así que un viaje en Colombia se estimaba
 * con impuestos de Miami.
 *
 * Se guarda en `app_config`, igual que las tarifas (ver fareConfig.ts).
 */
import { pool } from '../db/pool';
import { logger } from '../lib/logger';

const CONFIG_KEY = 'tax_config';
const TTL_MS = 60_000;

/** El valor histórico: el punto medio del 6–7 % que se aplica en Florida. */
export const TASA_POR_DEFECTO = 0.065;
/** Un impuesto por encima del 30 % es casi seguro un error de tecleo. */
export const TASA_MAXIMA = 0.30;

let tasaVigente = TASA_POR_DEFECTO;
let ultimaLectura = 0;
let leyendo: Promise<void> | null = null;

/** Convierte lo que llega del panel (un porcentaje) en tasa. `null` si no vale. */
export function normalizarTasa(porcentaje: unknown): number | null {
  const n = typeof porcentaje === 'number' ? porcentaje
    : typeof porcentaje === 'string' && porcentaje.trim() !== '' ? Number(porcentaje.replace(',', '.'))
    : NaN;
  if (!Number.isFinite(n) || n < 0 || n > TASA_MAXIMA * 100) return null;
  return Math.round(n * 1e4) / 1e6;   // 6.5 → 0.065, con cuatro decimales de porcentaje
}

export const comoPorcentaje = (tasa: number): number => Math.round(tasa * 1e6) / 1e4;

/** Lee la tasa guardada. Nunca lanza: sin base, sigue la que ya estaba. */
export async function cargarTasa(force = false): Promise<void> {
  if (!force && Date.now() - ultimaLectura < TTL_MS) return;
  if (leyendo) return leyendo;

  leyendo = (async () => {
    try {
      const { rows } = await pool.query<{ value: string }>(
        `SELECT value FROM app_config WHERE key = $1`, [CONFIG_KEY],
      );
      const guardada = rows[0]?.value ? normalizarTasa(JSON.parse(rows[0].value)?.fallbackRatePercent) : null;
      tasaVigente = guardada ?? TASA_POR_DEFECTO;
      ultimaLectura = Date.now();
      if (guardada === null) {
        logger.info(`[Impuesto] Sin tax_config en la base — vigente el ${comoPorcentaje(TASA_POR_DEFECTO)} % por defecto`);
      }
    } catch (err) {
      logger.error(`[Impuesto] No se pudo leer la tasa, sigue el ${comoPorcentaje(tasaVigente)} %: ${(err as Error).message}`);
    } finally {
      leyendo = null;
    }
  })();

  return leyendo;
}

/** La tasa vigente, releída si la caché venció. */
export async function tasaImpuestoRespaldo(): Promise<number> {
  await cargarTasa();
  return tasaVigente;
}

/** Lo que hay en memoria, sin esperar a la base. Para respuestas ya en curso. */
export const tasaEnMemoria = (): number => tasaVigente;

/** Guarda la tasa desde el panel y la deja vigente al instante. */
export async function guardarTasa(porcentaje: unknown, quien: string): Promise<number | null> {
  const tasa = normalizarTasa(porcentaje);
  if (tasa === null) return null;

  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [CONFIG_KEY, JSON.stringify({ fallbackRatePercent: comoPorcentaje(tasa), updatedBy: quien })],
  );

  tasaVigente = tasa;
  ultimaLectura = Date.now();
  logger.info(`[Impuesto] Tasa de respaldo cambiada a ${comoPorcentaje(tasa)} % por ${quien}`);
  return tasa;
}
