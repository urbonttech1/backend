/**
 * Traducción de texto del chat con el modelo que administra el panel.
 *
 * Vivía dentro de `api/translation.ts`. Se sacó para que la transcripción de
 * notas de voz pueda usarla sin importar el router, que daría import circular.
 */
import pino from 'pino';
import { cargarConfigTraduccion, configTraduccionEnMemoria } from './translationConfig';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

const log = pino({ level: 'info' });

export async function translateText(text: string, from: string, to: string): Promise<string> {
  if (from === to || !text.trim()) return text;

  await cargarConfigTraduccion();
  const { apiKey, model } = configTraduccionEnMemoria();
  if (!apiKey) {
    return text;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
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
      log.error({ status: response.status, body: body.slice(0, 300) }, 'OpenAI translation API failed');
      return text;
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    let translated = data.choices?.[0]?.message?.content?.trim() || '';
    translated = translated.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const lastLine = translated.split('\n').map(line => line.trim()).filter(Boolean).pop() || '';
    if (lastLine) translated = lastLine;

    // Strip accidental quotes if the model defies instructions
    if (translated.startsWith('"') && translated.endsWith('"')) {
      translated = translated.slice(1, -1);
    }

    return translated || text;
  } catch (err: unknown) {
    log.error({ err: errMsg(err) }, 'OpenAI network translation error');
    return text;
  }
}
