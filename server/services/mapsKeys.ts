/**
 * Qué clave de Google Maps usa cada quien.
 *
 * Hay dos claves y no son intercambiables:
 *
 *   - La del navegador viaja dentro de la app, así que va restringida por
 *     referente (los dominios de Urbont y `https://localhost/*`, que es como
 *     Capacitor sirve el bundle). Es la que se publica en `GET /api/config`.
 *   - La del servidor la usan Geocoding, Directions y Places desde el backend.
 *     Esas APIs REST **rechazan por diseño** cualquier clave restringida por
 *     referente, así que necesita su propia clave, restringida por IP.
 *
 * El problema que esto resuelve: todo el backend leía
 * `VITE_GOOGLE_MAPS_API_KEY || GOOGLE_MAPS_API_KEY`, en ese orden. Publicar la
 * clave de navegador en la variable `VITE_…` —que es lo natural, porque es la
 * que lee la app— habría hecho que el servidor la usara también para sus
 * llamadas REST, y habrían empezado a fallar con `REQUEST_DENIED`: geocodificar
 * direcciones, calcular rutas y crear viajes.
 *
 * Con estas dos funciones cada lado pide la suya por su nombre. Mientras no se
 * definan las variables nuevas, el comportamiento es idéntico al de siempre.
 */

export interface EntornoMaps {
  /** La clave de navegador, restringida por referente. */
  GOOGLE_MAPS_BROWSER_KEY?: string;
  /** La clave de servidor, restringida por IP. */
  GOOGLE_MAPS_SERVER_KEY?: string;
  /** Las de siempre, que siguen valiendo como respaldo. */
  VITE_GOOGLE_MAPS_API_KEY?: string;
  GOOGLE_MAPS_API_KEY?: string;
  VITE_GOOGLE_MAPS_MAP_ID?: string;
  GOOGLE_MAPS_MAP_ID?: string;
}

const primera = (...valores: Array<string | undefined>): string =>
  valores.find((v) => typeof v === 'string' && v.trim() !== '')?.trim() ?? '';

/**
 * La que se le publica a la app en `/api/config`.
 *
 * Manda la específica de navegador; si no está, se cae a las de siempre para no
 * romper nada mientras se hace el cambio.
 */
export function claveDeNavegador(env: EntornoMaps): string {
  return primera(env.GOOGLE_MAPS_BROWSER_KEY, env.VITE_GOOGLE_MAPS_API_KEY, env.GOOGLE_MAPS_API_KEY);
}

/**
 * La que usa el backend contra Geocoding, Directions y Places.
 *
 * Nunca escoge `GOOGLE_MAPS_BROWSER_KEY`: esa está restringida por referente y
 * estas APIs la rechazarían. Si sólo existe la clave de navegador, es preferible
 * quedarse sin clave —el código ya trata ese caso— que llamar con una que va a
 * fallar.
 */
export function claveDeServidor(env: EntornoMaps): string {
  return primera(env.GOOGLE_MAPS_SERVER_KEY, env.GOOGLE_MAPS_API_KEY, env.VITE_GOOGLE_MAPS_API_KEY);
}

/** El Map ID que se le publica a la app. */
export function mapIdPublicado(env: EntornoMaps): string {
  return primera(env.VITE_GOOGLE_MAPS_MAP_ID, env.GOOGLE_MAPS_MAP_ID);
}
