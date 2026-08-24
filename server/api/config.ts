import { Router, Request, Response } from "express";
import { requireSupabaseAuth } from "../middleware";
import { createContextLogger } from "../lib/logger";
import { pool } from "../db/pool";

const log = createContextLogger('CONFIG');
export const configRouter = Router();

const DEFAULTS = {
  maintenance_mode: false,
  min_version: '1.0.0',
  surge_multiplier: 1.0,
};

// GET /api/config — public: returns maintenance_mode, min_version, surge_multiplier, googleMapsApiKey
configRouter.get("/", async (_req: Request, res: Response) => {
  const stripePublishableKey = process.env.VITE_STRIPE_PUBLISHABLE_KEY || process.env.STRIPE_PUBLISHABLE_KEY || '';
  const googleMapsApiKey = process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
  const googleMapsMapId   = process.env.VITE_GOOGLE_MAPS_MAP_ID  || process.env.GOOGLE_MAPS_MAP_ID  || '';
  try {
    const { rows } = await pool.query<{ key: string; value: string }>(
      'SELECT key, value FROM app_config'
    );
    const cfg: Record<string, string> = {};
    for (const row of rows) cfg[row.key] = row.value;
    res.json({
      maintenance_mode: cfg['maintenance_mode'] === 'true',
      min_version:      cfg['min_version'] ?? DEFAULTS.min_version,
      surge_multiplier: parseFloat(cfg['surge_multiplier'] ?? String(DEFAULTS.surge_multiplier)),
      multiplier:       parseFloat(cfg['surge_multiplier'] ?? String(DEFAULTS.surge_multiplier)),
      surgeReason:      cfg['surge_reason'] ?? null,
      stripePublishableKey,
      googleMapsApiKey,
      googleMapsMapId,
    });
  } catch (err: any) {
    log.warn({ err: err.message }, 'config fetch error — returning defaults');
    res.json({ ...DEFAULTS, stripePublishableKey, googleMapsApiKey, googleMapsMapId });
  }
});

// GET /api/config/surge — public: returns current surge multiplier and reason
configRouter.get("/surge", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM app_config WHERE key IN ('surge_multiplier', 'surge_reason')`
    );
    const cfg: Record<string, string> = {};
    for (const row of rows) cfg[row.key] = row.value;
    res.json({
      surge_multiplier: parseFloat(cfg['surge_multiplier'] ?? '1.0'),
      surge_reason:     cfg['surge_reason'] ?? null,
    });
  } catch {
    res.json({ surge_multiplier: 1.0, surge_reason: null });
  }
});

// PUT /api/config/surge — admin only: set surge multiplier
configRouter.put("/surge", requireSupabaseAuth, async (req: Request, res: Response) => {
  const role = req.supabaseRole || 'passenger';
  if (role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { multiplier } = req.body as { multiplier?: number };
  if (!multiplier || multiplier < 1.0 || multiplier > 5.0) {
    return res.status(400).json({ error: 'multiplier must be between 1.0 and 5.0' });
  }
  try {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      ['surge_multiplier', String(multiplier)]
    );
    log.info({ multiplier }, 'surge multiplier updated');
    res.json({ applied: true, surge_multiplier: multiplier });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update surge multiplier' });
  }
});

// PUT /api/config/maintenance — admin only: toggle maintenance mode
configRouter.put("/maintenance", requireSupabaseAuth, async (req: Request, res: Response) => {
  const role = req.supabaseRole || 'passenger';
  if (role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
  try {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      ['maintenance_mode', String(enabled)]
    );
    log.info({ enabled }, 'maintenance mode updated');
    res.json({ applied: true, maintenance_mode: enabled });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update maintenance mode' });
  }
});

// PUT /api/config/version — admin only: set minimum app version
configRouter.put("/version", requireSupabaseAuth, async (req: Request, res: Response) => {
  const role = req.supabaseRole || 'passenger';
  if (role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { min_version } = req.body as { min_version?: string };
  if (!min_version || !/^\d+\.\d+\.\d+$/.test(min_version)) {
    return res.status(400).json({ error: 'min_version must be in x.y.z format' });
  }
  try {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      ['min_version', min_version]
    );
    res.json({ applied: true, min_version });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update min_version' });
  }
});
