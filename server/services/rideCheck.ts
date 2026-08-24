/**
 * URBONT RideCheck — Real-time GPS anomaly detection
 *
 * Compares the driver's current position against the estimated route.
 * Triggers `anomaly_detected` Socket.IO event when:
 *   • Spatial deviation  > 2 km from the pickup→dropoff corridor
 *   • Time deviation     > 15 min beyond the remaining estimated duration
 */

import { supabaseAdmin } from '../db/client';
import { getIO } from './socketService';

const SPATIAL_THRESHOLD_KM = 2;
const TIME_THRESHOLD_SECONDS = 15 * 60;

// ── Haversine distance (km) between two lat/lng points ───────────────────────
function haversineKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Minimum distance (km) from a point P to a line segment A→B.
 * Uses vector projection clamped to [0,1].
 */
function pointToSegmentKm(
  pLat: number, pLng: number,
  aLat: number, aLng: number,
  bLat: number, bLng: number,
): number {
  const dx = bLng - aLng;
  const dy = bLat - aLat;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) return haversineKm(pLat, pLng, aLat, aLng);

  const t = Math.max(0, Math.min(1, ((pLng - aLng) * dx + (pLat - aLat) * dy) / lenSq));
  const closestLat = aLat + t * dy;
  const closestLng = aLng + t * dx;
  return haversineKm(pLat, pLng, closestLat, closestLng);
}

export interface RideCheckInput {
  rideId: string;
  driverLat: number;
  driverLng: number;
}

export interface RideCheckResult {
  anomalyDetected: boolean;
  reasons: string[];
  spatialDeviationKm: number | null;
  timeDeviationSeconds: number | null;
  remainingEstimateSeconds: number | null;
}

/**
 * checkRideDeviation
 *
 * 1. Loads the ride's pickup/dropoff coordinates and original duration from DB.
 * 2. Calls Google Directions: driver's current position → dropoff (live re-estimate).
 * 3. Computes spatial deviation using point-to-segment from driver to pickup→dropoff corridor.
 * 4. Computes time deviation vs remaining expected duration.
 * 5. If any threshold is exceeded, emits `anomaly_detected` via Socket.IO.
 *
 * Call this from a periodic client ping or from the driver:location socket handler.
 */
export async function checkRideDeviation(input: RideCheckInput): Promise<RideCheckResult> {
  const { rideId, driverLat, driverLng } = input;

  const { data: ride, error } = await supabaseAdmin
    .from('rides')
    .select('pickup, dropoff, duration_minutes, started_at, ride_status')
    .eq('id', rideId)
    .maybeSingle();

  if (error || !ride) {
    throw new Error(`Ride ${rideId} not found`);
  }

  const r = ride as Record<string, any>;

  if (r.ride_status !== 'in_progress') {
    return { anomalyDetected: false, reasons: [], spatialDeviationKm: null, timeDeviationSeconds: null, remainingEstimateSeconds: null };
  }

  const pickupLat: number  = r.pickup?.lat;
  const pickupLng: number  = r.pickup?.lng;
  const dropoffLat: number = r.dropoff?.lat;
  const dropoffLng: number = r.dropoff?.lng;

  if (!pickupLat || !pickupLng || !dropoffLat || !dropoffLng) {
    return { anomalyDetected: false, reasons: ['missing_coordinates'], spatialDeviationKm: null, timeDeviationSeconds: null, remainingEstimateSeconds: null };
  }

  const reasons: string[] = [];

  // ── Spatial check: distance from driver to pickup→dropoff corridor ────────
  const spatialDeviationKm = pointToSegmentKm(
    driverLat, driverLng,
    pickupLat, pickupLng,
    dropoffLat, dropoffLng,
  );

  if (spatialDeviationKm > SPATIAL_THRESHOLD_KM) {
    reasons.push(`route_deviation:${spatialDeviationKm.toFixed(2)}km`);
  }

  // ── Time check: live Google Directions re-estimate vs remaining expected duration ─────
  let timeDeviationSeconds: number | null = null;
  let remainingEstimateSeconds: number | null = null;

  const GOOGLE_KEY = process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
  if (GOOGLE_KEY && r.duration_minutes) {
    try {
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${driverLat},${driverLng}&destination=${dropoffLat},${dropoffLng}&mode=driving&departure_time=now&key=${GOOGLE_KEY}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json() as { routes?: Array<{ legs?: Array<{ duration_in_traffic?: { value: number }; duration?: { value: number } }> }> };
        const leg = data.routes?.[0]?.legs?.[0];
        const liveDuration = leg?.duration_in_traffic?.value ?? leg?.duration?.value ?? null;

        if (liveDuration !== null) {
          const originalDurationSec = r.duration_minutes * 60;
          const startedAt = r.started_at ? new Date(r.started_at).getTime() : Date.now();
          const elapsedSec = (Date.now() - startedAt) / 1000;
          const expectedRemainingSeconds = Math.max(0, originalDurationSec - elapsedSec);

          remainingEstimateSeconds = liveDuration;
          timeDeviationSeconds = liveDuration - expectedRemainingSeconds;

          if (timeDeviationSeconds > TIME_THRESHOLD_SECONDS) {
            reasons.push(`time_deviation:${Math.round(timeDeviationSeconds / 60)}min`);
          }
        }
      }
    } catch {
      // Google Directions unavailable — skip time check, spatial check still applies
    }
  }

  const anomalyDetected = reasons.length > 0;

  // ── Emit via Socket.IO if anomaly found ───────────────────────────────────
  if (anomalyDetected) {
    const io = getIO();
    if (io) {
      io.to(`ride:${rideId}`).emit('anomaly_detected', {
        rideId,
        reasons,
        spatialDeviationKm: parseFloat(spatialDeviationKm.toFixed(3)),
        timeDeviationSeconds,
        driverLat,
        driverLng,
        detectedAt: new Date().toISOString(),
      });
    }

    // Persist anomaly to DB for audit log (fire-and-forget)
    Promise.resolve(supabaseAdmin.from('ride_logs').insert({
      ride_id: rideId,
      event: 'anomaly_detected',
      metadata: { reasons, spatialDeviationKm, timeDeviationSeconds, driverLat, driverLng },
      created_at: new Date().toISOString(),
    })).catch(() => {});
  }

  return {
    anomalyDetected,
    reasons,
    spatialDeviationKm: parseFloat(spatialDeviationKm.toFixed(3)),
    timeDeviationSeconds,
    remainingEstimateSeconds,
  };
}
