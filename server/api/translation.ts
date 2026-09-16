import { Router, Request, Response } from 'express';
import pino from 'pino';
import { supabaseAdmin } from '../db/client';
import { broadcastChatMessage } from '../services/socketService';
import { vistaPreviaMensaje } from '../services/chatPreview';
import { requireSupabaseAuth } from '../middleware';

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
translationRouter.post('/speak', async (req: Request, res: Response) => {
  const { rideId, senderRole, inputType, content, sourceLang, targetLang } = req.body as {
    rideId: string;
    senderRole: 'chauffeur' | 'passenger';
    inputType: 'text' | 'audio';
    content: string;
    sourceLang: string;
    targetLang: string;
  };

  if (!content?.trim()) return res.status(400).json({ error: 'content required' });
  if (!rideId) return res.status(400).json({ error: 'rideId required' });

  const originalText = content.trim();

  // Voice notes are NOT translated — they are raw audio encoded as base64
  const isVoiceNote = originalText.startsWith('[VOICE_NOTE:');
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
      })
      .select('id')
      .single();

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

    // Broadcast to ride room via Socket.IO for instant delivery (no polling delay)
    broadcastChatMessage(rideId, {
      id: msgId,
      senderRole,
      originalText,
      translatedText: (!isVoiceNote && translatedText !== originalText) ? translatedText : undefined,
      createdAt,
    });

    return res.json({
      conversationId: msgId,
      originalText,
      translatedText: (!isVoiceNote && translatedText !== originalText) ? translatedText : undefined,
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
    .select('id, ride_id, sender_role, original_text, translated_text, source_lang, target_lang, created_at')
    .eq('ride_id', rideId)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data ?? []);
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
      created_at: string;
    };

    // For each ride, get the last message
    const rideRows = rides as DriverRideRow[];
    const rideIds = rideRows.map((r) => r.id);
    const { data: allMessages, error: msgErr } = await supabaseAdmin
      .from('ride_chats')
      .select('ride_id, sender_role, original_text, created_at')
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
        lastMessage: vistaPreviaMensaje(lastMsgByRide[r.id]?.original_text).text,
        // Campo nuevo, 'voice' | 'text': para que la app pueda poner un ícono.
        lastMessageType: vistaPreviaMensaje(lastMsgByRide[r.id]?.original_text).type,
        lastMessageRole: lastMsgByRide[r.id]?.sender_role || 'passenger',
        lastMessageAt: lastMsgByRide[r.id]?.created_at,
      }));

    return res.json(conversations);
  } catch (err: unknown) {
    log.error({ err: errMsg(err), driverId }, 'driver-conversations error');
    return res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});
