/**
 * Si se aceptan viajes en efectivo. Lo decide el panel, no el código.
 *
 * El efectivo obliga a adelantar la comisión del valet y deja al chofer cobrando
 * en mano, así que Urbont puede querer apagarlo sin desplegar ni publicar una
 * versión nueva de la app: la app lee este valor de `/api/config` y esconde la
 * opción, y el servidor rechaza los despachos nuevos que la pidan.
 *
 * Los viajes ya creados en efectivo no se tocan: se completan y se liquidan igual.
 */
import { pool } from '../db/pool';
import { logger } from '../lib/logger';

const CONFIG_KEY = 'cash_config';
const TTL_MS = 60_000;

/** Valor inicial mientras no haya nada guardado. `CASH_PAYMENTS=off` lo apaga. */
export function porDefecto(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.CASH_PAYMENTS ?? '').trim().toLowerCase() !== 'off';
}

/** Lo que el panel manda, convertido en booleano. `null` si no vale. */
export function normalizarEfectivo(valor: unknown): boolean | null {
  if (typeof valor === 'boolean') return valor;
  if (typeof valor === 'string') {
    const v = valor.trim().toLowerCase();
    if (v === 'true' || v === 'on') return true;
    if (v === 'false' || v === 'off') return false;
  }
  return null;
}

let vigente = porDefecto();
let ultimaLectura = 0;
let leyendo: Promise<void> | null = null;

export function efectivoPermitido(): boolean {
  return vigente;
}

/** Nunca lanza: ante un fallo de lectura se queda con el último valor conocido. */
export async function cargarEfectivo(force = false): Promise<void> {
  if (!force && Date.now() - ultimaLectura < TTL_MS) return;
  if (leyendo) return leyendo;

  leyendo = (async () => {
    try {
      const { rows } = await pool.query<{ value: string }>(
        `SELECT value FROM app_config WHERE key = $1`, [CONFIG_KEY],
      );
      const guardado = rows[0]?.value ? normalizarEfectivo(JSON.parse(rows[0].value)?.enabled) : null;
      vigente = guardado ?? porDefecto();
      ultimaLectura = Date.now();
    } catch (err) {
      logger.error(`[Efectivo] No se pudo leer, sigue en ${vigente ? 'activado' : 'desactivado'}: ${(err as Error).message}`);
    } finally {
      leyendo = null;
    }
  })();

  return leyendo;
}

export async function ensureEfectivoFresh(): Promise<void> {
  try {
    await cargarEfectivo(false);
  } catch { /* cargarEfectivo ya lo registra */ }
}

/** Guarda el ajuste desde el panel y lo deja vigente al instante. */
export async function guardarEfectivo(valor: unknown, quien: string): Promise<boolean | null> {
  const activo = normalizarEfectivo(valor);
  if (activo === null) return null;

  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [CONFIG_KEY, JSON.stringify({ enabled: activo, updatedBy: quien })],
  );

  vigente = activo;
  ultimaLectura = Date.now();
  logger.info(`[Efectivo] ${activo ? 'Activado' : 'Desactivado'} por ${quien}`);
  return activo;
}
