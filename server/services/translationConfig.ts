/**
 * Config del traductor de chat chofer↔pasajero, editable desde el panel.
 *
 * Antes vivía sólo en `GROK_API_KEY` (variable de entorno). Ahora la API key se
 * guarda en `app_config`, igual que las tarifas (ver `taxConfig.ts`) — en texto
 * plano, mismo tratamiento que el resto de valores de esa tabla. El `GET` del
 * panel igual nunca devuelve la key completa (ver `estadoConfigTraduccion`).
 *
 * Si la base no tiene nada guardado, cae a `OPENAI_API_KEY` del entorno — igual
 * de silencioso que el resto de la config: nunca rompe el chat, como mucho deja
 * de traducir.
 */
import { pool } from '../db/pool';
import { logger } from '../lib/logger';

const CONFIG_KEY = 'translation_config';
const TTL_MS = 60_000;

export const MODELO_POR_DEFECTO = 'gpt-4o-mini';

interface ConfigGuardada {
  apiKey?: string;
  model?: string;
  updatedBy?: string;
  updatedAt?: string;
}

interface ConfigVigente {
  apiKey: string | null;
  model: string;
  updatedBy?: string;
  updatedAt?: string;
}

let vigente: ConfigVigente = {
  apiKey: process.env.OPENAI_API_KEY || null,
  model: MODELO_POR_DEFECTO,
};
let ultimaLectura = 0;
let leyendo: Promise<void> | null = null;

/** Lee la config guardada. Nunca lanza: sin base, sigue la que ya estaba (o el env var). */
export async function cargarConfigTraduccion(force = false): Promise<void> {
  if (!force && Date.now() - ultimaLectura < TTL_MS) return;
  if (leyendo) return leyendo;

  leyendo = (async () => {
    try {
      const { rows } = await pool.query<{ value: string }>(
        `SELECT value FROM app_config WHERE key = $1`, [CONFIG_KEY],
      );

      if (!rows[0]?.value) {
        vigente = { apiKey: process.env.OPENAI_API_KEY || null, model: MODELO_POR_DEFECTO };
        ultimaLectura = Date.now();
        return;
      }

      const guardado = JSON.parse(rows[0].value) as ConfigGuardada;
      vigente = {
        apiKey: guardado.apiKey || process.env.OPENAI_API_KEY || null,
        model: guardado.model || MODELO_POR_DEFECTO,
        updatedBy: guardado.updatedBy,
        updatedAt: guardado.updatedAt,
      };
      ultimaLectura = Date.now();
    } catch (err) {
      logger.error(`[Traducción] No se pudo leer la config, sigue la anterior: ${(err as Error).message}`);
    } finally {
      leyendo = null;
    }
  })();

  return leyendo;
}

/** La config vigente, releída si la caché venció. */
export async function configTraduccion(): Promise<ConfigVigente> {
  await cargarConfigTraduccion();
  return vigente;
}

/** Lo que hay en memoria, sin esperar a la base. Para el camino caliente de `translateText`. */
export const configTraduccionEnMemoria = (): ConfigVigente => vigente;

/**
 * Guarda la key nueva y/o el modelo desde el panel. `apiKey` vacío/undefined no
 * toca la key ya guardada (para poder cambiar sólo el modelo sin repegar la key).
 */
export async function guardarConfigTraduccion(
  input: { apiKey?: string; model?: string },
  quien: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const modeloNuevo = input.model?.trim() || vigente.model || MODELO_POR_DEFECTO;

  let apiKeyGuardar: string | undefined;

  if (input.apiKey && input.apiKey.trim()) {
    const key = input.apiKey.trim();
    if (!key.startsWith('sk-')) {
      return { ok: false, error: 'La API key de OpenAI debe empezar con "sk-".' };
    }
    apiKeyGuardar = key;
  } else {
    // No cambia la key: se conserva la ya guardada para no perderla al
    // reescribir el JSON completo (por ejemplo, al guardar sólo el modelo).
    const { rows } = await pool.query<{ value: string }>(
      `SELECT value FROM app_config WHERE key = $1`, [CONFIG_KEY],
    );
    apiKeyGuardar = rows[0]?.value ? (JSON.parse(rows[0].value) as ConfigGuardada).apiKey : undefined;
  }

  const actualizado: ConfigGuardada = {
    apiKey: apiKeyGuardar,
    model: modeloNuevo,
    updatedBy: quien,
    updatedAt: new Date().toISOString(),
  };

  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [CONFIG_KEY, JSON.stringify(actualizado)],
  );

  vigente = { apiKey: apiKeyGuardar || null, model: modeloNuevo, updatedBy: quien, updatedAt: actualizado.updatedAt };
  ultimaLectura = Date.now();
  logger.info(`[Traducción] Configuración de OpenAI actualizada por ${quien}`);
  return { ok: true };
}

/** Para el `GET` del panel: nunca la key completa. */
export function estadoConfigTraduccion(): {
  configured: boolean;
  maskedKey: string | null;
  model: string;
  updatedBy?: string;
  updatedAt?: string;
} {
  const key = vigente.apiKey;
  return {
    configured: !!key,
    maskedKey: key ? `sk-...${key.slice(-4)}` : null,
    model: vigente.model,
    updatedBy: vigente.updatedBy,
    updatedAt: vigente.updatedAt,
  };
}
