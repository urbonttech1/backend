import { Router, Request, Response } from "express";
import { requireSupabaseAuth } from "../middleware";
import { supabaseAdmin } from "../db/client";
import { pool } from "../db/pool";
import { guardarUbicacion } from "../services/driverLocation";
import { validate, validateQuery, schemas } from "../middleware/validation";
import { createContextLogger } from "../lib/logger";
import {
  getVerificationStatus,
  applyRejectionPenalty,
  applyCompletionBonus,
} from "../services/driverScore";
import { notifyUser } from "../services/fcm";
import { puedeOperar } from "../services/driverVerification";
import { driverNotif } from "../services/notificationTemplates";
import { loadDriverDecisions, recordRideRejection } from "../services/driverRideHistory";
import Stripe from "stripe";
import { resumenDeSaldo, puedeRetirar, enDolares, gananciaDelChofer, type MetodoRetiro } from "../services/driverBalance";
import { estadoConnectAlDia, pagarViajesPendientes } from "../services/payoutRecovery";
import { puedeCobrar } from "../services/connectStatus";
import { tasaDeAceptacion, tasaDeCancelacion, valoracionMedia } from "../services/driverPerformance";

// Streak milestones that deserve a push notification
const STREAK_MILESTONES = new Set([3, 5, 7, 10, 14, 21, 30]);

const log = createContextLogger('DRIVERS');

export const driverRouter = Router();

// GET /api/drivers/available-counts â public endpoint: count online approved drivers per category
// Returns { executive: N, suv: N, concierge: N } â used by the vehicle selection screen
driverRouter.get("/available-counts", async (_req: Request, res: Response) => {
  try {
    const client = await pool.connect();
    let rows: { class: string; cnt: string }[];
    try {
      const result = await client.query<{ class: string; cnt: string }>(`
        SELECT
          LOWER(COALESCE(vehicle->>'class', vehicle->>'category', '')) AS class,
          COUNT(*)::text AS cnt
        FROM profiles
        WHERE status_val = 'online'
          AND role IN ('driver', 'chauffeur')
          AND vehicle IS NOT NULL
        GROUP BY 1
      `);
      rows = result.rows;
    } finally {
      client.release();
    }

    const normalize = (v: string): string => {
      const t = v.toLowerCase().trim();
      if (t.includes('business') || t.includes('executive') || t.includes('first')) return 'executive';
      if (t.includes('suv')) return 'suv';
      if (t.includes('concierge') || t.includes('luxury')) return 'concierge';
      return t;
    };

    const counts: Record<string, number> = { executive: 0, suv: 0, concierge: 0 };
    for (const row of rows) {
      const cat = normalize(row.class);
      if (cat in counts) counts[cat] += parseInt(row.cnt, 10);
    }

    res.json(counts);
  } catch (err: any) {
    log.error({ err: err.message }, 'available-counts error');
    res.json({ executive: 0, suv: 0, concierge: 0 });
  }
});

// POST /api/drivers/location â update driver GPS position
// Uses ST_SetSRID(ST_MakePoint(lng, lat), 4326) â note: longitude FIRST in PostGIS
driverRouter.post(
  "/location",
  requireSupabaseAuth,
  validate(schemas.locationUpdate),
  async (req: Request, res: Response) => {
    const driver_id = req.supabaseUid;
    const role = req.supabaseRole || 'passenger';

    if (role !== 'driver' && role !== 'chauffeur') {
      return res.status(403).json({ error: 'Only drivers can update location' });
    }

    const { lat, lng, heading, speed } = req.body;

    try {
      await guardarUbicacion({ driverId: driver_id, lat, lng, heading, speed });

      res.json({ success: true });
    } catch (err: any) {
      log.error({ err: err.message, driver_id }, 'location update error');
      res.status(500).json({ error: 'Failed to update location' });
    }
  },
);

// PATCH /api/drivers/status â set driver online/offline
driverRouter.patch(
  "/status",
  requireSupabaseAuth,
  validate(schemas.driverStatus),
  async (req: Request, res: Response) => {
    const driver_id = req.supabaseUid;
    const { is_online } = req.body;

    try {
      // El registro no exige vehículo ni documentos, así que el control está
      // aquí: un conductor sin aprobar o sin vehículo no puede conectarse.
      // Desconectarse siempre se permite.
      if (is_online) {
        const permiso = await puedeOperar(String(driver_id));
        if (!permiso.ok) {
          return res.status(403).json({ error: permiso.reason, errorCode: permiso.code });
        }
      }

      // FIX: previously `is_online` was only written to driver_locations when
      // going OFFLINE; going online only touched profiles.status_val, leaving a
      // window where profiles said "online" but driver_locations.is_online was
      // still false until the first GPS ping landed. Passenger-facing driver
      // search queries that filter on driver_locations.is_online could miss a
      // driver who had just gone online. We now sync both directions — using a
      // plain UPDATE (not upsert) since driver_locations requires lat/lng NOT
      // NULL and a driver who has never sent a GPS ping won't have a row yet;
      // in that case there's nothing to mark online and the first /location
      // POST will set is_online = true anyway.
      await supabaseAdmin
        .from('driver_locations')
        .update({ is_online, updated_at: new Date().toISOString() })
        .eq('driver_id', driver_id);

      await supabaseAdmin
        .from('profiles')
        .update({
          status_val: is_online ? 'online' : 'offline',
          updated_at: new Date().toISOString(),
        })
        .eq('id', driver_id);

      res.json({ success: true });
    } catch (err: any) {
      log.error({ err: err.message, driver_id }, 'status update error');
      res.status(500).json({ error: 'Failed to update driver status' });
    }
  },
);

// GET /api/drivers/location/:driverId â specific driver location (passenger tracking)
driverRouter.get(
  "/location/:driverId",
  requireSupabaseAuth,
  async (req: Request, res: Response) => {
    try {
      const { data, error } = await supabaseAdmin
        .from('driver_locations')
        .select('lat, lng, heading, speed, updated_at')
        .eq('driver_id', req.params.driverId)
        .maybeSingle();

      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Driver location not found' });

      res.json(data);
    } catch (err: any) {
      log.error({ err: err.message, driverId: req.params.driverId }, 'get location error');
      res.status(500).json({ error: 'Failed to get driver location' });
    }
  },
);

// GET /api/drivers/nearby?lat=&lng=&radiusKm=
// PostGIS ST_DWithin via find_nearby_drivers() RPC â O(log n) via GIST index
// Graceful fallback to in-memory Haversine if PostGIS not yet available
driverRouter.get(
  "/nearby",
  requireSupabaseAuth,
  validateQuery(schemas.nearbyQuery),
  async (req: Request, res: Response) => {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    const radiusKm = parseFloat(req.query.radiusKm as string) || 10;

    try {
      // ââ PostGIS path (fast, indexed) âââââââââââââââââââââââââââââââââââââââââ
      const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc('find_nearby_drivers', {
        ref_lat: lat,
        ref_lng: lng,
      });

      if (!rpcError && Array.isArray(rpcData)) {
        if (rpcData.length === 0) return res.json([]);

        // Type the RPC result rows so TypeScript can validate property access
        interface NearbyDriverRpc {
          driver_id: string;
          lat: string | number;
          lng: string | number;
          heading?: string | number | null;
          distance_km: number;
          updated_at: string;
        }
        const typedRpc = rpcData as NearbyDriverRpc[];
        const driverIds = typedRpc.map((d) => d.driver_id);
        // Use pool directly â supabaseAdmin REST may not have vehicle in schema cache
        let profiles: Array<Record<string, unknown>> = [];
        if (driverIds.length > 0) {
          const pc = await pool.connect();
          try {
            const pr = await pc.query<Record<string, unknown>>(
              `SELECT id, first_name, last_name, rating, vehicle, avatar_url FROM profiles WHERE id = ANY($1)`,
              [driverIds],
            );
            profiles = pr.rows;
          } finally {
            pc.release();
          }
        }

        const profileMap = new Map(profiles.map((p) => [p.id as string, p]));

        return res.json(
          typedRpc.map((d) => {
            const p = profileMap.get(d.driver_id);
            return {
              driver_id: d.driver_id,
              lat: parseFloat(String(d.lat)),
              lng: parseFloat(String(d.lng)),
              heading: parseFloat(String(d.heading ?? 0)),
              distance_km: Math.round(d.distance_km * 10) / 10,
              updated_at: d.updated_at,
              name: p ? `${p.first_name || ''} ${p.last_name || ''}`.trim() : 'Driver',
              rating: (p?.rating as number) ?? 5.0,
              vehicle: p?.vehicle ?? null,
              avatar_url: p?.avatar_url ?? null,
            };
          }),
        );
      }

      // ââ Fallback: Haversine in Node.js (runs when PostGIS not yet deployed) âââ
      log.warn({ rpcError: rpcError?.message }, 'PostGIS RPC unavailable â falling back to Haversine');

      // Haversine fallback: rows from direct SQL are typed via the query generic
      interface DriverRow {
        driver_id: string;
        lat: string;
        lng: string;
        heading?: string | null;
        distance_km?: number;
        updated_at: string;
        first_name: string;
        last_name: string;
        rating: number;
        vehicle: unknown;
        avatar_url: string;
      }
      let data: DriverRow[] = [];
      try {
        const result = await pool.query(`
          SELECT 
            dl.driver_id, dl.lat, dl.lng,
            dl.heading, dl.updated_at,
            p.first_name, p.last_name, p.rating, p.vehicle, p.avatar_url
          FROM driver_locations dl
          JOIN profiles p ON p.id = dl.driver_id
          WHERE dl.is_online = true
            AND dl.updated_at >= NOW() - INTERVAL '5 minutes'
        `);
        data = result.rows;
      } catch {
        // Columns may not exist yet (migration pending) â fall back to a basic query
        try {
          const result = await pool.query(`
            SELECT 
              dl.driver_id, dl.lat, dl.lng,
              COALESCE(dl.heading, 0) AS heading,
              NOW() AS updated_at,
              p.first_name, p.last_name, p.rating, p.vehicle, p.avatar_url
            FROM driver_locations dl
            JOIN profiles p ON p.id = dl.driver_id
            WHERE dl.is_online = true
              AND dl.updated_at >= NOW() - INTERVAL '5 minutes'
          `);
          data = result.rows;
        } catch (fallbackErr: unknown) {
          log.warn({ err: (fallbackErr as Error)?.message }, 'driver_locations fallback query failed â returning empty');
          return res.json([]);
        }
      }

      const nearby = data
        .filter((d) => haversineKm(lat, lng, parseFloat(d.lat), parseFloat(d.lng)) <= radiusKm)
        .map((d) => {
          const dist = Math.round(haversineKm(lat, lng, parseFloat(d.lat), parseFloat(d.lng)) * 10) / 10;
          return {
            driver_id: d.driver_id,
            lat: parseFloat(d.lat),
            lng: parseFloat(d.lng),
            heading: parseFloat(d.heading ?? '0'),
            distance_km: dist,
            updated_at: d.updated_at,
            name: `${d.first_name || ''} ${d.last_name || ''}`.trim() || 'Driver',
            rating: d.rating ?? 5.0,
            vehicle: d.vehicle ?? null,
            avatar_url: d.avatar_url ?? null,
          };
        })
        .sort((a, b) => (a.distance_km ?? 0) - (b.distance_km ?? 0));

      res.json(nearby);
    } catch (err: any) {
      log.error({ err: err.message, lat, lng, radiusKm }, 'nearby search error');
      res.status(500).json({ error: 'Failed to find nearby drivers' });
    }
  },
);

// POST /api/drivers/apply-sanction â lower rating on late cancel
driverRouter.post('/apply-sanction', requireSupabaseAuth, async (req: Request, res: Response) => {
  const driverId = req.supabaseUid;
  const role = req.supabaseRole || 'passenger';
  if (role !== 'driver' && role !== 'chauffeur') {
    return res.status(403).json({ error: 'Only drivers can receive sanctions' });
  }
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('rating')
      .eq('id', driverId)
      .maybeSingle();
    const current = parseFloat(String((profile as Record<string,unknown>)?.rating ?? '5.0'));
    const updated = Math.max(3.0, parseFloat((current - 0.15).toFixed(2)));
    await supabaseAdmin.from('profiles').update({ rating: updated }).eq('id', driverId);
    log.warn({ driverId, from: current, to: updated }, 'sanction applied â late cancel');
    res.json({ applied: true, newRating: updated });
  } catch (err: any) {
    log.error({ err: err.message }, 'apply-sanction error');
    res.status(500).json({ error: 'Failed to apply sanction' });
  }
});

// ââ GET /api/drivers/verification-status âââââââââââââââââââââââââââââââââââââ
driverRouter.get('/verification-status', requireSupabaseAuth, async (req: Request, res: Response) => {
  const driverId = req.supabaseUid;
  const role = req.supabaseRole || 'passenger';
  if (role !== 'driver' && role !== 'chauffeur') {
    return res.status(403).json({ error: 'Drivers only' });
  }
  try {
    const status = await getVerificationStatus(driverId!);
    res.json(status);
  } catch (err: any) {
    log.error({ err: err.message, driverId }, 'verification-status error');
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ââ POST /api/drivers/reject-ride ââââââââââââââââââââââââââââââââââââââââââââ
driverRouter.post('/reject-ride', requireSupabaseAuth, async (req: Request, res: Response) => {
  const driverId = req.supabaseUid;
  const role = req.supabaseRole || 'passenger';
  if (role !== 'driver' && role !== 'chauffeur') {
    return res.status(403).json({ error: 'Drivers only' });
  }
  try {
    const { rideId } = req.body as { rideId?: string }; // FIX: read rideId for rejection attribution/metrics
    const result = await applyRejectionPenalty(driverId!);
    // Por viaje, para la tasa de aceptación de /stats. Sin rideId no hay a qué
    // asociarlo: la penalización se aplica igual, pero el rechazo no cuenta.
    if (rideId) recordRideRejection(rideId, driverId!);
    log.warn({ driverId, rideId: rideId ?? null, ...result }, 'driver rejected ride');
    res.json(result);
  } catch (err: any) {
    log.error({ err: err.message, driverId }, 'reject-ride error');
    res.status(500).json({ error: 'Failed to apply rejection penalty' });
  }
});

// ââ POST /api/drivers/complete-bonus âââââââââââââââââââââââââââââââââââââââââ
driverRouter.post('/complete-bonus', requireSupabaseAuth, async (req: Request, res: Response) => {
  const driverId = req.supabaseUid;
  const role = req.supabaseRole || 'passenger';
  if (role !== 'driver' && role !== 'chauffeur') {
    return res.status(403).json({ error: 'Drivers only' });
  }
  try {
    const result = await applyCompletionBonus(driverId!);
    res.json(result);
  } catch (err: any) {
    log.error({ err: err.message, driverId }, 'complete-bonus error');
    res.status(500).json({ error: 'Failed to apply completion bonus' });
  }
});


// ââ PATCH /api/drivers/vehicle â update vehicle details in profile ââââââââââââ
driverRouter.patch('/vehicle', requireSupabaseAuth, async (req: Request, res: Response) => {
  const driverId = req.supabaseUid;
  const role = req.supabaseRole || 'passenger';
  if (role !== 'driver' && role !== 'chauffeur') {
    return res.status(403).json({ error: 'Drivers only' });
  }

  const { make, model, year, color, plate, category, vehicle_photo_url } = req.body as {
    make?: string; model?: string; year?: string; color?: string;
    plate?: string; category?: string; vehicle_photo_url?: string;
  };

  try {
    // ââ Step 1: Read current vehicle from any available source ââââââââââââââââ
    let existing: Record<string, unknown> = {};

    // Try Supabase Auth user_metadata (works on Hyperlift â same API used for login)
    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(driverId);
    if (authUser?.user?.user_metadata?.vehicle) {
      existing = authUser.user.user_metadata.vehicle as Record<string, unknown>;
    } else if (authUser?.user?.app_metadata?.vehicle) {
      existing = authUser.user.app_metadata.vehicle as Record<string, unknown>;
    } else {
      // Try pool as secondary source (works locally)
      try {
        const client = await pool.connect();
        try {
          const result = await client.query<{ vehicle: Record<string, unknown> }>(
            `SELECT vehicle FROM profiles WHERE id = $1`, [driverId]
          );
          if (result.rows[0]?.vehicle) existing = result.rows[0].vehicle;
        } finally { client.release(); }
      } catch {}
    }

    const updated = {
      ...existing,
      ...(make !== undefined && { make }),
      ...(model !== undefined && { model }),
      ...(year !== undefined && { year }),
      ...(color !== undefined && { color }),
      ...(plate !== undefined && { plate }),
      ...(category !== undefined && { category }),
      ...(vehicle_photo_url !== undefined && { vehicle_photo_url }),
    };

    // ââ Step 2: Save vehicle â Supabase Auth user_metadata (always works) âââââ
    const { error: authUpdateError } = await supabaseAdmin.auth.admin.updateUserById(driverId, {
      user_metadata: { vehicle: updated },
    });

    if (authUpdateError) {
      log.warn({ err: authUpdateError.message, driverId }, 'auth metadata update failed');
    }

    // ââ Step 3: Also try pool update (bonus â works when DB has vehicle column) â
    try {
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE profiles SET vehicle = $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(updated), driverId]
        );
      } finally { client.release(); }
    } catch (poolErr: unknown) {
      const poolErrMessage = poolErr instanceof Error ? poolErr.message : String(poolErr);
      log.warn({ err: poolErrMessage, driverId }, 'pool vehicle update skipped');
    }

    // If the Supabase Auth update also failed, return error
    if (authUpdateError) {
      return res.status(500).json({ error: 'Failed to update vehicle â auth service unavailable' });
    }

    log.info({ driverId, vehicle: updated }, 'vehicle updated');
    res.json({ success: true, vehicle: updated });
  } catch (err: any) {
    log.error({ err: err.message, driverId }, 'vehicle update error');
    res.status(500).json({ error: 'Failed to update vehicle' });
  }
});

// ââ POST /api/drivers/vehicle-photo â upload vehicle photo ââââââââââââââââââââ
driverRouter.post('/vehicle-photo', requireSupabaseAuth, async (req: Request, res: Response) => {
  const driverId = req.supabaseUid;
  const role = req.supabaseRole || 'passenger';
  if (role !== 'driver' && role !== 'chauffeur') {
    return res.status(403).json({ error: 'Drivers only' });
  }

  const { mimeType, base64 } = req.body as { mimeType?: string; base64?: string };
  if (!mimeType || !base64) {
    return res.status(400).json({ error: 'Missing mimeType or base64' });
  }

  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
  if (!allowed.includes(mimeType.toLowerCase())) {
    return res.status(400).json({ error: 'Invalid file type' });
  }

  try {
    const rawBase64 = base64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(rawBase64, 'base64');
    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large. Max 10 MB.' });
    }

    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const storagePath = `${driverId}/vehicle_${Date.now()}.${ext}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('chauffeur-docs')
      .upload(storagePath, buffer, { contentType: mimeType, upsert: true });

    if (uploadError) {
      log.error({ err: uploadError.message, driverId }, 'vehicle photo upload error');
      return res.status(500).json({ error: 'Upload failed' });
    }

    const { data: urlData } = supabaseAdmin.storage.from('chauffeur-docs').getPublicUrl(storagePath);
    const photoUrl = urlData?.publicUrl || '';

    // Persist URL into vehicle JSONB
    const { data: current } = await supabaseAdmin.from('profiles').select('vehicle').eq('id', driverId).maybeSingle();
    const existing = ((current as Record<string,unknown>)?.vehicle ?? {}) as Record<string, unknown>;
    const updatedVehicle = { ...existing, vehicle_photo_url: photoUrl };

    await supabaseAdmin.from('profiles')
      .update({ vehicle: updatedVehicle, updated_at: new Date().toISOString() })
      .eq('id', driverId);

    log.info({ driverId, photoUrl }, 'vehicle photo uploaded');
    res.json({ success: true, photoUrl });
  } catch (err: any) {
    log.error({ err: err.message, driverId }, 'vehicle photo upload error');
    res.status(500).json({ error: 'Failed to upload vehicle photo' });
  }
});

// ââ GET /api/drivers/profile â get full driver profile âââââââââââââââââââââââ
driverRouter.get('/profile', requireSupabaseAuth, async (req: Request, res: Response) => {
  const driverId = req.supabaseUid;
  const role = req.supabaseRole || 'passenger';
  if (role !== 'driver' && role !== 'chauffeur') {
    return res.status(403).json({ error: 'Drivers only' });
  }

  try {
    // Use pool directly â supabaseAdmin REST API may not have vehicle in schema cache
    const client = await pool.connect();
    let data: Record<string, unknown> | null = null;
    try {
      const result = await client.query<Record<string, unknown>>(
        `SELECT id, first_name, last_name, email, phone, avatar_url, vehicle, rating, membership,
         to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
         drivers_license, license_expiry, ssn_last4, home_address
         FROM profiles WHERE id = $1`,
        [driverId],
      );
      data = result.rows[0] ?? null;
    } finally {
      client.release();
    }

    // Fallback: get vehicle from Supabase auth metadata if column not populated
    let vehicle = (data as Record<string,unknown>)?.vehicle ?? null;
    if (!vehicle) {
      const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(driverId!);
      vehicle = authUser?.user?.user_metadata?.vehicle
        || authUser?.user?.app_metadata?.vehicle
        || null;
    }

    res.json({ ...(data ?? {}), vehicle });
  } catch (poolErr: any) {
    // Pool unavailable (SUPABASE_DB_URL not set or connection refused) — fall back to
    // supabaseAdmin REST API so phone/date_of_birth/etc. are still returned.
    log.warn({ err: poolErr.message, driverId }, 'pool unavailable — falling back to supabaseAdmin for driver profile');
    try {
      const { data: sbData, error: sbErr } = await supabaseAdmin
        .from('profiles')
        .select('id, first_name, last_name, email, phone, avatar_url, vehicle, rating, membership, date_of_birth, drivers_license, license_expiry, ssn_last4, home_address')
        .eq('id', driverId!)
        .maybeSingle();
      if (sbErr || !sbData) {
        log.error({ err: sbErr?.message, driverId }, 'supabaseAdmin fallback also failed');
        return res.status(500).json({ error: 'Failed to fetch profile' });
      }
      let vehicle = (sbData as Record<string, unknown>)?.vehicle ?? null;
      if (!vehicle) {
        const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(driverId!);
        vehicle = authUser?.user?.user_metadata?.vehicle
          || authUser?.user?.app_metadata?.vehicle
          || null;
      }
      return res.json({ ...sbData, vehicle });
    } catch (fallbackErr: any) {
      log.error({ err: fallbackErr.message, driverId }, 'get profile error (pool + supabaseAdmin both failed)');
      return res.status(500).json({ error: 'Failed to fetch profile' });
    }
  }
});

// ââ GET /api/drivers/stats â rating, trips, acceptance rate ââââââââââââââââââ
driverRouter.get('/stats', requireSupabaseAuth, async (req: Request, res: Response) => {
  const driverId = req.supabaseUid;
  const role = req.supabaseRole || 'passenger';
  if (role !== 'driver' && role !== 'chauffeur') return res.status(403).json({ error: 'Drivers only' });
  try {
    const [ridesRes, eventos] = await Promise.all([
      supabaseAdmin.from('rides')
        .select('id, ride_status, created_at, fare, driver_earnings, rating')
        .eq('driver_id', driverId)
        .order('created_at', { ascending: false })
        .limit(500),
      // Cancelaciones, reasignaciones y rechazos, que viven en driver_ride_events.
      // Un viaje que soltó ya no está a su nombre en `rides`, y uno que rechazó
      // nunca lo estuvo: sin esto las dos tasas saldrían mal.
      loadDriverDecisions(driverId!),
    ]);
    const rides = (ridesRes.data ?? []) as Array<{
      id: string; ride_status: string; created_at: string;
      fare: number | null; driver_earnings: number | null; rating: number | null;
    }>;

    const completed = rides.filter(r => r.ride_status === 'completed');

    const nowMs = Date.now();
    const weekAgo = nowMs - 7 * 24 * 3600 * 1000;
    const weekCompleted = completed.filter(r => new Date(r.created_at).getTime() >= weekAgo);
    // Lo que gana el chofer, no la tarifa del pasajero. Ver `gananciaDelChofer`.
    const weeklyEarnings = weekCompleted.reduce((s, r) => s + gananciaDelChofer(r), 0);

    const chart = Array(7).fill(0) as number[];
    for (const r of completed) {
      const daysAgo = Math.floor((nowMs - new Date(r.created_at).getTime()) / 86400000);
      if (daysAgo < 7) chart[6 - daysAgo] += gananciaDelChofer(r);
    }

    res.json({
      // Media real de lo que valoraron los pasajeros en estos viajes, o null si
      // aún no hay ninguna. Antes devolvía `profiles.rating`, que arranca en 5,0
      // sin ninguna valoración detrás. Lo que ven los pasajeros no cambia.
      rating: valoracionMedia(rides),
      completedRides: completed.length,
      completedThisWeek: weekCompleted.length,
      // Aceptadas ÷ (aceptadas + rechazadas). Las ofertas que tomó otro
      // conductor antes de que éste respondiera no cuentan.
      acceptanceRate: tasaDeAceptacion(rides, eventos),
      // Nombre acordado con el equipo móvil: no cambiarlo. Entero 0–100, o null
      // si el conductor aún no aceptó ningún viaje.
      cancellationRate: tasaDeCancelacion(rides, eventos),
      weeklyEarnings: parseFloat(weeklyEarnings.toFixed(2)),
      weeklyChart: chart.map(v => parseFloat(v.toFixed(2))),
    });
  } catch (err: any) {
    log.error({ err: err.message, driverId }, 'stats fetch error');
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ââ GET /api/drivers/earnings â real per-period earnings from DB ââââââââââââââ
// ── El dinero del chofer ────────────────────────────────────────────────────
//
// El botón «Cash Out» de la app abría el dashboard de Stripe y no retiraba
// nada, y la cifra que enseñaba encima salía de sumar `rides.fare` —la tarifa
// completa del pasajero, no lo que le toca al chofer— así que prometía un
// dinero que no existía. Estas dos rutas son el reemplazo: una dice la verdad
// y la otra mueve el dinero de verdad.

function stripeDeRetiros(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? new Stripe(key) : null;
}

/** Lo que el chofer tiene en Stripe. Cero si aún no tiene cuenta. */
async function saldoEnStripe(stripe: Stripe, accountId: string | null) {
  if (!accountId) return { disponibleCents: 0, enCaminoCents: 0, instantaneoCents: 0 };
  try {
    const b = await stripe.balance.retrieve({ stripeAccount: accountId });
    const usd = (arr?: Array<{ amount: number; currency: string }>) =>
      (arr ?? []).filter(x => x.currency === 'usd').reduce((s, x) => s + x.amount, 0);
    return {
      disponibleCents: usd(b.available),
      enCaminoCents: usd(b.pending),
      instantaneoCents: usd((b as unknown as { instant_available?: Array<{ amount: number; currency: string }> }).instant_available),
    };
  } catch (err: unknown) {
    log.warn({ err: err instanceof Error ? err.message : String(err), accountId }, 'saldo de Stripe');
    return { disponibleCents: 0, enCaminoCents: 0, instantaneoCents: 0 };
  }
}

/** Los `driver_earnings` que aún no se le han transferido. */
async function pendienteDeCobro(driverId: string): Promise<Array<number | null>> {
  const { data } = await supabaseAdmin
    .from('rides')
    .select('driver_earnings')
    .eq('driver_id', driverId)
    .eq('ride_status', 'completed')
    .is('stripe_transfer_id', null)
    .gt('driver_earnings', 0);
  return ((data ?? []) as Array<{ driver_earnings: number | null }>).map(r => r.driver_earnings);
}

// GET /api/drivers/balance — dónde está su dinero y cuánto puede sacar.
driverRouter.get('/balance', requireSupabaseAuth, async (req: Request, res: Response) => {
  const driverId = req.supabaseUid!;
  const stripe = stripeDeRetiros();
  try {
    const { data: perfil } = await supabaseAdmin
      .from('profiles')
      .select('stripe_account_id, stripe_connect_status')
      .eq('id', driverId)
      .maybeSingle();

    const accountId = (perfil?.stripe_account_id ?? null) as string | null;
    const [pendientes, saldo] = await Promise.all([
      pendienteDeCobro(driverId),
      stripe ? saldoEnStripe(stripe, accountId) : Promise.resolve({ disponibleCents: 0, enCaminoCents: 0, instantaneoCents: 0 }),
    ]);

    const resumen = resumenDeSaldo({ pendientesUSD: pendientes, saldoStripe: saldo });
    const estandar = puedeRetirar(resumen, 'standard');
    const instantaneo = puedeRetirar(resumen, 'instant');

    return res.json({
      // Lo que el chofer llama «mi plata», separado por dónde está.
      porCobrarDeUrbont: enDolares(resumen.enUrbontCents),
      enCamino: enDolares(resumen.enCaminoCents),
      disponible: enDolares(resumen.disponibleCents),
      total: enDolares(resumen.totalCents),
      // Qué puede hacer ahora mismo.
      retiro: {
        estandar: { puede: estandar.puede, monto: enDolares(estandar.montoCents), motivo: estandar.motivo },
        instantaneo: { puede: instantaneo.puede, monto: enDolares(instantaneo.montoCents), motivo: instantaneo.motivo },
      },
      cuentaConectada: !!accountId,
      // Los payouts ya son automáticos: esto explica por qué puede no hacer falta retirar.
      payoutAutomatico: true,
    });
  } catch (err: unknown) {
    log.error({ err: err instanceof Error ? err.message : String(err), driverId }, 'balance del chofer');
    return res.status(500).json({ error: 'No se pudo consultar tu saldo.' });
  }
});

// POST /api/drivers/cashout — retira a su banco.
//
// Primero empuja lo que Urbont le debe a su cuenta de Stripe y sólo después
// crea el payout, porque si no el chofer vería «no tienes saldo» teniendo
// viajes cobrados: es exactamente lo que pasaba antes.
driverRouter.post('/cashout', requireSupabaseAuth, async (req: Request, res: Response) => {
  const driverId = req.supabaseUid!;
  const metodo: MetodoRetiro = req.body?.method === 'instant' ? 'instant' : 'standard';
  const stripe = stripeDeRetiros();
  if (!stripe) return res.status(500).json({ error: 'Los pagos no están configurados.' });

  try {
    const { data: perfil } = await supabaseAdmin
      .from('profiles')
      .select('stripe_account_id, stripe_connect_status')
      .eq('id', driverId)
      .maybeSingle();

    const accountId = (perfil?.stripe_account_id ?? null) as string | null;
    const estado = await estadoConnectAlDia({
      stripe, driverId, accountId, estadoGuardado: perfil?.stripe_connect_status as string | null,
    });
    if (!accountId || !puedeCobrar(estado)) {
      return res.status(400).json({
        error: 'Termina el registro de pagos en Stripe para poder retirar.',
        necesitaAlta: true,
      });
    }

    // 1) Lo que Urbont le debe, a su cuenta.
    const empuje = await pagarViajesPendientes({ stripe, driverId });

    // 2) Lo que haya quedado disponible, a su banco.
    const saldo = await saldoEnStripe(stripe, accountId);
    const resumen = resumenDeSaldo({ pendientesUSD: await pendienteDeCobro(driverId), saldoStripe: saldo });
    const permiso = puedeRetirar(resumen, metodo);

    if (!permiso.puede) {
      return res.status(409).json({
        error: permiso.motivo,
        transferido: enDolares(empuje.centavosPagados),
        porCobrarDeUrbont: enDolares(resumen.enUrbontCents),
        enCamino: enDolares(resumen.enCaminoCents),
      });
    }

    const payout = await stripe.payouts.create({
      amount: permiso.montoCents,
      currency: 'usd',
      ...(metodo === 'instant' ? { method: 'instant' as const } : {}),
      description: 'Retiro solicitado desde la app de Urbont',
      metadata: { driver_id: driverId, origen: 'app_cashout' },
    }, { stripeAccount: accountId });

    log.info({ driverId, payout: payout.id, monto: permiso.montoCents, metodo }, 'retiro del chofer');

    return res.json({
      success: true,
      payoutId: payout.id,
      monto: enDolares(permiso.montoCents),
      metodo,
      // Cuándo lo verá en el banco, que es lo único que le importa.
      llegaEn: metodo === 'instant' ? 'unos minutos' : '1 a 3 días hábiles',
      transferidoDesdeUrbont: enDolares(empuje.centavosPagados),
    });
  } catch (err: unknown) {
    const codigo = (err as { code?: string })?.code;
    log.error({ err: err instanceof Error ? err.message : String(err), codigo, driverId }, 'retiro del chofer');
    if (codigo === 'balance_insufficient') {
      return res.status(409).json({ error: 'Tu saldo aún no está disponible. Intenta más tarde.' });
    }
    return res.status(500).json({ error: 'No se pudo completar el retiro.' });
  }
});

// ── GET /api/drivers/earnings — lo que ha ganado, por periodo ──────────────
driverRouter.get('/earnings', requireSupabaseAuth, async (req: Request, res: Response) => {
  const driverId = req.supabaseUid;
  try {
    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay()); weekStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const { data: rides } = await supabaseAdmin
      .from('rides')
      .select('fare, driver_earnings, created_at')
      .eq('driver_id', driverId)
      .eq('ride_status', 'completed')
      .gte('created_at', monthStart.toISOString())
      .order('created_at', { ascending: false });

    const list = (rides ?? []) as Array<{
      fare: number | null; driver_earnings: number | null; created_at: string;
    }>;

    let today = 0, todayTrips = 0;
    let week = 0, weekTrips = 0;
    let month = 0, monthTrips = 0;

    // 7-day chart: index 0 = 6 days ago, index 6 = today
    const chart = Array(7).fill(0);

    for (const r of list) {
      // Lo que gana el chofer, no lo que factura Urbont. Ver `gananciaDelChofer`:
      // esta pantalla sumaba `fare`, el precio del pasajero, y el chofer creía
      // que ese dinero era suyo.
      const ganado = gananciaDelChofer(r);
      const d = new Date(r.created_at);
      month += ganado; monthTrips++;
      if (d >= weekStart) { week += ganado; weekTrips++; }
      if (d >= todayStart) { today += ganado; todayTrips++; }

      const daysAgo = Math.floor((now.getTime() - d.getTime()) / 86400000);
      if (daysAgo < 7) chart[6 - daysAgo] += ganado;
    }

    res.json({
      today: parseFloat(today.toFixed(2)),
      todayTrips,
      week: parseFloat(week.toFixed(2)),
      weekTrips,
      month: parseFloat(month.toFixed(2)),
      monthTrips,
      weeklyChart: chart.map(v => parseFloat(v.toFixed(2))),
    });
  } catch (err: any) {
    log.error({ err: err.message, driverId }, 'earnings fetch error');
    res.status(500).json({ error: 'Failed to fetch earnings' });
  }
});

// ââ GET /api/drivers/quests â weekly quest progress + streak âââââââââââââââââ
// Quests are computed live from completed rides this week; streak is persisted.
driverRouter.get('/quests', requireSupabaseAuth, async (req: Request, res: Response) => {
  const driverId = req.supabaseUid;
  try {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay()); // Sunday
    weekStart.setHours(0, 0, 0, 0);

    // 1) Live progress from completed rides this week
    const { data: rides } = await supabaseAdmin
      .from('rides')
      .select('fare, driver_earnings, created_at')
      .eq('driver_id', driverId)
      .eq('ride_status', 'completed')
      .gte('created_at', weekStart.toISOString());

    const list = (rides ?? []) as Array<{ fare: number | null; driver_earnings: number | null }>;
    const tripsThisWeek = list.length;
    // La meta se mide sobre lo que gana, que es lo que la pantalla enseña ahora.
    const earningsThisWeek = list.reduce((s, r) => s + gananciaDelChofer(r), 0);

    // 2) Streak from driver_streaks
    const { rows } = await pool.query(
      'SELECT current_streak, longest_streak, last_active_date FROM driver_streaks WHERE driver_id = $1',
      [driverId],
    );
    const streak = rows[0] ?? { current_streak: 0, longest_streak: 0, last_active_date: null };

    // 3) Quest definitions (weekly, server-driven so we can tune without a release)
    const quests = [
      {
        key: 'rides_25',
        title: 'Complete 25 rides this week',
        reward: '$50 bonus',
        target: 25,
        progress: Math.min(tripsThisWeek, 25),
        completed: tripsThisWeek >= 25,
        emoji: 'ð',
      },
      {
        key: 'earn_500',
        title: 'Earn $500 this week',
        reward: '$25 bonus',
        target: 500,
        progress: Math.min(Math.floor(earningsThisWeek), 500),
        completed: earningsThisWeek >= 500,
        emoji: 'ð°',
      },
      {
        key: 'streak_5',
        title: 'Drive 5 days in a row',
        reward: 'Premium status',
        target: 5,
        progress: Math.min(Number(streak.current_streak), 5),
        completed: Number(streak.current_streak) >= 5,
        emoji: 'ð¥',
      },
    ];

    res.json({
      weekStart: weekStart.toISOString(),
      tripsThisWeek,
      earningsThisWeek: parseFloat(earningsThisWeek.toFixed(2)),
      streak: {
        current: Number(streak.current_streak),
        longest: Number(streak.longest_streak),
        lastActiveDate: streak.last_active_date,
      },
      quests,
    });
  } catch (err: any) {
    log.error({ err: err.message, driverId }, 'quests fetch error');
    res.status(500).json({ error: 'Failed to fetch quests' });
  }
});

// ââ POST /api/drivers/streak/ping â call when driver goes online âââââââââââââ
// Updates current_streak: +1 if yesterday, reset to 1 if gap, no-op if same day.
driverRouter.post('/streak/ping', requireSupabaseAuth, async (req: Request, res: Response) => {
  const driverId = req.supabaseUid;
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().slice(0, 10);

    const { rows } = await pool.query(
      'SELECT current_streak, longest_streak, last_active_date FROM driver_streaks WHERE driver_id = $1',
      [driverId],
    );

    let current = 1;
    let longest = 1;

    if (rows[0]) {
      const last = rows[0].last_active_date ? new Date(rows[0].last_active_date) : null;
      if (last) {
        const lastStr = last.toISOString().slice(0, 10);
        const diffDays = Math.floor((today.getTime() - last.getTime()) / 86400000);
        if (lastStr === todayStr) {
          // Same day â no change
          current = Number(rows[0].current_streak);
          longest = Number(rows[0].longest_streak);
        } else if (diffDays === 1) {
          current = Number(rows[0].current_streak) + 1;
          longest = Math.max(Number(rows[0].longest_streak), current);
        } else {
          // Gap > 1 day â reset
          current = 1;
          longest = Math.max(Number(rows[0].longest_streak), 1);
        }
      }
    }

    const previousStreak = rows[0] ? Number(rows[0].current_streak) : 0;

    await pool.query(
      `INSERT INTO driver_streaks (driver_id, current_streak, longest_streak, last_active_date, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (driver_id) DO UPDATE SET
         current_streak   = EXCLUDED.current_streak,
         longest_streak   = EXCLUDED.longest_streak,
         last_active_date = EXCLUDED.last_active_date,
         updated_at       = NOW()`,
      [driverId, current, longest, todayStr],
    );

    // Fire milestone push when the driver hits a streak milestone for the first time today
    if (current !== previousStreak && STREAK_MILESTONES.has(current) && driverId) {
      notifyUser(driverId, driverNotif.streakMilestone(current)).catch(() => {});
    }

    res.json({ current, longest, lastActiveDate: todayStr });
  } catch (err: any) {
    log.error({ err: err.message, driverId }, 'streak ping error');
    res.status(500).json({ error: 'Failed to update streak' });
  }
});

// ââ GET /api/drivers/eta/:driverId â ETA from driver to passenger âââââââââââââ
driverRouter.get('/eta/:driverId', requireSupabaseAuth, async (req: Request, res: Response) => {
  const { driverId } = req.params;
  const { toLat, toLng } = req.query as { toLat?: string; toLng?: string };

  if (!toLat || !toLng) return res.status(400).json({ error: 'toLat and toLng required' });

  const { data: driver } = await supabaseAdmin
    .from('driver_locations')
    .select('lat, lng, updated_at')
    .eq('driver_id', driverId)
    .maybeSingle();

  if (!driver) {
    // No location on record at all
    return res.json({ etaMinutes: null, stale: true, driverLat: null, driverLng: null });
  }

  // ââ Staleness check â reject location older than 5 minutes âââââââââââââââââ
  const STALE_THRESHOLD_MS = 5 * 60 * 1000;
  const locationAge = driver.updated_at ? Date.now() - new Date(driver.updated_at as string).getTime() : Infinity;
  if (locationAge > STALE_THRESHOLD_MS) {
    return res.json({ etaMinutes: null, stale: true, driverLat: null, driverLng: null, staleAgeMinutes: Math.round(locationAge / 60000) });
  }

  const distKm = haversineKm(driver.lat, driver.lng, parseFloat(toLat), parseFloat(toLng));
  const avgSpeedKmh = 30; // Miami urban average
  const etaMinutes = Math.max(1, Math.round((distKm / avgSpeedKmh) * 60));

  // Try Google Directions for more accurate ETA
  const googleKey = process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
  if (googleKey && distKm < 50) {
    try {
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${driver.lat},${driver.lng}&destination=${toLat},${toLng}&mode=driving&departure_time=now&key=${googleKey}`;
      const r = await fetch(url);
      const json = await r.json() as {
        routes?: Array<{ legs?: Array<{
          duration_in_traffic?: { value?: number };
          duration?: { value?: number };
          distance?: { value?: number };
        }> }>
      };
      const leg = json.routes?.[0]?.legs?.[0];
      if (leg) {
        const durationSec = leg.duration_in_traffic?.value ?? leg.duration?.value ?? 0;
        const distMeters = leg.distance?.value ?? 0;
        if (durationSec > 0) {
          const liveEta = Math.max(1, Math.round(durationSec / 60));
          return res.json({
            etaMinutes: liveEta,
            distanceKm: +(distMeters / 1000).toFixed(2),
            driverLat: driver.lat,
            driverLng: driver.lng,
            source: 'google_directions',
          });
        }
      }
    } catch { /* fall through to estimate */ }
  }

  res.json({
    etaMinutes,
    distanceKm: +distKm.toFixed(2),
    driverLat: driver.lat,
    driverLng: driver.lng,
    source: 'estimate',
  });
});

// ââ GET /api/drivers/heatmap â pickup density grid for driver dashboard ââââââââ
driverRouter.get('/heatmap', requireSupabaseAuth, async (_req: Request, res: Response) => {
  // Get completed rides from the last 7 days grouped by pickup location
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: rides } = await supabaseAdmin
    .from('rides')
    .select('pickup_lat, pickup_lng, created_at')
    .gte('created_at', since)
    .eq('ride_status', 'completed')
    .not('pickup_lat', 'is', null)
    .not('pickup_lng', 'is', null)
    .limit(500);

  if (!rides || rides.length === 0) {
    // No real ride history yet â return empty (UI hides the heatmap layer)
    return res.json({ points: [], source: 'empty' });
  }

  // Build weighted heatmap by clustering nearby points (~500m radius)
  const grid: { lat: number; lng: number; weight: number }[] = [];
  for (const ride of rides) {
    const lat = parseFloat(ride.pickup_lat);
    const lng = parseFloat(ride.pickup_lng);
    if (isNaN(lat) || isNaN(lng)) continue;

    const existing = grid.find(p => haversineKm(p.lat, p.lng, lat, lng) < 0.5);
    if (existing) {
      existing.weight++;
    } else {
      grid.push({ lat, lng, weight: 1 });
    }
  }

  // Normalize weights
  const maxWeight = Math.max(...grid.map(p => p.weight), 1);
  const normalized = grid.map(p => ({ ...p, weight: +(p.weight / maxWeight * 10).toFixed(1) }));

  res.json({ points: normalized, source: 'live', total: rides.length });
});

// ââ GET /api/drivers/preferred â get passenger's preferred drivers ââââââââââââââ
driverRouter.get('/preferred', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { data, error } = await supabaseAdmin
    .from('preferred_drivers')
    .select(`
      id, driver_id, created_at,
      driver:profiles!preferred_drivers_driver_id_fkey(id, first_name, last_name, avatar_url, rating, total_rides)
    `)
    .eq('passenger_id', uid)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Failed to fetch preferred drivers' });
  res.json({ drivers: (data || []).map((d: Record<string,unknown>) => ({ ...(d.driver as Record<string,unknown>), preferredId: d.id, addedAt: d.created_at })) });
});

// ââ POST /api/drivers/preferred/:driverId â add a preferred driver ââââââââââââ
driverRouter.post('/preferred/:driverId', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { driverId } = req.params;

  const { error } = await supabaseAdmin
    .from('preferred_drivers')
    .insert({ passenger_id: uid, driver_id: driverId });

  if (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Already in preferred drivers' });
    return res.status(500).json({ error: 'Failed to add preferred driver' });
  }
  res.json({ success: true });
});

// ââ DELETE /api/drivers/preferred/:driverId â remove a preferred driver ââââââââ
driverRouter.delete('/preferred/:driverId', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  await supabaseAdmin
    .from('preferred_drivers')
    .delete()
    .eq('passenger_id', uid)
    .eq('driver_id', req.params.driverId);
  res.json({ success: true });
});

// ââ POST /api/drivers/selfie-verify â record Persona KYC selfie verification â
driverRouter.post('/selfie-verify', requireSupabaseAuth, async (req: Request, res: Response) => {
  const driverId = req.supabaseUid!;
  const role = req.supabaseRole || 'passenger';
  if (role !== 'driver' && role !== 'chauffeur') {
    return res.status(403).json({ error: 'Drivers only' });
  }

  const { trigger, inquiryId, status } = req.body as { trigger?: string; inquiryId?: string; status?: string };

  try {
    const now = new Date().toISOString();

    await supabaseAdmin
      .from('profiles')
      .update({
        last_selfie_at: now,
        trips_since_selfie: 0,
        selfie_due_at: null,
        updated_at: now,
      })
      .eq('id', driverId);

    await supabaseAdmin.from('driver_selfie_log').insert({
      driver_id: driverId,
      captured_at: now,
      verified: status === 'completed' || status === 'approved',
      trigger_reason: trigger ?? 'login',
      ...(inquiryId ? { inquiry_id: inquiryId } : {}),
    });

    log.info({ driverId, trigger, inquiryId, status }, 'selfie-verify recorded');
    res.json({ success: true });
  } catch (err: any) {
    log.error({ err: err.message, driverId }, 'selfie-verify error');
    res.status(500).json({ error: 'Failed to record selfie verification' });
  }
});

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
