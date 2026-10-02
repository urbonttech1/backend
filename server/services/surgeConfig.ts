/**
 * El recargo por alta demanda, gobernable desde el panel.
 *
 * Antes `app_config.surge_multiplier` tenía dos escritores que no se conocían:
 * el cron `autoSurge` cada 5 minutos y el admin a mano. El del admin duraba
 * hasta el siguiente tick, y no había forma de apagar el automático.
 *
 * Ahora el estado vive en una sola clave JSON, `surge_config`, y se resuelve con
 * una regla explícita:
 *
 *   - interruptor apagado y sin candado  → 1.0, sin recargo de ningún tipo
 *   - hay candado manual                 → manda el manual, aunque baje de la franja
 *   - si no                              → el mayor entre la franja horaria y el automático
 *
 * `surge_multiplier` y `surge_reason` siguen existiendo como espejos derivados,
 * escritos en la misma transacción, porque la app ya desplegada los lee y el
 * contrato de `GET /api/config` no puede cambiar.
 */
import { pool } from '../db/pool';
import { logger } from '../lib/logger';
import { getTimeSurge } from '../config/pricing';

const CONFIG_KEY = 'surge_config';
const MIRROR_KEY = 'surge_multiplier';
const REASON_KEY = 'surge_reason';
const TTL_MS = 60_000;

/** Los mismos límites que ya validaba `PUT /api/config/surge`. */
export const SURGE_MIN = 1.0;
export const SURGE_MAX = 5.0;

/** Diferencia mínima para molestarse en escribir; evita el vaivén de decimales. */
export const HISTERESIS = 0.05;

export type SurgeOrigin = 'off' | 'manual' | 'auto' | 'time';

export interface SurgeConfig {
  autoEnabled: boolean;
  autoMultiplier: number;
  autoUpdatedAt: string | null;
  manualMultiplier: number | null;
  manualReason: string | null;
  manualSetBy: string | null;
  manualSetAt: string | null;
  /**
   * Se fijó sin avisar: ni el aviso en pantalla del pasajero ni el push al
   * conductor. Se recuerda para que liberarlo después tampoco anuncie el final
   * de un recargo que nadie supo que empezó.
   */
  manualSilent: boolean;
}

// ─── Parte pura: sin base de datos, para poder testearla ─────────────────────

/** Lo que llega del panel convertido en multiplicador. `null` si no vale. */
export function normalizarMultiplicador(valor: unknown): number | null {
  const n = typeof valor === 'number' ? valor
    : typeof valor === 'string' && valor.trim() !== '' ? Number(valor.replace(',', '.'))
    : NaN;
  if (!Number.isFinite(n) || n < SURGE_MIN || n > SURGE_MAX) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Lee la clave guardada sin fiarse de nada de lo que haya dentro.
 *
 * Tolerante a propósito: si falta o está corrupta, se devuelve el
 * comportamiento de siempre —automático encendido con el multiplicador que ya
 * hubiera— para que una instalación existente no cambie al desplegar.
 */
export function parseSurgeConfig(stored: string | null | undefined, fallbackMultiplier = 1.0): SurgeConfig {
  const base: SurgeConfig = {
    autoEnabled: true,
    autoMultiplier: normalizarMultiplicador(fallbackMultiplier) ?? 1.0,
    autoUpdatedAt: null,
    manualMultiplier: null,
    manualReason: null,
    manualSetBy: null,
    manualSetAt: null,
    manualSilent: false,
  };
  if (!stored) return base;

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base;
    raw = parsed as Record<string, unknown>;
  } catch {
    return base;
  }

  // `autoEnabled` puede venir como booleano o como la cadena que dejó el editor
  // de texto libre de `/system` antes de cerrarse esa puerta.
  const enabled = raw.autoEnabled;
  const autoEnabled = typeof enabled === 'boolean' ? enabled
    : typeof enabled === 'string' ? enabled.trim().toLowerCase() === 'true'
    : true;

  const texto = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

  return {
    autoEnabled,
    autoMultiplier: normalizarMultiplicador(raw.autoMultiplier) ?? base.autoMultiplier,
    autoUpdatedAt: texto(raw.autoUpdatedAt),
    manualMultiplier: normalizarMultiplicador(raw.manualMultiplier),
    manualReason: texto(raw.manualReason),
    manualSetBy: texto(raw.manualSetBy),
    manualSetAt: texto(raw.manualSetAt),
    manualSilent: raw.manualSilent === true,
  };
}

/**
 * La regla, en un solo sitio.
 *
 * El candado sobrevive al interruptor: el OFF gobierna al cron, no al admin. Y
 * el manual es un override, no un `max`, que es lo que permite bajar por debajo
 * de la franja horaria —sin eso, apagar el recargo en hora pico no haría nada.
 */
export function resolverSurge(cfg: SurgeConfig, timeSurge: number): { value: number; origin: SurgeOrigin } {
  if (cfg.manualMultiplier !== null) {
    return { value: cfg.manualMultiplier, origin: 'manual' };
  }
  if (!cfg.autoEnabled) {
    return { value: 1.0, origin: 'off' };
  }
  const franja = normalizarMultiplicador(timeSurge) ?? 1.0;
  return franja > cfg.autoMultiplier
    ? { value: franja, origin: 'time' }
    : { value: cfg.autoMultiplier, origin: 'auto' };
}

/** La escalera del cron, tal cual estaba en `autoSurge`. */
export function decidirAuto(drivers: number, rides: number): number {
  const ratio = drivers > 0 ? rides / drivers : rides;
  if (ratio >= 3.0) return 2.0;
  if (ratio >= 2.0) return 1.5;
  if (ratio >= 1.5) return 1.3;
  if (ratio >= 1.0) return 1.15;
  return 1.0;
}

export function debeEscribir(actual: number, objetivo: number): boolean {
  return Math.abs(actual - objetivo) >= HISTERESIS;
}

// ─── Parte con base de datos ─────────────────────────────────────────────────

let cache: { cfg: SurgeConfig; at: number } | null = null;

export function invalidarSurge(): void {
  cache = null;
}

async function leerDeLaBase(): Promise<SurgeConfig> {
  const { rows } = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM app_config WHERE key IN ($1, $2)`,
    [CONFIG_KEY, MIRROR_KEY],
  );
  const porClave = new Map(rows.map(r => [r.key, r.value]));
  const espejo = parseFloat(porClave.get(MIRROR_KEY) ?? '1') || 1;
  return parseSurgeConfig(porClave.get(CONFIG_KEY), espejo);
}

/** Estado vigente, con caché de 60 s. Lanza si la base falla. */
export async function estadoSurge(force = false): Promise<SurgeConfig> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.cfg;
  const cfg = await leerDeLaBase();
  cache = { cfg, at: Date.now() };
  return cfg;
}

/**
 * El multiplicador que se va a cobrar. Nunca lanza: ante un fallo de lectura
 * degrada a la franja horaria, igual que hacía `getEffectiveSurge`. Es la
 * llamada más caliente del camino de precios y una excepción aquí dejaría sin
 * precio a toda la plataforma.
 */
export async function surgeVigente(now: Date = new Date()): Promise<number> {
  const timeSurge = getTimeSurge(now);
  try {
    const cfg = await estadoSurge();
    return resolverSurge(cfg, timeSurge).value;
  } catch (err) {
    logger.warn(`[Surge] No se pudo leer la configuración, se usa sólo la franja horaria: ${(err as Error).message}`);
    return timeSurge;
  }
}

/** Persiste la configuración y sus dos espejos en una sola transacción. */
async function escribir(cfg: SurgeConfig): Promise<SurgeConfig> {
  const resuelto = resolverSurge(cfg, getTimeSurge());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [CONFIG_KEY, JSON.stringify(cfg)],
    );
    await client.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [MIRROR_KEY, String(resuelto.value)],
    );
    await client.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [REASON_KEY, cfg.manualReason ?? ''],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  invalidarSurge();
  return cfg;
}

export interface ResultadoAuto {
  applied: boolean;
  reason?: 'manual_lock' | 'auto_off' | 'hysteresis';
  previous: number;
  current: number;
}

/**
 * Lo que llama el cron. Relee el candado DENTRO de la transacción y con
 * `FOR UPDATE`, nunca de la caché: con un TTL de 60 s, un candado puesto justo
 * después de una lectura se perdería en el siguiente tick, que es exactamente
 * el fallo que esto viene a cerrar.
 */
export async function guardarAuto(objetivo: number): Promise<ResultadoAuto> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ key: string; value: string }>(
      `SELECT key, value FROM app_config WHERE key IN ($1, $2) FOR UPDATE`,
      [CONFIG_KEY, MIRROR_KEY],
    );
    const porClave = new Map(rows.map(r => [r.key, r.value]));
    const espejo = parseFloat(porClave.get(MIRROR_KEY) ?? '1') || 1;
    const cfg = parseSurgeConfig(porClave.get(CONFIG_KEY), espejo);

    const timeSurge = getTimeSurge();
    const previo = resolverSurge(cfg, timeSurge).value;

    if (cfg.manualMultiplier !== null) {
      await client.query('ROLLBACK');
      return { applied: false, reason: 'manual_lock', previous: previo, current: previo };
    }
    if (!cfg.autoEnabled) {
      await client.query('ROLLBACK');
      return { applied: false, reason: 'auto_off', previous: previo, current: previo };
    }
    if (!debeEscribir(cfg.autoMultiplier, objetivo)) {
      await client.query('ROLLBACK');
      return { applied: false, reason: 'hysteresis', previous: previo, current: previo };
    }

    const nuevo: SurgeConfig = { ...cfg, autoMultiplier: objetivo, autoUpdatedAt: new Date().toISOString() };
    const resuelto = resolverSurge(nuevo, timeSurge);

    await client.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [CONFIG_KEY, JSON.stringify(nuevo)],
    );
    await client.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [MIRROR_KEY, String(resuelto.value)],
    );
    await client.query('COMMIT');
    invalidarSurge();
    return { applied: true, previous: previo, current: resuelto.value };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Enciende o apaga el cálculo automático. */
export async function guardarAutoEnabled(enabled: boolean, quien: string): Promise<SurgeConfig> {
  const cfg = await estadoSurge(true);
  const nuevo = await escribir({ ...cfg, autoEnabled: enabled });
  logger.info(`[Surge] Recargo automático ${enabled ? 'encendido' : 'apagado'} por ${quien}`);
  return nuevo;
}

/**
 * Fija o libera el candado manual. `null` lo libera y devuelve el control al
 * automático en el siguiente ciclo del cron.
 */
export async function guardarManual(
  multiplicador: unknown,
  reason: string | null,
  quien: string,
  silent = false,
): Promise<SurgeConfig | null> {
  const cfg = await estadoSurge(true);

  if (multiplicador === null) {
    const nuevo = await escribir({
      ...cfg,
      manualMultiplier: null,
      manualReason: null,
      manualSetBy: null,
      manualSetAt: null,
      manualSilent: false,
    });
    logger.info(`[Surge] Candado manual liberado por ${quien}`);
    return nuevo;
  }

  const valor = normalizarMultiplicador(multiplicador);
  if (valor === null) return null;

  const nuevo = await escribir({
    ...cfg,
    manualMultiplier: valor,
    manualReason: reason?.trim() || null,
    manualSetBy: quien,
    manualSetAt: new Date().toISOString(),
    manualSilent: silent === true,
  });
  logger.info(`[Surge] Candado manual fijado en ${valor}x por ${quien}${reason ? ` (${reason})` : ''}${silent ? ' — sin avisar' : ''}`);
  return nuevo;
}
