/**
 * Notas de voz del chat pasajero ↔ chofer, subidas como archivo.
 *
 * Antes el audio viajaba en base64 dentro del texto (`[VOICE_NOTE:<base64>]`).
 * Ahora la app pide una URL firmada (`POST /api/translation/voice-notes`), sube
 * el archivo al bucket privado y manda a `/speak` sólo el `voiceNoteId`. Los
 * mensajes viejos en base64 se siguen devolviendo tal cual.
 *
 * Aquí van las reglas, sin base de datos ni storage, para poder probarlas.
 */

export const VOICE_BUCKET = 'ride-chat-audio';

/** Lo que se acepta. m4a/AAC es lo que suena en Android y en iOS. */
export const AUDIO_TIPOS = ['audio/mp4', 'audio/aac', 'audio/webm', 'audio/ogg'] as const;
export type AudioTipo = typeof AUDIO_TIPOS[number];

/** 5 MB: un m4a de 5 minutos a 64 kbps ocupa unos 2,4 MB. */
export const AUDIO_MAX_BYTES = 5 * 1024 * 1024;
export const AUDIO_MAX_DURACION_MS = 5 * 60 * 1000;

/** El enlace de descarga vale 6 horas; el historial lo renueva en cada lectura. */
export const AUDIO_DESCARGA_SEGUNDOS = 6 * 60 * 60;
/** Lo que dura la URL de subida de Supabase. */
export const AUDIO_SUBIDA_SEGUNDOS = 2 * 60 * 60;

/** Lo que guarda `ride_chats.original_text` en una nota subida como archivo. */
export const TEXTO_NOTA_ARCHIVO = 'Voice message';

const ALIAS: Record<string, AudioTipo> = {
  'audio/m4a': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/mp4a-latm': 'audio/mp4',
  'audio/x-aac': 'audio/aac',
};

const EXTENSION: Record<AudioTipo, string> = {
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
};

/**
 * `audio/webm;codecs=opus` → `audio/webm`; `audio/x-m4a` → `audio/mp4`.
 * `null` si no es un formato aceptado.
 */
export function normalizarMime(valor: unknown): AudioTipo | null {
  if (typeof valor !== 'string') return null;
  const base = valor.split(';')[0].trim().toLowerCase();
  const tipo = ALIAS[base] ?? base;
  return (AUDIO_TIPOS as readonly string[]).includes(tipo) ? (tipo as AudioTipo) : null;
}

export function mimeDeRuta(ruta: string): AudioTipo | null {
  const ext = ruta.split('.').pop();
  const par = Object.entries(EXTENSION).find(([, e]) => e === ext);
  return par ? (par[0] as AudioTipo) : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const esUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** Una carpeta por viaje: `<rideId>/<voiceNoteId>.<ext>`. */
export function rutaNota(rideId: string, voiceNoteId: string, mime: AudioTipo): string {
  return `${rideId}/${voiceNoteId}.${EXTENSION[mime]}`;
}

/**
 * Duración que manda la app. Opcional: `null` si no llega; `undefined` si es
 * inválida (negativa, no numérica o de más de 5 minutos).
 */
export function normalizarDuracion(valor: unknown): number | null | undefined {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = typeof valor === 'number' ? valor : typeof valor === 'string' ? Number(valor) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > AUDIO_MAX_DURACION_MS) return undefined;
  return Math.round(n);
}
