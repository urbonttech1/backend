import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import pino from 'pino';
import { supabaseAdmin } from '../db/client';
import { broadcastChatMessage } from '../services/socketService';
import { vistaPreviaMensaje } from '../services/chatPreview';
import { requireSupabaseAuth } from '../middleware';
import {
  VOICE_BUCKET, AUDIO_TIPOS, AUDIO_MAX_BYTES, AUDIO_MAX_DURACION_MS, AUDIO_DESCARGA_SEGUNDOS,
  AUDIO_SUBIDA_SEGUNDOS, TEXTO_NOTA_ARCHIVO, normalizarMime, mimeDeRuta, rutaNota, normalizarDuracion, esUuid,
} from '../services/voiceNote';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

const log = pino({ level: 'info' });
export const translationRouter = Router();

async function translateText(text: string, from: string, to: string): Promise<string> {
  if (from === to || !text.trim()) return text;
  
  // GROK_API_KEY actually holds a Groq Cloud key (gsk_*). We route through
  // Groq's OpenAI-compatible endpoint with a low-latency Llama model so the
  // chauffeur ↔ passenger translator stays under ~200ms per turn.
  const GROQ_KEY = process.env.GROK_API_KEY || process.env.GROQ_API_KEY;
  if (!GROQ_KEY) {
    return text;
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'You are an elite, invisible URBONT Chauffeur-Passenger real-time translation module. You must translate the user text accurately maintaining its precise intent and tone (formal/polite if passenger, professional if chauffeur). CRITICAL INSTRUCTION: Return ONLY the raw translated text. Absolutely no quotes, no explanations, no markdown, and no pleasantries. Just the translated text string.'
          },
          {
            role: 'user',
            content: `Translate strictly from ${from} to ${to}: "${text}"`
          }
        ],
        temperature: 0.1,
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      log.error({ status: response.status, body: body.slice(0, 300) }, 'Groq translation API failed');
      return text;
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    let translated = data.choices?.[0]?.message?.content?.trim() || '';

    // Strip accidental quotes if Grok defies instructions
    if (translated.startsWith('"') && translated.endsWith('"')) {
      translated = translated.slice(1, -1);
    }
    
    return translated || text;
  } catch (err: unknown) {
    log.error({ err: errMsg(err) }, 'Grok network translation error');
    return text;
  }
}

// POST /api/translation/speak — translate and store a chat message
// ─── Notas de voz como archivo ───────────────────────────────────────────────

let bucketVozListo = false;

/** Crea el bucket privado la primera vez, y lo corrige si alguien lo hizo público. */
async function asegurarBucketVoz(): Promise<void> {
  if (bucketVozListo) return;
  const opciones = { public: false, fileSizeLimit: AUDIO_MAX_BYTES, allowedMimeTypes: [...AUDIO_TIPOS] };
  const { data } = await supabaseAdmin.storage.getBucket(VOICE_BUCKET);
  if (!data) {
    const { error } = await supabaseAdmin.storage.createBucket(VOICE_BUCKET, opciones);
    if (error && !/already exists/i.test(error.message)) throw error;
  } else if (data.public) {
    log.warn({ bucket: VOICE_BUCKET }, 'voice note bucket was public — making it private');
    const { error } = await supabaseAdmin.storage.updateBucket(VOICE_BUCKET, opciones);
    if (error) throw error;
  }
  bucketVozListo = true;
}

type Firmado = { audioUrl: string; audioUrlExpiresAt: string };

/** Enlaces de descarga para varias notas de una vez. Las que fallen quedan sin enlace. */
async function firmarAudios(rutas: string[]): Promise<Map<string, Firmado>> {
  const firmados = new Map<string, Firmado>();
  if (rutas.length === 0) return firmados;
  const expira = new Date(Date.now() + AUDIO_DESCARGA_SEGUNDOS * 1000).toISOString();
  const { data, error } = await supabaseAdmin.storage.from(VOICE_BUCKET).createSignedUrls(rutas, AUDIO_DESCARGA_SEGUNDOS);
  if (error) {
    log.warn({ err: error.message }, 'voice note signing failed');
    return firmados;
  }
  for (const f of data ?? []) {
    if (f.path && f.signedUrl && !f.error) firmados.set(f.path, { audioUrl: f.signedUrl, audioUrlExpiresAt: expira });
  }
  return firmados;
}

// POST /api/translation/voice-notes — URL firmada para subir una nota de voz.
// Sólo el pasajero o el chofer del viaje.
translationRouter.post('/voice-notes', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const body = (req.body ?? {}) as { rideId?: unknown; mimeType?: unknown };

  if (!esUuid(body.rideId)) {
    return res.status(400).json({ error: 'rideId required', errorCode: 'INVALID_RIDE_ID', field: 'rideId' });
  }
  const rideId = body.rideId;
  const mimeType = normalizarMime(body.mimeType);
  if (!mimeType) {
    return res.status(400).json({
      error: 'This audio format is not accepted.',
      errorCode: 'INVALID_MIME_TYPE',
      field: 'mimeType',
      acceptedMimeTypes: AUDIO_TIPOS,
    });
  }

  try {
    const { data: ride, error: rideErr } = await supabaseAdmin
      .from('rides').select('driver_id, passenger_id').eq('id', rideId).maybeSingle();
    if (rideErr) throw rideErr;
    if (!ride) return res.status(404).json({ error: 'Ride not found', errorCode: 'RIDE_NOT_FOUND' });
    const r = ride as { driver_id: string | null; passenger_id: string | null };
    if (uid !== r.driver_id && uid !== r.passenger_id) {
      return res.status(403).json({ error: 'Not a participant of this ride', errorCode: 'ACCESS_DENIED' });
    }

    await asegurarBucketVoz();

    const voiceNoteId = randomUUID();
    const path = rutaNota(rideId, voiceNoteId, mimeType);
    const { data: firmada, error: firmarErr } = await supabaseAdmin.storage.from(VOICE_BUCKET).createSignedUploadUrl(path);
    if (firmarErr || !firmada) throw firmarErr ?? new Error('no signed upload url');

    return res.status(201).json({
      voiceNoteId,
      uploadUrl: firmada.signedUrl,
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      mimeType,
      maxBytes: AUDIO_MAX_BYTES,
      maxDurationMs: AUDIO_MAX_DURACION_MS,
      expiresInSeconds: AUDIO_SUBIDA_SEGUNDOS,
    });
  } catch (err: unknown) {
    log.error({ err: errMsg(err), uid, rideId }, 'voice note upload url error');
    return res.status(500).json({
      error: 'We could not prepare the voice note upload. Please try again.',
      errorCode: 'UPLOAD_URL_FAILED',
    });
  }
});

/** Busca el archivo ya subido de una nota. `null` si no está. */
async function buscarNotaSubida(rideId: string, voiceNoteId: string) {
  const { data, error } = await supabaseAdmin.storage.from(VOICE_BUCKET).list(rideId, { search: voiceNoteId, limit: 5 });
  if (error) throw error;
  const archivo = (data ?? []).find((f) => f.name.startsWith(`${voiceNoteId}.`));
  if (!archivo) return null;
  const path = `${rideId}/${archivo.name}`;
  const mimeType = mimeDeRuta(path);
  if (!mimeType) return null;
  const size = Number((archivo.metadata as { size?: unknown } | null)?.size ?? 0);
  return { path, mimeType, size };
}

translationRouter.post('/speak', async (req: Request, res: Response) => {
  const { rideId, senderRole, inputType, content, sourceLang, targetLang, voiceNoteId, durationMs } = req.body as {
    rideId: string;
    senderRole: 'chauffeur' | 'passenger';
    inputType: 'text' | 'audio';
    content: string;
    sourceLang: string;
    targetLang: string;
    voiceNoteId?: unknown;
    durationMs?: unknown;
  };

  if (!rideId) return res.status(400).json({ error: 'rideId required' });

  // Nota de voz subida como archivo: se manda el voiceNoteId en vez del base64.
  let audio: { path: string; mimeType: string; durationMs: number | null } | null = null;
  if (voiceNoteId !== undefined && voiceNoteId !== null && voiceNoteId !== '') {
    if (!esUuid(voiceNoteId) || !esUuid(rideId)) {
      return res.status(400).json({ error: 'Invalid voiceNoteId', errorCode: 'INVALID_VOICE_NOTE_ID', field: 'voiceNoteId' });
    }
    const duracion = normalizarDuracion(durationMs);
    if (duracion === undefined) {
      return res.status(400).json({ error: 'Invalid durationMs', errorCode: 'INVALID_DURATION', field: 'durationMs' });
    }
    try {
      const subida = await buscarNotaSubida(rideId, voiceNoteId);
      if (!subida) {
        return res.status(400).json({
          error: 'The voice note was not uploaded for this ride.',
          errorCode: 'VOICE_NOTE_NOT_UPLOADED',
          field: 'voiceNoteId',
        });
      }
      if (subida.size > AUDIO_MAX_BYTES) {
        await supabaseAdmin.storage.from(VOICE_BUCKET).remove([subida.path]);
        return res.status(413).json({ error: 'The voice note is too large.', errorCode: 'VOICE_NOTE_TOO_LARGE', maxBytes: AUDIO_MAX_BYTES });
      }
      audio = { path: subida.path, mimeType: subida.mimeType, durationMs: duracion };
    } catch (err) {
      log.error({ err: errMsg(err), rideId }, 'voice note lookup error');
      return res.status(500).json({ error: 'Failed to save message', errorCode: 'MESSAGE_NOT_SAVED' });
    }
  } else if (!content?.trim()) {
    return res.status(400).json({ error: 'content required' });
  }

  const originalText = audio ? TEXTO_NOTA_ARCHIVO : content.trim();

  // Voice notes are NOT translated — raw base64 (old format) or an uploaded file
  const isVoiceNote = !!audio || originalText.startsWith('[VOICE_NOTE:');
  const translatedText = isVoiceNote
    ? originalText
    : await translateText(originalText, sourceLang || 'en', targetLang || 'es');

  try {
    const { data: inserted, error } = await supabaseAdmin
      .from('ride_chats')
      .insert({
        ride_id: rideId,
        sender_role: senderRole,
        original_text: originalText,
        translated_text: (!isVoiceNote && translatedText !== originalText) ? translatedText : null,
        source_lang: sourceLang || 'en',
        target_lang: targetLang || 'es',
        ...(audio ? { audio_path: audio.path, audio_mime: audio.mimeType, audio_duration_ms: audio.durationMs } : {}),
      })
      .select('id')
      .single();

    // El mismo archivo ya se envió (índice único en audio_path).
    if (audio && error?.code === '23505') {
      return res.status(409).json({ error: 'This voice note was already sent.', errorCode: 'VOICE_NOTE_ALREADY_SENT' });
    }

    // Si no se guardó, no se anuncia. Antes sólo se registraba el error y se
    // seguía: se emitía el mensaje con un id inventado (Date.now()) y se
    // respondía 200, así que el remitente veía los dos checks de un mensaje que
    // no existía y que desaparecía al recargar. Con un error, la app lo retira.
    const guardado = (inserted as { id?: unknown } | null)?.id;
    if (error || guardado === undefined || guardado === null) {
      log.error({ err: error?.message ?? 'insert sin id', rideId }, 'ride_chats insert error');
      return res.status(500).json({ error: 'Failed to save message', errorCode: 'MESSAGE_NOT_SAVED' });
    }

    const msgId = String(guardado);
    const createdAt = new Date().toISOString();

    const firmado = audio ? (await firmarAudios([audio.path])).get(audio.path) : undefined;
    const audioCampos = audio
      ? { ...firmado, mimeType: audio.mimeType, durationMs: audio.durationMs }
      : {};

    // Broadcast to ride room via Socket.IO for instant delivery (no polling delay)
    broadcastChatMessage(rideId, {
      id: msgId,
      senderRole,
      originalText,
      translatedText: (!isVoiceNote && translatedText !== originalText) ? translatedText : undefined,
      createdAt,
      ...audioCampos,
    });

    return res.json({
      conversationId: msgId,
      originalText,
      translatedText: (!isVoiceNote && translatedText !== originalText) ? translatedText : undefined,
      ...audioCampos,
    });
  } catch (err) {
    log.error({ err: errMsg(err) }, 'translation speak error');
    return res.status(500).json({ error: 'Failed to save message' });
  }
});

// GET /api/translation/messages/:rideId — fetch all messages for a ride
// Requires authentication: caller must be the driver or passenger for the ride, or an admin.
translationRouter.get('/messages/:rideId', requireSupabaseAuth, async (req: Request, res: Response) => {
  const { rideId } = req.params;
  const callerId = req.supabaseUid!;
  const callerRole = req.supabaseRole || 'passenger';

  // Admins may read any ride's messages
  if (callerRole !== 'admin') {
    // Verify the caller is the driver or passenger on this ride
    const { data: ride, error: rideErr } = await supabaseAdmin
      .from('rides')
      .select('driver_id, passenger_id')
      .eq('id', rideId)
      .single();
    if (rideErr || !ride) return res.status(404).json({ error: 'Ride not found' });
    const rideRow = ride as { driver_id: string | null; passenger_id: string | null };
    const isParticipant = rideRow.driver_id === callerId || rideRow.passenger_id === callerId;
    if (!isParticipant) return res.status(403).json({ error: 'Not authorized to view these messages' });
  }

  const { data, error } = await supabaseAdmin
    .from('ride_chats')
    .select('id, ride_id, sender_role, original_text, translated_text, source_lang, target_lang, created_at, audio_path, audio_mime, audio_duration_ms')
    .eq('ride_id', rideId)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });

  // Las notas subidas como archivo llevan audioUrl, firmada de nuevo en cada
  // lectura. Las viejas en base64 siguen como estaban, en original_text.
  type Fila = Record<string, unknown> & { audio_path?: string | null; audio_mime?: string | null; audio_duration_ms?: number | null };
  const filas = (data ?? []) as Fila[];
  const firmados = await firmarAudios(filas.map((f) => f.audio_path).filter((p): p is string => !!p));
  return res.json(filas.map(({ audio_path, audio_mime, audio_duration_ms, ...fila }) => (
    audio_path
      ? {
          ...fila,
          audioUrl: firmados.get(audio_path)?.audioUrl ?? null,
          audioUrlExpiresAt: firmados.get(audio_path)?.audioUrlExpiresAt ?? null,
          mimeType: audio_mime ?? mimeDeRuta(audio_path),
          durationMs: audio_duration_ms ?? null,
        }
      : fila
  )));
});

// GET /api/translation/driver-conversations — recent ride conversations for the authenticated driver
translationRouter.get('/driver-conversations', requireSupabaseAuth, async (req: Request, res: Response) => {
  const driverId = req.supabaseUid!;

  try {
    // Get recent rides for this driver that have chat messages
    const { data: rides, error: ridesErr } = await supabaseAdmin
      .from('rides')
      .select('id, pickup_address, dropoff_address, passenger_name, ride_status, completed_at, created_at')
      .eq('driver_id', driverId)
      .in('ride_status', ['completed', 'in_progress'])
      .order('created_at', { ascending: false })
      .limit(20);

    if (ridesErr) throw ridesErr;
    if (!rides || rides.length === 0) return res.json([]);

    type DriverRideRow = {
      id: string;
      pickup_address?: string;
      dropoff_address?: string;
      passenger_name?: string;
      ride_status?: string;
      completed_at?: string;
      created_at?: string;
    };
    type RideChatRow = {
      ride_id: string;
      sender_role: string;
      original_text: string;
      audio_path?: string | null;
      created_at: string;
    };

    // For each ride, get the last message
    const rideRows = rides as DriverRideRow[];
    const rideIds = rideRows.map((r) => r.id);
    const { data: allMessages, error: msgErr } = await supabaseAdmin
      .from('ride_chats')
      .select('ride_id, sender_role, original_text, audio_path, created_at')
      .in('ride_id', rideIds)
      .order('created_at', { ascending: false });

    if (msgErr) throw msgErr;

    // Group last message per ride
    const lastMsgByRide: Record<string, RideChatRow> = {};
    for (const msg of ((allMessages ?? []) as RideChatRow[])) {
      if (!lastMsgByRide[msg.ride_id]) lastMsgByRide[msg.ride_id] = msg;
    }

    // Only return rides that have at least one message
    const conversations = rideRows
      .filter((r) => lastMsgByRide[r.id])
      .map((r) => ({
        rideId: r.id,
        passengerName: r.passenger_name || 'Passenger',
        pickup: r.pickup_address,
        dropoff: r.dropoff_address,
        status: r.ride_status,
        date: r.completed_at || r.created_at,
        // Una nota de voz llega como «Voice message», no como su audio en base64.
        lastMessage: vistaPreviaMensaje(lastMsgByRide[r.id]?.original_text, lastMsgByRide[r.id]?.audio_path).text,
        // Campo nuevo, 'voice' | 'text': para que la app pueda poner un ícono.
        lastMessageType: vistaPreviaMensaje(lastMsgByRide[r.id]?.original_text, lastMsgByRide[r.id]?.audio_path).type,
        lastMessageRole: lastMsgByRide[r.id]?.sender_role || 'passenger',
        lastMessageAt: lastMsgByRide[r.id]?.created_at,
      }));

    return res.json(conversations);
  } catch (err: unknown) {
    log.error({ err: errMsg(err), driverId }, 'driver-conversations error');
    return res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});
