import { pool } from '../db/pool';
  import { createContextLogger } from '../lib/logger';

  const log = createContextLogger('DRIVER_SCORE');

  const REJECTION_PENALTY      = 0.15;
  const CONSECUTIVE_EXTRA      = 0.30;
  const COMPLETION_BONUS       = 0.05;
  const MAX_SCORE              = 2.00;
  const MIN_SCORE              = 0.05;
  const CONSECUTIVE_AUTO_BLOCK = 8;

  export interface VerificationStatus {
    isBlocked:            boolean;
    blockReason?:         string;
    selfieDue:            boolean;
    priorityScore:        number;
    tripsCompleted:       number;
    tripsRejected:        number;
    consecutiveRejections:number;
    tripsSinceSelfie:     number;
    acceptanceRate:       number;
    needsReview:          boolean;
    rating:               number | null;
  }

  /** Viajes tras los cuales toca volver a verificar identidad. */
  export const SELFIE_TRIP_INTERVAL = 25;
  /** Días tras los cuales toca volver a verificar identidad. */
  export const SELFIE_MAX_AGE_DAYS  = 7;

  /**
   * ¿Le toca verificación de identidad?
   *
   * Estaba devuelto como `false` fijo, y eso dejaba muerto medio sistema:
   * `POST /api/drivers/selfie-verify` sí escribe `last_selfie_at`,
   * `trips_since_selfie` y `selfie_due_at`, pero nadie los leía, así que el campo
   * que la app recibe nunca podía ser `true`. Aquí se calcula con esos tres.
   *
   * Tres motivos, los mismos que contempla la pantalla de la app: una fecha
   * marcada a mano por el sistema, demasiados viajes desde la última, o demasiado
   * tiempo. Quien nunca se ha verificado y ya lleva viajes hechos, también.
   */
  export function calcularSelfieDue(p: {
    selfie_due_at?:      string | Date | null;
    trips_since_selfie?: number | null;
    last_selfie_at?:     string | Date | null;
    trips_completed?:    number | null;
  }): boolean {
    const ahora = Date.now();

    if (p.selfie_due_at && new Date(p.selfie_due_at).getTime() <= ahora) return true;
    if ((p.trips_since_selfie ?? 0) >= SELFIE_TRIP_INTERVAL) return true;

    if (p.last_selfie_at) {
      const dias = (ahora - new Date(p.last_selfie_at).getTime()) / 86_400_000;
      return dias >= SELFIE_MAX_AGE_DAYS;
    }

    // Nunca se verificó. No se le exige el primer día: sólo cuando ya trabaja.
    return (p.trips_completed ?? 0) >= SELFIE_TRIP_INTERVAL;
  }

  export async function getVerificationStatus(driverId: string): Promise<VerificationStatus> {
    const { rows } = await pool.query(
      `SELECT is_blocked, block_reason, priority_score, trips_completed, trips_rejected,
              consecutive_rejections, total_requests_received, needs_review, rating,
              last_selfie_at, trips_since_selfie, selfie_due_at
       FROM profiles WHERE id = $1`,
      [driverId]
    );
    const p = rows[0];
    if (!p) throw new Error('Driver not found');

    const tripsCompleted = p.trips_completed ?? 0;
    const totalReceived  = p.total_requests_received ?? 0;
    const acceptanceRate = totalReceived > 0
      ? Math.round((tripsCompleted / totalReceived) * 100)
      : 100;

    return {
      isBlocked:             p.is_blocked ?? false,
      blockReason:           p.block_reason ?? undefined,
      selfieDue:             calcularSelfieDue(p),
      priorityScore:         parseFloat(p.priority_score ?? '1.0'),
      tripsCompleted,
      tripsRejected:         p.trips_rejected  ?? 0,
      consecutiveRejections: p.consecutive_rejections ?? 0,
      tripsSinceSelfie:      p.trips_since_selfie ?? 0,
      acceptanceRate:        Math.min(100, Math.max(0, acceptanceRate)),
      needsReview:           p.needs_review ?? false,
      rating:                p.rating != null ? parseFloat(String(p.rating)) : null,
    };
  }

  export async function applyRejectionPenalty(driverId: string): Promise<{
    newScore: number;
    isBlocked: boolean;
    blockReason?: string;
  }> {
    // Atomic SQL: increment counters and clamp priority_score in a single UPDATE
    // to prevent race conditions when two rejections arrive simultaneously.
    const { rows } = await pool.query<{
      priority_score: string;
      trips_rejected: number;
      consecutive_rejections: number;
      is_blocked: boolean;
      block_reason: string | null;
    }>(
      `UPDATE profiles SET
          trips_rejected         = COALESCE(trips_rejected, 0) + 1,
          consecutive_rejections = COALESCE(consecutive_rejections, 0) + 1,
          priority_score = GREATEST(
            $1::numeric,
            ROUND((COALESCE(priority_score::numeric, 1.0) - (
              CASE WHEN COALESCE(consecutive_rejections, 0) + 1 >= 3
                   THEN $2::numeric + $3::numeric
                   ELSE $2::numeric
              END
            ))::numeric, 2)
          ),
          is_blocked  = CASE WHEN COALESCE(consecutive_rejections, 0) + 1 >= $4 THEN true ELSE is_blocked END,
          block_reason = CASE WHEN COALESCE(consecutive_rejections, 0) + 1 >= $4
                              THEN 'Account automatically suspended after ' || (COALESCE(consecutive_rejections, 0) + 1)::text || ' consecutive ride rejections. Please contact support to reactivate.'
                              ELSE block_reason END,
          updated_at  = NOW()
       WHERE id = $5
       RETURNING priority_score, trips_rejected, consecutive_rejections, is_blocked, block_reason`,
      [MIN_SCORE, REJECTION_PENALTY, CONSECUTIVE_EXTRA, CONSECUTIVE_AUTO_BLOCK, driverId]
    );

    if (!rows[0]) throw new Error('Driver not found');
    const r = rows[0];
    const newScore    = parseFloat(r.priority_score ?? '1.0');
    const consecutive = r.consecutive_rejections ?? 0;
    const isBlocked   = r.is_blocked ?? false;
    const blockReason = r.block_reason ?? undefined;

    log.warn({ driverId, to: newScore, consecutive, isBlocked }, 'rejection penalty applied');
    return { newScore, isBlocked, blockReason };
  }

  export async function applyCompletionBonus(driverId: string): Promise<{
    newScore: number;
    selfieDue: boolean;
  }> {
    // Atomic SQL: increment trips_completed, reset consecutive_rejections, and clamp score
    // to prevent race conditions when two completions are processed simultaneously.
    const { rows } = await pool.query<{
      priority_score: string;
      trips_completed: number;
    }>(
      `UPDATE profiles SET
          trips_completed        = COALESCE(trips_completed, 0) + 1,
          consecutive_rejections = 0,
          priority_score = LEAST(
            $1::numeric,
            ROUND((COALESCE(priority_score::numeric, 1.0) + $2::numeric)::numeric, 2)
          ),
          updated_at = NOW()
       WHERE id = $3
       RETURNING priority_score, trips_completed`,
      [MAX_SCORE, COMPLETION_BONUS, driverId]
    );

    if (!rows[0]) throw new Error('Driver not found');
    const r = rows[0];
    const newScore     = parseFloat(r.priority_score ?? '1.0');
    const tripsCompleted = r.trips_completed ?? 0;

    log.info({ driverId, to: newScore, tripsCompleted }, 'completion bonus applied');
    return { newScore, selfieDue: false };
  }

  export async function getDriverPriorityTiers(): Promise<{
    top:    string[];
    mid:    string[];
    normal: string[];
  }> {
    const { rows } = await pool.query(
      `SELECT id, priority_score FROM profiles
       WHERE role IN ('driver', 'chauffeur') AND is_blocked = false
       ORDER BY priority_score DESC`
    );

    const top:    string[] = [];
    const mid:    string[] = [];
    const normal: string[] = [];

    for (const p of rows) {
      const score = parseFloat(p.priority_score ?? '1.0');
      if (score >= 1.3)       top.push(p.id);
      else if (score >= 0.7)  mid.push(p.id);
      else                    normal.push(p.id);
    }

    return { top, mid, normal };
  }
  