/**
 * Transcripción de notas de voz del chat.
 *
 * Una nota de voz viajaba como audio y nada más: el que la recibía oía un idioma
 * que quizá no habla, y el lector en voz alta del chofer la saltaba porque no
 * había texto que leer. Aquí se transcribe con Whisper para que después pase por
 * el mismo traductor que los mensajes escritos.
 *
 * Usa la misma clave de OpenAI que `translateText`, administrada desde el panel
 * (`translationConfig`), así que no hay una segunda credencial que mantener.
 */
import { supabaseAdmin } from '../db/client';
import { createContextLogger } from '../lib/logger';
import { cargarConfigTraduccion, configTraduccionEnMemoria } from './translationConfig';
import { VOICE_BUCKET, AUDIO_MAX_BYTES, normalizarMime, type AudioTipo } from './voiceNote';
import { translateText } from './translate';
import { broadcastChatTranscript } from './socketService';

const log = createContextLogger('VOICE_TRANSCRIPTION');

/** Whisper es el modelo estable de transcripción; el de chat no sirve para audio. */
const MODELO_TRANSCRIPCION = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

/** Una nota de 5 minutos tarda unos segundos; pasado esto se abandona. */
const TIMEOUT_MS = 60_000;

const EXTENSION: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
};

/**
 * Descarga la nota del bucket privado y devuelve el texto que se oye.
 *
 * Nunca lanza: si algo falla devuelve null y la nota se queda como estaba, que
 * es exactamente el comportamiento que había antes de existir esta función.
 *
 * @param sourceLang Idioma esperado, en ISO-639-1. Es una pista para Whisper,
 *                   no una imposición: si el hablante usa otro, lo detecta igual.
 */
export async function transcribirNota(
  audioPath: string,
  mime: AudioTipo | null,
  sourceLang?: string,
): Promise<string | null> {
  await cargarConfigTraduccion();
  const { apiKey } = configTraduccionEnMemoria();
  if (!apiKey) {
    log.warn('sin API key de OpenAI — la nota de voz no se transcribe');
    return null;
  }

  try {
    const { data: archivo, error } = await supabaseAdmin.storage
      .from(VOICE_BUCKET)
      .download(audioPath);

    if (error || !archivo) {
      log.warn({ audioPath, err: error?.message }, 'no se pudo descargar la nota');
      return null;
    }

    // El límite de subida ya lo aplica /voice-notes; esto cubre un objeto que
    // haya entrado al bucket por otra vía.
    if (archivo.size > AUDIO_MAX_BYTES) {
      log.warn({ audioPath, size: archivo.size }, 'nota demasiado grande para transcribir');
      return null;
    }

    const ext = EXTENSION[mime ?? ''] ?? 'm4a';
    const form = new FormData();
    form.append('file', archivo, `nota.${ext}`);
    form.append('model', MODELO_TRANSCRIPCION);
    form.append('response_format', 'text');
    // Whisper espera ISO-639-1 de dos letras; 'es-ES' lo rechaza.
    const iso = sourceLang?.slice(0, 2).toLowerCase();
    if (iso && /^[a-z]{2}$/.test(iso)) form.append('language', iso);

    const respuesta = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!respuesta.ok) {
      const cuerpo = await respuesta.text().catch(() => '');
      log.error({ status: respuesta.status, body: cuerpo.slice(0, 300) }, 'Whisper falló');
      return null;
    }

    // Con response_format=text la respuesta es el texto pelado, no JSON.
    const texto = (await respuesta.text()).trim();
    if (!texto) return null;

    log.info({ audioPath, chars: texto.length }, 'nota de voz transcrita');
    return texto;
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    log.error({ audioPath, err: mensaje }, 'error transcribiendo la nota');
    return null;
  }
}

/** Pasados estos intentos se marca `failed` y se deja de reintentar. */
export const MAX_INTENTOS = 3;

/**
 * Transcribe una nota, la traduce, guarda el resultado y avisa por socket.
 *
 * La llama el endpoint de chat nada más recibir la nota, y el cron cuando una
 * se quedó a medias — por ejemplo si el proceso se reinició justo aquí. Por eso
 * vive en el servicio y no en el router: sin esto, una nota pendiente no se
 * transcribía nunca.
 *
 * @returns true si quedó transcrita.
 */
export async function procesarNota(args: {
  msgId: string;
  rideId: string;
  senderRole: string;
  audioPath: string;
  mime: string | null;
  sourceLang: string;
  targetLang: string;
  intentosPrevios?: number;
}): Promise<boolean> {
  const { msgId, rideId, senderRole, audioPath, mime, sourceLang, targetLang } = args;
  const intento = (args.intentosPrevios ?? 0) + 1;

  try {
    const transcript = await transcribirNota(audioPath, normalizarMime(mime), sourceLang);

    if (!transcript) {
      // Se agotaron los intentos: `failed` para que la app lo diga y el cron
      // deje de intentarlo. Si no, sigue `pending` y el barrido vuelve luego.
      const agotado = intento >= MAX_INTENTOS;
      await supabaseAdmin
        .from('ride_chats')
        .update({
          transcript_attempts: intento,
          transcript_status: agotado ? 'failed' : 'pending',
        })
        .eq('id', msgId);

      if (agotado) {
        log.warn({ msgId, intento }, 'nota de voz sin transcribir tras agotar los intentos');
        broadcastChatTranscript(rideId, { id: msgId, senderRole, transcript: '', status: 'failed' });
      }
      return false;
    }

    const traducido = await translateText(transcript, sourceLang, targetLang);
    const transcriptTranslated = traducido !== transcript ? traducido : undefined;

    const { error } = await supabaseAdmin
      .from('ride_chats')
      .update({
        transcript,
        transcript_translated: transcriptTranslated ?? null,
        transcript_status: 'done',
        transcript_attempts: intento,
      })
      .eq('id', msgId);

    if (error) {
      log.error({ err: error.message, msgId }, 'no se pudo guardar la transcripción');
      return false;
    }

    broadcastChatTranscript(rideId, { id: msgId, senderRole, transcript, transcriptTranslated, status: 'done' });
    return true;
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err);
    log.error({ msgId, err: mensaje, intento }, 'procesarNota falló');
    await supabaseAdmin
      .from('ride_chats')
      .update({
        transcript_attempts: intento,
        transcript_status: intento >= MAX_INTENTOS ? 'failed' : 'pending',
      })
      .eq('id', msgId)
      .then(() => {}, () => {});
    return false;
  }
}
