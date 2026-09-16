/**
 * Vista previa del último mensaje de un chat, para listas como el Inbox del
 * conductor (`GET /api/translation/driver-conversations`).
 */

/** Así empieza una nota de voz guardada en `ride_chats.original_text`. */
export const VOICE_NOTE_PREFIX = '[VOICE_NOTE:';

export interface VistaPrevia {
  text: string;
  type: 'text' | 'voice';
}

/**
 * Las notas de voz se guardan como `[VOICE_NOTE:<base64>]` en el mismo campo que
 * el texto. Devolver ese contenido en una lista mandaba el audio completo
 * —cientos de KB por conversación— para acabar pintado como texto en la vista
 * previa.
 */
export function vistaPreviaMensaje(texto: string | null | undefined): VistaPrevia {
  const t = texto ?? '';
  if (t.startsWith(VOICE_NOTE_PREFIX)) return { text: 'Voice message', type: 'voice' };
  return { text: t, type: 'text' };
}
