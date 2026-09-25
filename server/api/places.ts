import { Router, Request, Response } from 'express';
import { requireSupabaseAuth } from '../middleware';
import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';
import { claveDeServidor } from '../services/mapsKeys';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export const placesRouter = Router();

const GOOGLE_KEY = claveDeServidor(process.env);

// GET /api/places/nearby?lat=&lng=&type=&radius=
// Proxy to Google Places Nearby Search — used by driver "Quick Stops" panel.
// type: gas_station | restaurant | cafe | atm | parking | car_wash | convenience_store | restroom (mapped to convenience_store)
placesRouter.get('/nearby', async (req: Request, res: Response) => {
  const { lat, lng, type, radius } = req.query as Record<string, string>;
  if (!lat || !lng || !type) { res.status(400).json({ results: [] }); return; }
  if (!GOOGLE_KEY) { res.json({ results: [] }); return; }

  // Map "restroom" → convenience_store (Google has no native restroom type)
  const placeType = type === 'restroom' ? 'convenience_store' : type;
  const r = Math.min(Number(radius) || 3000, 8000);

  const url = [
    'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
    `?location=${lat},${lng}`,
    `&radius=${r}`,
    `&type=${encodeURIComponent(placeType)}`,
    `&key=${GOOGLE_KEY}`,
  ].join('');

  try {
    const r = await fetch(url);
    if (!r.ok) { res.json({ results: [] }); return; }
    type GooglePlace = {
      place_id?: string;
      name?: string;
      vicinity?: string;
      geometry?: { location?: { lat?: number; lng?: number } };
      rating?: number;
      opening_hours?: { open_now?: boolean };
      price_level?: number;
    };
    const data = await r.json() as { results?: GooglePlace[] };
    if (!data.results) { res.json({ results: [] }); return; }

    const results = data.results.slice(0, 15).map((p) => ({
      place_id: p.place_id,
      name: p.name,
      address: p.vicinity || '',
      lat: p.geometry?.location?.lat,
      lng: p.geometry?.location?.lng,
      rating: typeof p.rating === 'number' ? p.rating : null,
      open_now: p.opening_hours?.open_now ?? null,
      price_level: typeof p.price_level === 'number' ? p.price_level : null,
    })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

    res.json({ results });
  } catch (err) {
    logger.error(`[PLACES/nearby] Error: ${err}`);
    res.json({ results: [] });
  }
});

// GET /api/places — list saved places for current user
placesRouter.get('/', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { data, error } = await supabaseAdmin
    .from('saved_places')
    .select('*')
    .eq('user_id', uid)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: 'Failed to fetch saved places' });
  res.json({ places: data || [] });
});

// POST /api/places — save a new place
placesRouter.post('/', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { label, address, lat, lng, icon } = req.body as {
    label?: string; address?: string; lat?: number; lng?: number; icon?: string;
  };
  if (!label || !address) return res.status(400).json({ error: 'label and address are required' });

  // Limit to 10 saved places per user
  const { count } = await supabaseAdmin
    .from('saved_places')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', uid);
  if ((count || 0) >= 10) return res.status(400).json({ error: 'Maximum 10 saved places allowed' });

  const { data, error } = await supabaseAdmin
    .from('saved_places')
    .insert({ user_id: uid, label, address, lat: lat || null, lng: lng || null, icon: icon || 'star' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'Failed to save place' });
  res.json({ place: data });
});

// PUT /api/places/:id — update label/icon
placesRouter.put('/:id', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { label, icon } = req.body as { label?: string; icon?: string };
  const { data, error } = await supabaseAdmin
    .from('saved_places')
    .update({ label, icon, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', uid)
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'Failed to update place' });
  res.json({ place: data });
});

// DELETE /api/places/:id — remove a saved place
placesRouter.delete('/:id', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { error } = await supabaseAdmin
    .from('saved_places')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', uid);
  if (error) return res.status(500).json({ error: 'Failed to delete place' });
  res.json({ success: true });
});
