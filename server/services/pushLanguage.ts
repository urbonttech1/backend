/**
 * En qué idioma le llega cada notificación.
 *
 * Las notificaciones traen el texto en inglés (`title`, `body`) y, si la
 * plantilla lo tiene, la versión en español (`es`). Al enviar se elige por
 * teléfono, no por usuario: quien tiene dos dispositivos en idiomas distintos
 * recibe cada uno en el suyo.
 *
 * El idioma sale, por orden, de:
 *   1. el que reporta la app al registrar el token (`user_push_tokens.language`);
 *   2. el que el usuario eligió en Ajustes (`profiles.preferences.language`);
 *   3. el prefijo de su teléfono, para quien todavía no actualizó la app;
 *   4. inglés.
 *
 * Francés y portugués existen en la app pero no en las notificaciones: quien
 * tiene uno de esos idiomas recibe el inglés, no el español.
 *
 * Este archivo es puro para poder probarlo; las consultas están en `fcm.ts`.
 */

export type Idioma = 'en' | 'es';

export interface Texto {
  title: string;
  body: string;
}

/** Un texto que puede venir ya en los dos idiomas o, todavía, sólo en inglés. */
export type Bilingue = { en: string; es: string };

/** Lo que una notificación necesita para poder elegir idioma. */
export interface Localizable extends Texto {
  es?: Texto;
  data?: Record<string, string>;
}

/**
 * El idioma de una etiqueta (`es-CO`, `en`, `pt_BR`…). `null` sólo si no hay
 * dato: un idioma que la app tiene y las notificaciones no, como `fr`, es una
 * respuesta válida y se manda en inglés, en vez de seguir buscando.
 */
export function normalizarIdioma(raw: unknown): Idioma | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return base === 'es' ? 'es' : 'en';
}

// Prefijos internacionales de países de habla hispana. Los de cuatro dígitos son
// los números de República Dominicana y Puerto Rico dentro del +1.
const PREFIJOS_HISPANOS = [
  '1809', '1829', '1849', '1787', '1939',
  '502', '503', '504', '505', '506', '507', '591', '593', '595', '598',
  '34', '51', '52', '53', '54', '56', '57', '58',
];

/** `es` si el teléfono es de un país de habla hispana. Sin `+` no se adivina. */
export function idiomaPorTelefono(phone: unknown): Idioma | null {
  if (typeof phone !== 'string' || !phone.trim().startsWith('+')) return null;
  const digitos = phone.replace(/\D/g, '');
  return PREFIJOS_HISPANOS.some((p) => digitos.startsWith(p)) ? 'es' : null;
}

export function resolverIdioma(fuentes: { token?: unknown; preferencia?: unknown; telefono?: unknown }): Idioma {
  return normalizarIdioma(fuentes.token)
    ?? normalizarIdioma(fuentes.preferencia)
    ?? idiomaPorTelefono(fuentes.telefono)
    ?? 'en';
}

export function textoBilingue(valor: string | Bilingue, idioma: Idioma): string {
  return typeof valor === 'string' ? valor : valor[idioma];
}

/**
 * La notificación con el texto de `idioma`, lista para mandar a FCM o guardar.
 *
 * `data.title` y `data.body` se traducen también cuando repiten el texto
 * principal: la app pinta el aviso dentro de la pantalla a partir de `data`, y
 * si no se cambiaran ahí el push saldría en español y el aviso en inglés.
 */
export function enIdioma<P extends Localizable>(payload: P, idioma: Idioma): P {
  const texto = idioma === 'es' && payload.es ? payload.es : { title: payload.title, body: payload.body };
  const data = payload.data ? { ...payload.data } : undefined;
  if (data && data.title === payload.title) data.title = texto.title;
  if (data && data.body === payload.body) data.body = texto.body;
  const { es: _es, ...resto } = payload;
  return { ...resto, title: texto.title, body: texto.body, ...(data ? { data } : {}) } as P;
}
