/**
 * Avisos fijados: los que quedan arriba del buzón de la app hasta que caducan.
 *
 * No sustituyen al push. El push llega al instante y se va al leerlo; esto es
 * un tablón que permanece y que el usuario ve cuando abre la app.
 *
 * Todo lo de aquí es puro —sin base de datos ni red— para poder probarlo. La
 * parte que consulta vive en `server/api/announcements.ts`.
 */

export const IDIOMAS = ['en', 'es', 'fr', 'pt'] as const;
export type Idioma = (typeof IDIOMAS)[number];

export const AUDIENCIAS = ['all', 'passenger', 'driver', 'concierge'] as const;
export type Audiencia = (typeof AUDIENCIAS)[number];

export const TIPOS = ['promo', 'system', 'news'] as const;
export type TipoAviso = (typeof TIPOS)[number];

/** El idioma de respaldo: un anuncio sin traducir debe verse, no desaparecer. */
export const IDIOMA_RESPALDO: Idioma = 'en';

export interface TextoAviso {
  title?: unknown;
  description?: unknown;
  cta?: unknown;
}

/** Una fila de `announcements` tal como sale de la base. */
export interface FilaAviso {
  id: string;
  contenido: Record<string, TextoAviso> | string | null;
  audiencia: string;
  tipo: string;
  icono: string;
  etiqueta: string | null;
  enlace: string | null;
  publicado: boolean;
  desde: string;
  hasta: string | null;
}

/** La forma exacta que ya pinta la app (`NotifItem` en useNotifications.ts). */
export interface AvisoParaLaApp {
  id: string;
  type: TipoAviso;
  title: string;
  description: string;
  timeMs: number;
  iconType: string;
  pinned: true;
  tag?: string;
  cta?: string;
  link?: string;
}

function texto(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function esIdioma(v: unknown): v is Idioma {
  return typeof v === 'string' && (IDIOMAS as readonly string[]).includes(v);
}

export function esAudiencia(v: unknown): v is Audiencia {
  return typeof v === 'string' && (AUDIENCIAS as readonly string[]).includes(v);
}

/**
 * El rol que pide la app, normalizado.
 *
 * Cualquier cosa rara cae en `passenger` en vez de dar error: un parámetro mal
 * escrito no debe dejar a nadie sin avisos.
 */
export function normalizarRol(v: unknown): Exclude<Audiencia, 'all'> {
  const r = String(v ?? '').trim().toLowerCase();
  if (r === 'driver' || r === 'chauffeur') return 'driver';
  if (r === 'concierge' || r === 'valet') return 'concierge';
  return 'passenger';
}

export function normalizarIdioma(v: unknown): Idioma {
  const l = String(v ?? '').trim().toLowerCase().slice(0, 2);
  return esIdioma(l) ? l : IDIOMA_RESPALDO;
}

/** Publicado, ya empezado y todavía no caducado. */
export function estaVigente(fila: Pick<FilaAviso, 'publicado' | 'desde' | 'hasta'>, ahora: Date = new Date()): boolean {
  if (!fila.publicado) return false;
  const desde = Date.parse(fila.desde);
  if (Number.isNaN(desde) || desde > ahora.getTime()) return false;
  if (!fila.hasta) return true;
  const hasta = Date.parse(fila.hasta);
  return Number.isNaN(hasta) ? true : hasta > ahora.getTime();
}

/** `all` llega a todos; el resto solo a su rol. */
export function alcanza(fila: Pick<FilaAviso, 'audiencia'>, rol: string): boolean {
  return fila.audiencia === 'all' || fila.audiencia === rol;
}

/**
 * El texto en el idioma pedido, con inglés de respaldo.
 *
 * Devuelve `null` cuando no hay ni uno ni otro: más vale que ese anuncio no
 * salga a que salga en blanco en la pantalla del pasajero.
 */
export function traducir(contenido: FilaAviso['contenido'], lang: Idioma): { title: string; description: string; cta?: string } | null {
  let mapa: Record<string, TextoAviso>;
  if (typeof contenido === 'string') {
    try { mapa = JSON.parse(contenido) as Record<string, TextoAviso>; } catch { return null; }
  } else if (contenido && typeof contenido === 'object') {
    mapa = contenido;
  } else {
    return null;
  }

  for (const clave of [lang, IDIOMA_RESPALDO]) {
    const t = mapa?.[clave];
    const title = texto(t?.title);
    if (!title) continue;
    const cta = texto(t?.cta);
    return { title, description: texto(t?.description), ...(cta ? { cta } : {}) };
  }
  return null;
}

/** La fila como la espera la app, o `null` si no hay texto utilizable. */
export function aAvisoDeLaApp(fila: FilaAviso, lang: Idioma): AvisoParaLaApp | null {
  const t = traducir(fila.contenido, lang);
  if (!t) return null;

  const desde = Date.parse(fila.desde);
  return {
    id: fila.id,
    type: (TIPOS as readonly string[]).includes(fila.tipo) ? (fila.tipo as TipoAviso) : 'news',
    title: t.title,
    description: t.description,
    timeMs: Number.isNaN(desde) ? Date.now() : desde,
    iconType: fila.icono || 'newspaper',
    pinned: true,
    ...(fila.etiqueta ? { tag: fila.etiqueta } : {}),
    ...(t.cta ? { cta: t.cta } : {}),
    ...(fila.enlace ? { link: fila.enlace } : {}),
  };
}

/**
 * Los avisos que le tocan a alguien, listos para pintar.
 *
 * Lo más reciente primero, que es como los lista la app.
 */
export function avisosPara(
  filas: FilaAviso[],
  opts: { rol: string; lang: Idioma; ahora?: Date; limite?: number },
): AvisoParaLaApp[] {
  const ahora = opts.ahora ?? new Date();
  return filas
    .filter(f => estaVigente(f, ahora) && alcanza(f, opts.rol))
    .map(f => aAvisoDeLaApp(f, opts.lang))
    .filter((a): a is AvisoParaLaApp => a !== null)
    .sort((a, b) => b.timeMs - a.timeMs)
    .slice(0, opts.limite ?? 20);
}
