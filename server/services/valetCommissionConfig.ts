/**
 * La comisión del valet, editable desde el panel.
 *
 * Eran tres constantes del código —$10 hasta $100 de servicio y el 10 % por
 * encima—, así que cambiarlas obligaba a desplegar. Ahora viven en `app_config`,
 * igual que la comisión de Urbont, y el despacho las lee al calcular.
 *
 * Solo afecta a los viajes que se despachen desde ahora: cada viaje guarda la
 * comisión que tuvo (`rides.valet_surcharge`) y de ahí se cobra y se paga.
 */
import { pool } from '../db/pool';
import { logger } from '../lib/logger';
import {
  REGLAS_VALET_POR_DEFECTO, getReglasValet, setReglasValet, normalizarReglasValet,
  type ReglasValet, type ErrorReglas,
} from './valetCommission';

const CONFIG_KEY = 'valet_commission_config';
const TTL_MS = 60_000;

let ultimaLectura = 0;
let leyendo: Promise<void> | null = null;

/** Las reglas como las ve el panel: porcentaje en %, no en fracción. */
export function paraPanel(r: ReglasValet = getReglasValet()) {
  return { minimumUsd: r.minimo, thresholdUsd: r.umbral, percent: Math.round(r.porcentaje * 1e6) / 1e4 };
}

/** Lee las reglas guardadas y las deja vigentes. Nunca lanza. */
export async function cargarReglasValet(force = false): Promise<void> {
  if (!force && Date.now() - ultimaLectura < TTL_MS) return;
  if (leyendo) return leyendo;

  leyendo = (async () => {
    try {
      const { rows } = await pool.query<{ value: string }>(`SELECT value FROM app_config WHERE key = $1`, [CONFIG_KEY]);
      const crudo = rows[0]?.value ? JSON.parse(rows[0].value) : null;
      const n = crudo ? normalizarReglasValet(crudo) : null;
      setReglasValet(n && 'reglas' in n ? n.reglas : REGLAS_VALET_POR_DEFECTO);
      ultimaLectura = Date.now();
    } catch (err) {
      logger.error(`[ComisiónValet] No se pudo leer, siguen las vigentes: ${(err as Error).message}`);
    } finally {
      leyendo = null;
    }
  })();
  return leyendo;
}

/** Se llama antes de calcular la comisión de un despacho. */
export async function ensureReglasValetFresh(): Promise<void> {
  try { await cargarReglasValet(false); } catch { /* ya se registra */ }
}

/** Guarda las reglas desde el panel y las deja vigentes al instante. */
export async function guardarReglasValet(body: Record<string, unknown>, quien: string): Promise<ReglasValet | ErrorReglas> {
  const n = normalizarReglasValet(body);
  if (!('reglas' in n)) return n;

  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [CONFIG_KEY, JSON.stringify({ ...paraPanel(n.reglas), updatedBy: quien })],
  );
  setReglasValet(n.reglas);
  ultimaLectura = Date.now();
  logger.info(`[ComisiónValet] Cambiada a $${n.reglas.minimo} hasta $${n.reglas.umbral} y ${paraPanel(n.reglas).percent} % por encima, por ${quien}`);
  return n.reglas;
}
