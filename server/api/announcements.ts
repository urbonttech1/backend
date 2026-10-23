import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../db/client';
import { createContextLogger } from '../lib/logger';
import { avisosPara, normalizarRol, normalizarIdioma, type FilaAviso } from '../services/announcements';

const log = createContextLogger('ANNOUNCEMENTS');

export const announcementsRouter = Router();

/**
 * Los avisos fijados que le tocan a quien pregunta.
 *
 * Sin token a propósito: un anuncio no es dato sensible, y así la app puede
 * pedirlos también antes de iniciar sesión, que es cuando todavía no sabe el
 * rol. Va detrás del `apiLimiter` general como el resto de `/api`.
 *
 * Nunca falla con 500: si la consulta se cae, se devuelve una lista vacía. La
 * app se comporta entonces igual que antes de que esto existiera, y un anuncio
 * de marketing no puede romperle el buzón a nadie.
 *
 * GET /api/announcements?role=passenger&lang=es
 */
announcementsRouter.get('/', async (req: Request, res: Response) => {
  const rol = normalizarRol(req.query.role);
  const lang = normalizarIdioma(req.query.lang);

  try {
    // Se filtra `publicado` en la consulta para aprovechar el índice parcial;
    // la vigencia y la audiencia se resuelven en el servicio, que está probado.
    const { data, error } = await supabaseAdmin
      .from('announcements')
      .select('id, contenido, audiencia, tipo, icono, etiqueta, enlace, publicado, desde, hasta')
      .eq('publicado', true)
      .order('desde', { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);

    res.json({ announcements: avisosPara((data ?? []) as unknown as FilaAviso[], { rol, lang }) });
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err), rol, lang }, 'no se pudieron leer los avisos');
    res.json({ announcements: [] });
  }
});
