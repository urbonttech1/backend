import cron from 'node-cron';
import { createContextLogger } from '../lib/logger';

const log = createContextLogger('CRON');
import { pool } from '../db/pool';
import { supabaseAdmin } from '../db/client';
import { findStaleRides, reassignRide } from '../services/rideReassignment';
import { notifyAvailableDrivers, getIo, broadcastRideStatus } from '../services/socketService';
import { offerScheduledRide, scheduledClaimLeadMinutes } from '../services/scheduledOffer';
import { reasignacionesVencidas, MINUTOS_PARA_REEMPLAZO, type ViajeEnReasignacion } from '../services/reassignTimeout';
import { getStripe } from '../api/rides/helpers';
import { devolverCobroDelViaje } from '../services/rideRefund';
import { pagarViajesPendientes } from '../services/payoutRecovery';
import { pagarComisionesValetPendientes } from '../services/valetPayout';
import { notifyUser, sendMulticast } from '../services/fcm';
import { notifyRidePassenger } from '../services/valetNotifications';
import { procesarNota, MAX_INTENTOS } from '../services/voiceTranscription';
import { passengerNotif, driverNotif } from '../services/notificationTemplates';
import { decidirAuto, guardarAuto } from '../services/surgeConfig';
import { enviarAvisoVencimientoDocumento, type FaseVencimiento } from '../services/accountEmails';
import { catalogoCompleto } from '../services/docCatalogStore';
import { audienciaDeRol, docMeta } from '../services/docCatalog';
import { revisarParadasEnSilencio } from '../services/rideCheckRun';

async function anonymizeOldRides() {
  log.info('[CRON] Starting daily PII anonymization job...');
  // 30-day retention: allows support team to resolve disputes before PII is removed.
  // GDPR permits retention for legitimate interests (billing disputes, safety).
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const twentyFourHoursAgo = new Date(Date.now() - thirtyDaysMs).toISOString();

  const { data: oldRides, error } = await supabaseAdmin
    .from('rides')
    .select('id')
    .eq('ride_status', 'completed')
    .lt('completed_at', twentyFourHoursAgo);

  if (error) {
    log.error({ err: error }, '[CRON] Failed to fetch rides for anonymization');
    return;
  }

  if (!oldRides || oldRides.length === 0) {
    log.info('[CRON] No rides to anonymize.');
    return;
  }

  const ids = oldRides.map(r => r.id);
  // Redact only the actual PII fields (street addresses, personal notes).
  // Keep passenger_id and driver_id — they are internal UUIDs needed for
  // ride history queries and analytics, not human-identifiable PII.
  // Batch in groups of 100 to avoid large IN clause timeouts and allow
  // partial success if one batch fails.
  const ANONYMIZE_BATCH = 100;
  let anonymized = 0;
  let failures = 0;
  for (let i = 0; i < ids.length; i += ANONYMIZE_BATCH) {
    const batch = ids.slice(i, i + ANONYMIZE_BATCH);
    const { error: batchErr } = await supabaseAdmin
      .from('rides')
      .update({
        pickup:  { address: '[REDACTED]', lat: 0, lng: 0 },
        dropoff: { address: '[REDACTED]', lat: 0, lng: 0 },
        notes:   null,
        updated_at: new Date().toISOString(),
      })
      .in('id', batch);
    if (batchErr) {
      log.error({ err: batchErr, batchStart: i }, '[CRON] Anonymization batch failed');
      failures += batch.length;
    } else {
      anonymized += batch.length;
    }
  }
  log.info(`[CRON] Job completed. Anonymized ${anonymized} rides. Failures: ${failures}.`);
}

/**
 * Cancel searching rides that have been waiting with no driver for more than 2 hours.
 * Immediate rides (no scheduled_at) expire after 2 hours.
 * Scheduled rides expire 30 minutes after their scheduled_at has passed.
 * This prevents old rides from surfacing as available in the driver app.
 */
async function cancelExpiredSearchingRides() {
  try {
    const twoHoursAgo   = new Date(Date.now() - 2  * 60 * 60 * 1000).toISOString();
    const thirtyMinsAgo = new Date(Date.now() - 30 *      60 * 1000).toISOString();

    // Cancel immediate rides older than 2 hours
    const { data: expiredImmediate, error: e1 } = await supabaseAdmin
      .from('rides')
      .update({ ride_status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('ride_status', 'searching')
      .is('driver_id', null)
      .is('scheduled_at', null)
      .lt('created_at', twoHoursAgo)
      .select('id, passenger_id, payment_intent_id');

    // Cancel scheduled rides whose scheduled_at has passed by more than 30 minutes
    const { data: expiredScheduled, error: e2 } = await supabaseAdmin
      .from('rides')
      .update({ ride_status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('ride_status', 'searching')
      .is('driver_id', null)
      .not('scheduled_at', 'is', null)
      .lt('scheduled_at', thirtyMinsAgo)
      .select('id, passenger_id, payment_intent_id');

    if (e1) log.error({ err: e1 }, '[CRON] Cancel expired immediate rides error');
    if (e2) log.error({ err: e2 }, '[CRON] Cancel expired scheduled rides error');

    // Notify passengers of cancelled rides (no driver found)
    const allExpired = [...(expiredImmediate ?? []), ...(expiredScheduled ?? [])];
    for (const ride of (allExpired ?? []) as Array<{ id: string; passenger_id: string | null; payment_intent_id: string | null }>) {
      // Se cobró al reservar: sin chofer no hubo viaje, se devuelve entero.
      await devolverCobroDelViaje(ride.payment_intent_id, ride.id);
      if (ride.passenger_id) {
        notifyRidePassenger(ride.id, String(ride.passenger_id), passengerNotif.rideCancelledNoDriver(ride.id)).catch(() => {});
      }
    }

    const n = allExpired.length;
    if (n > 0) log.info(`[CRON] Cancelled ${n} expired searching ride(s) — passengers notified.`);
  } catch (err: any) {
    log.error({ err: err }, '[CRON] cancelExpiredSearchingRides error');
  }
}


/**
 * Se acabó el plazo para encontrar reemplazo.
 *
 * Cuando un chofer cancela un viaje que ya había aceptado, el viaje vuelve a
 * «buscando» y se le ofrece a otro (api/rides/cancel.ts). Si nadie lo toma, el
 * pasajero se quedaba esperando sin final: la única red era la limpieza de los
 * viajes con más de dos horas buscando. Aquí se cancela a los pocos minutos, se
 * libera la retención de la tarjeta y se le avisa.
 */
async function cancelarReasignacionesVencidas() {
  try {
    const { data, error } = await supabaseAdmin
      .from('rides')
      .select('id, passenger_id, ride_status, driver_id, reassigning_since, payment_intent_id')
      .eq('ride_status', 'searching')
      .is('driver_id', null)
      .not('reassigning_since', 'is', null)
      .limit(100);
    if (error) {
      // La columna aún no existe: el servidor está sin migrar, no es un fallo.
      if (!/column|schema cache/i.test(error.message)) {
        log.error({ err: error.message }, '[CRON] reasignaciones vencidas: consulta');
      }
      return;
    }

    const vencidos = reasignacionesVencidas((data ?? []) as ViajeEnReasignacion[], new Date());
    if (!vencidos.length) return;

    const ahora = new Date().toISOString();

    for (const viaje of vencidos) {
      const fila = (data ?? []).find((d: Record<string, unknown>) => String(d.id) === viaje.id) as Record<string, unknown>;

      // Se cancela sólo si sigue sin chofer: entre la consulta y ahora puede
      // haberlo aceptado alguien.
      const { data: cancelado, error: cancelErr } = await supabaseAdmin
        .from('rides')
        .update({
          ride_status: 'cancelled',
          cancel_reason: 'no_driver_found',
          cancelled_at: ahora,
          reassigning_since: null,
          updated_at: ahora,
        })
        .eq('id', viaje.id)
        .eq('ride_status', 'searching')
        .is('driver_id', null)
        .select('id, passenger_id')
        .maybeSingle();

      if (cancelErr || !cancelado) continue;

      // Se libera la retención o, si ya se capturó —las reservas se cobran al
      // reservar—, se reembolsa: el pasajero no paga un viaje que no se hizo.
      await devolverCobroDelViaje(fila?.payment_intent_id as string | undefined, viaje.id);

      const passengerId = String(cancelado.passenger_id || '');
      if (passengerId) {
        notifyRidePassenger(viaje.id, passengerId, passengerNotif.rideCancelledNoDriver(viaje.id)).catch(() => {});
      }
      broadcastRideStatus(viaje.id, 'cancelled', {
        reason: 'no_driver_found',
        afterDriverCancelled: true,
        passengerId,
      });
      log.info(`[CRON] Viaje ${viaje.id} cancelado: nadie tomó el reemplazo en ${MINUTOS_PARA_REEMPLAZO} min.`);
    }
  } catch (err: any) {
    log.error({ err: err?.message }, '[CRON] cancelarReasignacionesVencidas');
  }
}

/**
 * Paga los viajes que el chofer se ganó y no cobró.
 *
 * Existe porque el pago del momento depende de que `stripe_connect_status` diga
 * 'active', y esa columna la escribía sólo el webhook `account.updated`, que
 * durante meses no llegó. Con esto, el dinero sale igual aunque el webhook
 * falle: es la red de seguridad del pago al chofer, no el camino normal.
 */
async function pagarChoferesPendientes() {
  const stripe = getStripe();
  if (!stripe) return;
  try {
    const r = await pagarViajesPendientes({ stripe });
    if (r.viajesPagados > 0 || r.choferesSinConnect > 0) {
      log.info(
        `[CRON] Pagos atrasados: ${r.viajesPagados}/${r.viajesRevisados} viajes, ` +
        `$${(r.centavosPagados / 100).toFixed(2)}, ${r.choferesSinConnect} choferes aún sin Connect.`
      );
    }
  } catch (err: any) {
    log.error({ err: err?.message }, '[CRON] pagarChoferesPendientes');
  }

  // Misma red de seguridad para la comisión de los valets: la que se quedó sin pagar
  // porque aún no tenían la cuenta de Stripe conectada.
  try {
    const v = await pagarComisionesValetPendientes({ stripe });
    if (v.viajesPagados > 0) {
      log.info(`[CRON] Comisiones de valet atrasadas: ${v.viajesPagados}/${v.viajesRevisados} viajes, $${(v.centavosPagados / 100).toFixed(2)}.`);
    }
  } catch (err: any) {
    log.error({ err: err?.message }, '[CRON] pagarComisionesValetPendientes');
  }
}

// In-memory set prevents double-processing if reassignRide takes longer than the cron interval
  const reassigningRideIds = new Set<string>();

  async function staleRideWatchdog() {
  try {
    const staleRides = await findStaleRides();
    if (!staleRides.length) return;

    // Filter out rides already being processed — prevents double-reassignment if a previous
    // cron tick is still in progress (the Set guard that was declared above but never used).
    const toProcess = staleRides.filter(r => !reassigningRideIds.has(r.id));
    if (!toProcess.length) return;

    toProcess.forEach(r => reassigningRideIds.add(r.id));
    log.info(`[CRON] Watchdog found ${toProcess.length} stale ride(s). Reassigning...`);

    let results: PromiseSettledResult<{ reassigned: boolean; rideId: string; reason: string }>[] = [];
    try {
      results = await Promise.allSettled(
        toProcess.map(r =>
          reassignRide(r.id, 'driver_inactive', r.driver_id)
        )
      );
    } finally {
      // Always release locks so future ticks can process these rides if needed
      toProcess.forEach(r => reassigningRideIds.delete(r.id));
    }

    const reassigned = results.filter(
      r => r.status === 'fulfilled' && (r as PromiseFulfilledResult<{ reassigned: boolean }>).value.reassigned
    ).length;
    log.info(`[CRON] Watchdog: ${reassigned}/${toProcess.length} rides reassigned.`);
  } catch (err: any) {
    log.error({ err: err }, '[CRON] Watchdog error');
  }
}

async function autoSurge() {
  try {
    // Count online drivers in last 5 minutes
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count: onlineDrivers } = await supabaseAdmin
      .from('driver_locations')
      .select('*', { count: 'exact', head: true })
      .gte('updated_at', fiveMinAgo);

    // Count active (searching/confirmed/in_progress) rides
    const { count: activeRides } = await supabaseAdmin
      .from('rides')
      .select('*', { count: 'exact', head: true })
      .in('ride_status', ['searching', 'confirmed', 'in_progress']);

    const drivers = onlineDrivers || 0;
    const rides = activeRides || 0;

    const objetivo = decidirAuto(drivers, rides);

    // `guardarAuto` relee el estado dentro de su transacción y con FOR UPDATE:
    // si un admin acaba de fijar un candado manual o de apagar el automático,
    // no escribe. Consultarlo desde la caché de 60 s perdería un candado puesto
    // justo después de la última lectura.
    const r = await guardarAuto(objetivo);

    if (!r.applied) {
      // El caso "no escribí" importa tanto como el contrario: es la primera
      // pregunta de un operador cuando el recargo no se mueve.
      log.info(`[CRON] Surge sin cambios (${r.reason}): objetivo ${objetivo}x, vigente ${r.current}x (${rides} viajes / ${drivers} conductores)`);
      return;
    }

    log.info(`[CRON] Surge updated: ${r.previous}x → ${r.current}x (${rides} rides / ${drivers} drivers)`);

    // Broadcast surge change to all connected clients
    const ioInstance = getIo();
    if (ioInstance) {
      ioInstance.emit('surge:changed', {
        previous: r.previous,
        current: r.current,
        dropped: r.previous > 1.0 && r.current === 1.0,
      });
    }

    // Notify online drivers when surge activates or increases
    if (r.current > 1.0 && r.current > r.previous) {
      notifyOnlineDriversOfSurge(r.current).catch(() => {});
    }
  } catch (err: any) {
    log.error({ err: err }, '[CRON] Auto-surge error');
  }
}

async function notifyOnlineDriversOfSurge(multiplier: number) {
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: onlineDrivers } = await supabaseAdmin
      .from('driver_locations')
      .select('driver_id')
      .eq('is_online', true)
      .gte('updated_at', fiveMinAgo);

    if (!onlineDrivers?.length) return;
    const driverIds = (onlineDrivers as Array<{ driver_id: string }>).map(d => d.driver_id);

    const { data: tokenRows } = await supabaseAdmin
      .from('user_push_tokens')
      .select('token')
      .in('user_id', driverIds)
      .eq('active', true);

    const tokens = (tokenRows as Array<{ token: string }> ?? []).map(r => r.token);
    if (!tokens.length) return;

    await sendMulticast(tokens, driverNotif.surgeActive(multiplier));
    log.info(`[CRON] Surge ${multiplier}x — notified ${tokens.length} online driver token(s).`);
  } catch (err: any) {
    log.error({ err: err }, '[CRON] notifyOnlineDriversOfSurge error');
  }
}

// ── T002: Driver Acceptance Timeout ──────────────────────────────────────────
// Rides that stay 'searching' for >5 min (immediate rides only) with no driver
// accepted are re-notified to other available drivers.
// IMPORTANT: Excludes scheduled rides that are more than 90 min in the future —
// those are handled by dispatchScheduledRides below.
async function driverAcceptanceTimeout() {
  try {
    const timeoutAgo       = new Date(Date.now() - 5  * 60 * 1000).toISOString();
    const ninetyMinsFromNow = new Date(Date.now() + 90 * 60 * 1000).toISOString();

    const { data: timedOutRides } = await supabaseAdmin
      .from('rides')
      .select('id, vehicle_type, pickup_address, pickup_lat, pickup_lng, scheduled_at')
      .eq('ride_status', 'searching')
      .lt('created_at', timeoutAgo)
      .is('accepted_at', null)
      // Only immediate rides OR scheduled rides already within the 90-min window
      .or(`scheduled_at.is.null,scheduled_at.lt.${ninetyMinsFromNow}`)
      .limit(10);

    if (!timedOutRides || timedOutRides.length === 0) return;

    log.info(`[CRON] Re-dispatching ${timedOutRides.length} unaccepted ride(s)...`);
    for (const ride of (timedOutRides ?? []) as Array<{ id: string; vehicle_type: string | null; pickup_address: string | null; pickup_lat: number | null; pickup_lng: number | null; scheduled_at: string | null }>) {
      notifyAvailableDrivers(
        ride.id,
        ride.vehicle_type || 'executive',
        ride.pickup_address || 'Miami, FL',
        ride.pickup_lat ?? null,
        ride.pickup_lng ?? null,
      );
    }
  } catch (err: any) {
    log.error({ err: err }, '[CRON] Acceptance timeout error');
  }
}

// ── Scheduled ride safety net ────────────────────────────────────────────────
// Reservations are offered to nearby chauffeurs at booking time.
// This cron runs every 5 minutes and:
//  1. Cancels unclaimed reservations whose pickup is more than 30 min in the past
//  2. Inside the lead window (app_config scheduled_claim_lead_minutes, default 30):
//     unclaimed rides become a live request and are offered again to everyone nearby
//  3. Claimed rides in that window remind the assigned chauffeur to head out
async function dispatchScheduledRides() {
  try {
    const now = new Date();
    const leadMin = await scheduledClaimLeadMinutes();
    const leadFromNow = new Date(now.getTime() + leadMin * 60 * 1000).toISOString();
    const thirtyMinsAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

    // ── Step 1: Cancel overdue unclaimed reservations ──────────────────────
    const { data: overdueRides } = await supabaseAdmin
      .from('rides')
      .update({ ride_status: 'cancelled', cancel_reason: 'no_driver_available', updated_at: now.toISOString() })
      .eq('ride_status', 'scheduled')
      .is('driver_id', null)
      .lt('scheduled_at', thirtyMinsAgo)
      .select('id, passenger_id, payment_intent_id');

    if (overdueRides?.length) {
      log.info(`[CRON] Auto-cancelled ${overdueRides.length} overdue scheduled ride(s) (missed dispatch window)`);
      for (const ride of (overdueRides ?? []) as Array<{ id: string; passenger_id: string | null; payment_intent_id: string | null }>) {
        await devolverCobroDelViaje(ride.payment_intent_id, ride.id);
        if (ride.passenger_id) {
          notifyRidePassenger(ride.id, String(ride.passenger_id), passengerNotif.rideCancelledNoDriver(ride.id)).catch(() => {});
        }
      }
    }

    // ── Step 2: Unclaimed reservations entering the lead window ────────────
    const { data: readyRides, error } = await supabaseAdmin
      .from('rides')
      .select('id, vehicle_type, pickup_address, pickup, pickup_lat, pickup_lng, scheduled_at, passenger_id')
      .eq('ride_status', 'scheduled')
      .is('driver_id', null)
      .gte('scheduled_at', now.toISOString())
      .lte('scheduled_at', leadFromNow)
      .limit(20);

    if (error) {
      log.error({ err: error }, '[CRON] dispatchScheduledRides query error');
      return;
    }

    if (readyRides && readyRides.length > 0) {
      log.info(`[CRON] Dispatching ${readyRides.length} scheduled ride(s) - transitioning to 'searching'...`);

      for (const ride of readyRides as Array<{ id: string; vehicle_type: string | null; pickup_address: string | null; pickup: { address?: string } | string | null; pickup_lat: number | null; pickup_lng: number | null; scheduled_at: string | null; passenger_id: string | null }>) {
        const minutesUntil = Math.round((new Date(ride.scheduled_at!).getTime() - now.getTime()) / 60000);

        // Transition: scheduled -> searching
        const { error: updateErr } = await supabaseAdmin
          .from('rides')
          .update({ ride_status: 'searching', updated_at: now.toISOString() })
          .eq('id', ride.id)
          .eq('ride_status', 'scheduled')
          .is('driver_id', null);

        if (updateErr) {
          log.error({ rideId: ride.id, err: updateErr.message }, '[CRON] Failed to transition ride to searching');
          continue;
        }

        log.info(`[CRON]   Ride ${ride.id} (in ${minutesUntil} min)   searching - offering again to nearby chauffeurs`);

        const pickupAddr = ride.pickup_address
          || (typeof ride.pickup === 'string' ? ride.pickup : ride.pickup?.address)
          || 'Miami, FL';
        offerScheduledRide({
          rideId: ride.id,
          vehicleType: ride.vehicle_type || 'executive',
          pickupAddress: pickupAddr,
          pickupLat: ride.pickup_lat ?? null,
          pickupLng: ride.pickup_lng ?? null,
          scheduledAt: ride.scheduled_at || now.toISOString(),
        }).catch(() => {});

        // Notify passenger that driver search has started
        if (ride.passenger_id) {
          try {
            await notifyUser(String(ride.passenger_id), passengerNotif.scheduled15min(ride.id, minutesUntil));
            await supabaseAdmin.from('rides').update({ dispatch_35m_sent: true }).eq('id', ride.id);
          } catch (e) {
            log.error({ err: e }, '[CRON] Failed to send dispatch notification to passenger');
          }
        }
      }
    }

    // Step 3: Retry missing notifications for rides already in searching state
    const { data: retryRides } = await supabaseAdmin
      .from('rides')
      .select('id, passenger_id, scheduled_at')
      .eq('ride_status', 'searching')
      .eq('dispatch_35m_sent', false)
      .is('driver_id', null)
      .gte('scheduled_at', now.toISOString())
      .lte('scheduled_at', leadFromNow)
      .limit(20);

    for (const ride of (retryRides ?? []) as Array<{ id: string; passenger_id: string | null; scheduled_at: string }>) {
      if (!ride.passenger_id) continue;
      // Atomic guard: only 1 instance claims the retry
      const { data: claimed } = await supabaseAdmin
        .from('rides')
        .update({ dispatch_35m_sent: true, updated_at: now.toISOString() })
        .eq('id', ride.id)
        .eq('dispatch_35m_sent', false)
        .select('id');

      if (!claimed || claimed.length === 0) continue; // Another instance claimed it

      const minutesUntil = Math.round((new Date(ride.scheduled_at).getTime() - now.getTime()) / 60000);
      try {
        await notifyUser(String(ride.passenger_id), passengerNotif.scheduled15min(ride.id, minutesUntil));
        log.info(`[CRON] Retried dispatch notification for ride ${ride.id}`);
      } catch (e) {
        log.error({ err: e, rideId: ride.id }, '[CRON] Retry failed to send dispatch notification');
      }
    }

    // Step 4: claimed reservations inside the lead window — remind the chauffeur to leave.
    const { data: assignedDue } = await supabaseAdmin
      .from('rides')
      .select('id, driver_id, passenger_id, scheduled_at')
      .eq('ride_status', 'scheduled')
      .not('driver_id', 'is', null)
      .eq('dispatch_35m_sent', false)
      .gte('scheduled_at', now.toISOString())
      .lte('scheduled_at', leadFromNow)
      .limit(20);

    for (const ride of (assignedDue ?? []) as Array<{ id: string; driver_id: string; passenger_id: string | null; scheduled_at: string }>) {
      const { data: claimed } = await supabaseAdmin
        .from('rides')
        .update({ dispatch_35m_sent: true, updated_at: now.toISOString() })
        .eq('id', ride.id)
        .eq('dispatch_35m_sent', false)
        .select('id');
      if (!claimed || claimed.length === 0) continue;
      const minutesUntil = Math.max(1, Math.round((new Date(ride.scheduled_at).getTime() - now.getTime()) / 60000));
      notifyUser(ride.driver_id, {
        title: 'Time to head to pickup',
        body: `Your reserved ride is in ${minutesUntil} min. Start toward the pickup.`,
        data: { type: 'scheduled_depart', ride_id: ride.id, screen: 'driver_home' },
      }).catch(() => {});
      if (ride.passenger_id) {
        notifyUser(ride.passenger_id, passengerNotif.scheduled15min(ride.id, minutesUntil)).catch(() => {});
      }
    }
  } catch (err: any) {
    log.error({ err: err }, '[CRON] dispatchScheduledRides error');
  }
}

// ── Scheduled ride reminders: 24h and 1h before ──────────────────────────────
// Queries rides still in 'scheduled' status and within reminder windows.
// Uses atomic database flags (reminder_24h_sent / reminder_1h_sent) to ensure
// 0 duplicate push notifications across multiple Cloud Run instances.
async function sendScheduledRideReminders() {
  try {
    const now = Date.now();

    // 24h window: scheduled_at between 23h and 25h from now
    const win24hLow  = new Date(now + 23 * 60 * 60 * 1000).toISOString();
    const win24hHigh = new Date(now + 25 * 60 * 60 * 1000).toISOString();

    // 1h window: scheduled_at between 45m and 75m from now
    const win1hLow  = new Date(now + 45 * 60 * 1000).toISOString();
    const win1hHigh = new Date(now + 75 * 60 * 1000).toISOString();

    const [res24h, res1h] = await Promise.all([
      supabaseAdmin
        .from('rides')
        .select('id, passenger_id, driver_id, scheduled_at')
        .eq('ride_status', 'scheduled')
        .eq('reminder_24h_sent', false)
        .gte('scheduled_at', win24hLow)
        .lte('scheduled_at', win24hHigh),
      supabaseAdmin
        .from('rides')
        .select('id, passenger_id, driver_id, scheduled_at')
        .eq('ride_status', 'scheduled')
        .eq('reminder_1h_sent', false)
        .gte('scheduled_at', win1hLow)
        .lte('scheduled_at', win1hHigh),
    ]);

    const format = (iso: string) =>
      new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    let count24h = 0;
    for (const ride of (res24h.data ?? []) as Array<{ id: string; passenger_id: string | null; driver_id: string | null; scheduled_at: string }>) {
      if (!ride.passenger_id) continue;
      // Atomic claim before send
      const { data: claimed } = await supabaseAdmin
        .from('rides')
        .update({ reminder_24h_sent: true, updated_at: new Date().toISOString() })
        .eq('id', ride.id)
        .eq('reminder_24h_sent', false)
        .select('id');

      if (!claimed || claimed.length === 0) continue;

      count24h++;
      const timeLabel = format(ride.scheduled_at);
      notifyUser(String(ride.passenger_id), passengerNotif.scheduled24h(ride.id, timeLabel)).catch(() => {});
      // The assigned chauffeur gets the same lead time as the passenger.
      if (ride.driver_id) {
        notifyUser(String(ride.driver_id), driverNotif.reservationTomorrow(ride.id, timeLabel)).catch(() => {});
      }
    }

    let count1h = 0;
    for (const ride of (res1h.data ?? []) as Array<{ id: string; passenger_id: string | null; driver_id: string | null; scheduled_at: string }>) {
      if (!ride.passenger_id) continue;
      // Atomic claim before send
      const { data: claimed } = await supabaseAdmin
        .from('rides')
        .update({ reminder_1h_sent: true, updated_at: new Date().toISOString() })
        .eq('id', ride.id)
        .eq('reminder_1h_sent', false)
        .select('id');

      if (!claimed || claimed.length === 0) continue;

      count1h++;
      const timeLabel = format(ride.scheduled_at);
      notifyUser(String(ride.passenger_id), passengerNotif.scheduled1h(ride.id, timeLabel)).catch(() => {});
      if (ride.driver_id) {
        notifyUser(String(ride.driver_id), driverNotif.reservationInOneHour(ride.id, timeLabel)).catch(() => {});
      }
    }

    const total = count24h + count1h;
    if (total > 0) log.info(`[CRON] Scheduled ride reminders sent: ${count24h} ×24h, ${count1h} ×1h`);
  } catch (err: any) {
    log.error({ err: err }, '[CRON] sendScheduledRideReminders error');
  }
}

// ── Rate reminder: 2h after completion, if ride still unrated ────────────────
async function sendRateReminders() {
  try {
    const twoHoursAgo  = new Date(Date.now() - 2  * 60 * 60 * 1000).toISOString();
    const threeHrsAgo  = new Date(Date.now() - 3  * 60 * 60 * 1000).toISOString();

    // Completed rides 2–3 hours ago with no passenger rating and not yet reminded
    const { data: unratedRides, error } = await supabaseAdmin
      .from('rides')
      .select('id, passenger_id, rating')
      .eq('ride_status', 'completed')
      .eq('rate_reminder_sent', false)
      .is('rating', null)
      .lte('completed_at', twoHoursAgo)
      .gte('completed_at', threeHrsAgo)
      .not('passenger_id', 'is', null);

    if (error || !unratedRides) return;

    let sent = 0;
    for (const ride of (unratedRides ?? []) as Array<{ id: string; passenger_id: string | null }>) {
      if (!ride.passenger_id) continue;
      // Atomic claim before sending notification
      const { data: claimed } = await supabaseAdmin
        .from('rides')
        .update({ rate_reminder_sent: true, updated_at: new Date().toISOString() })
        .eq('id', ride.id)
        .eq('rate_reminder_sent', false)
        .select('id');

      if (!claimed || claimed.length === 0) continue;

      sent++;
      notifyUser(String(ride.passenger_id), passengerNotif.rateReminder(ride.id)).catch(() => {});
    }

    if (sent > 0) {
      log.info(`[CRON] Rate reminders sent to ${sent} passenger(s).`);
    }
  } catch (err: any) {
    log.error({ err: err }, '[CRON] sendRateReminders error');
  }
}

// ── Weekly earnings summary: every Monday at 9 AM ────────────────────────────
async function sendWeeklyEarningsSummary() {
  try {
    const now = new Date();
    // Only run on Mondays
    if (now.getDay() !== 1) return;

    // Last week: Sunday–Saturday
    const lastSunday   = new Date(now);
    lastSunday.setDate(now.getDate() - now.getDay() - 7);
    lastSunday.setHours(0, 0, 0, 0);

    const lastSaturday = new Date(lastSunday);
    lastSaturday.setDate(lastSunday.getDate() + 6);
    lastSaturday.setHours(23, 59, 59, 999);

    const { data: rides, error } = await supabaseAdmin
      .from('rides')
      .select('driver_id, fare')
      .eq('ride_status', 'completed')
      .gte('completed_at', lastSunday.toISOString())
      .lte('completed_at', lastSaturday.toISOString())
      .not('driver_id', 'is', null);

    if (error || !rides?.length) return;

    // Aggregate by driver
    const byDriver: Record<string, { earnings: number; trips: number }> = {};
    for (const r of (rides ?? []) as Array<{ driver_id: string | null; fare: number | null }>) {
      if (!r.driver_id) continue;
      if (!byDriver[r.driver_id]) byDriver[r.driver_id] = { earnings: 0, trips: 0 };
      byDriver[r.driver_id].earnings += Number(r.fare ?? 0) * 0.9; // 90% cut
      byDriver[r.driver_id].trips    += 1;
    }

    const weekLabel = `${lastSunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${lastSaturday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

    let notified = 0;
    for (const [driverId, { earnings, trips }] of Object.entries(byDriver)) {
      if (trips === 0) continue;
      notifyUser(driverId, driverNotif.weeklyEarnings(earnings, trips, weekLabel)).catch(() => {});
      notified++;
    }

    if (notified > 0) log.info(`[CRON] Weekly earnings summary sent to ${notified} driver(s) for week ${weekLabel}.`);
  } catch (err: any) {
    log.error({ err: err }, '[CRON] sendWeeklyEarningsSummary error');
  }
}

// ── T007: Driver stats cleanup — reset consecutive trip streak if offline >12h ─
async function resetStaleStreaks() {
  try {
    const twelveHrsAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const { error } = await supabaseAdmin
      .from('driver_stats')
      .update({ consecutive_trips: 0, last_updated: new Date().toISOString() })
      .lt('last_updated', twelveHrsAgo)
      .gt('consecutive_trips', 0);
    if (!error) log.info('[CRON] Stale streaks reset');
  } catch (err: any) {
    log.error({ err: err }, '[CRON] Streak reset error');
  }
}

// ── Auto-flag dormant drivers (30+ days no activity) ─────────────────────────
/**
 * Caduca el `is_online` de conductores que llevan horas sin dar senal.
 *
 * Antes lo hacia el handler de `disconnect` del socket, que marcaba offline en
 * cuanto se caia la conexion; se quito porque iOS suspende el WebView al pasar
 * la app a segundo plano y dejaba offline a un conductor que seguia trabajando.
 * Sin ese handler nadie limpiaba la columna, asi que quien cierra la app y no
 * vuelve se quedaba `is_online = true` indefinidamente.
 *
 * Esto NO decide a quien se despacha: de eso se encarga el filtro de frescura
 * de `notifyNearbyDrivers`, que solo mira filas con `updated_at` reciente. Aqui
 * solo se limpia la bandera para que refleje la realidad en el panel y en las
 * consultas que la usan sin mirar la frescura.
 */
const ONLINE_STALE_HOURS = 8;

async function expireStaleOnlineDrivers() {
  try {
    const cutoff = new Date(Date.now() - ONLINE_STALE_HOURS * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('driver_locations')
      // `updated_at` NO se toca: es la senal de frescura que usa
      // notifyNearbyDrivers para saber si la posicion sigue viva. Escribirla
      // aqui dejaria a un conductor muerto pareciendo recien visto, que es justo
      // lo que hacia mal el handler de disconnect que se quito.
      .update({ is_online: false })
      .eq('is_online', true)
      .lt('updated_at', cutoff)
      .select('driver_id');

    if (error) throw error;
    if (data?.length) {
      log.info({ count: data.length, hours: ONLINE_STALE_HOURS }, '[CRON] Conductores marcados offline por inactividad');
    }
  } catch (err: unknown) {
    log.error({ err }, '[CRON] expireStaleOnlineDrivers failed');
  }
}

async function flagInactiveDrivers() {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Find drivers whose most recent completed ride is older than 30 days
    const { data: inactiveDrivers, error } = await supabaseAdmin
      .from('profiles')
      .select('id, last_active_at')
      .eq('role', 'driver')
      .eq('needs_review', false)
      .not('last_active_at', 'is', null)
      .lt('last_active_at', thirtyDaysAgo);

    if (error || !inactiveDrivers?.length) return;

    const ids = inactiveDrivers.map(d => d.id);
    await supabaseAdmin
      .from('profiles')
      .update({ needs_review: true, updated_at: new Date().toISOString() })
      .in('id', ids);

    log.info(`[CRON] Flagged ${ids.length} inactive driver(s) for review (30+ days no activity).`);
  } catch (err: any) {
    log.error({ err: err }, '[CRON] flagInactiveDrivers error');
  }
}

// ── Driver cancellation pattern detection (>3 cancels in 7 days → flag) ──────
async function checkCancellationPatterns() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Count driver cancellations per driver in the last 7 days
    const { data: cancels, error } = await supabaseAdmin
      .from('rides')
      .select('driver_id')
      .eq('ride_status', 'cancelled')
      .eq('cancelled_by', 'driver')
      .gte('updated_at', sevenDaysAgo)
      .not('driver_id', 'is', null);

    if (error || !cancels?.length) return;

    // Aggregate by driver
    const counts: Record<string, number> = {};
    for (const r of cancels) {
      if (r.driver_id) counts[r.driver_id] = (counts[r.driver_id] ?? 0) + 1;
    }

    // Flag drivers with > 3 cancellations
    const flagged = Object.entries(counts).filter(([, cnt]) => cnt > 3).map(([id]) => id);
    if (!flagged.length) return;

    await supabaseAdmin
      .from('profiles')
      .update({ needs_review: true, updated_at: new Date().toISOString() })
      .in('id', flagged)
      .eq('needs_review', false);

    log.info(`[CRON] Cancellation pattern: flagged ${flagged.length} driver(s) for review (>3 cancels/7days).`);
  } catch (err: any) {
    log.error({ err: err }, '[CRON] checkCancellationPatterns error');
  }
}

// ── Notas de voz que se quedaron sin transcribir ─────────────────────────────
// La transcripción se lanza fuera del ciclo de la petición, así que un reinicio
// del proceso la pierde y la nota se queda en 'pending' para siempre. Esto la
// recoge. También cubre un fallo puntual de red o de la API.
async function retranscribirNotasPendientes() {
  try {
    // Un minuto de margen: si acaba de llegar, la petición aún la está haciendo.
    const haceUnMinuto = new Date(Date.now() - 60 * 1000).toISOString();

    const { data: pendientes } = await supabaseAdmin
      .from('ride_chats')
      .select('id, ride_id, sender_role, audio_path, audio_mime, source_lang, target_lang, transcript_attempts')
      .eq('transcript_status', 'pending')
      .lt('transcript_attempts', MAX_INTENTOS)
      .lte('created_at', haceUnMinuto)
      .not('audio_path', 'is', null)
      .limit(10);

    if (!pendientes || pendientes.length === 0) return;

    for (const fila of pendientes as Array<Record<string, unknown>>) {
      const intentos = Number(fila.transcript_attempts ?? 0);
      // Reclamo atómico: sube el contador antes de trabajar, así dos instancias
      // no transcriben la misma nota y no se paga dos veces la llamada.
      const { data: reclamada } = await supabaseAdmin
        .from('ride_chats')
        .update({ transcript_attempts: intentos + 1 })
        .eq('id', fila.id as string)
        .eq('transcript_attempts', intentos)
        .select('id');
      if (!reclamada || reclamada.length === 0) continue;

      await procesarNota({
        msgId: String(fila.id),
        rideId: String(fila.ride_id),
        senderRole: String(fila.sender_role ?? 'passenger'),
        audioPath: String(fila.audio_path),
        mime: (fila.audio_mime as string | null) ?? null,
        sourceLang: String(fila.source_lang ?? 'en'),
        targetLang: String(fila.target_lang ?? 'es'),
        intentosPrevios: intentos,
      });
    }

    log.info(`[CRON] Notas de voz reintentadas: ${pendientes.length}`);
  } catch (err: any) {
    log.error({ err }, '[CRON] retranscribirNotasPendientes error');
  }
}

export async function startCronJobs() {
  // ── Leader Election for Horizontal Scaling (Google Cloud Run 1..10 instances) ──
  // Acquire a PostgreSQL session-level advisory lock (id: 72728).
  // Only ONE Cloud Run instance will successfully acquire this lock.
  // All other instances will log and safely skip all cron jobs, completely eliminating
  // duplicate push notifications, duplicate retries, and redundant database queries.
  let leaderClient;
  try {
    leaderClient = await pool.connect();
    const { rows } = await leaderClient.query('SELECT pg_try_advisory_lock(72728) AS acquired');
    const isLeader = Boolean(rows[0]?.acquired);
    if (!isLeader) {
      log.info('[CRON] Another Cloud Run instance is already the active cron leader (lock 72728 held) — skipping crons on this instance.');
      leaderClient.release();
      return;
    }
    log.info('[CRON] ✓ Acquired cron leader advisory lock (72728). This instance is the active cron coordinator.');

    // Gracefully release lock and client on server shutdown
    const cleanup = async () => {
      try {
        await leaderClient?.query('SELECT pg_advisory_unlock(72728)');
      } catch { /* ignore */ }
      try {
        leaderClient?.release();
      } catch { /* ignore */ }
    };
    process.once('SIGTERM', cleanup);
    process.once('SIGINT', cleanup);

    leaderClient.on('error', (err) => {
      log.error({ err }, '[CRON] Leader connection error, releasing client');
      try { leaderClient?.release(); } catch { /* ignore */ }
    });
  } catch (err: unknown) {
    log.error({ err }, '[CRON] Failed to acquire advisory lock — running crons on this instance as fallback');
    if (leaderClient) {
      try { leaderClient.release(); } catch { /* ignore */ }
    }
  }

  // Run immediately on startup to clear any stale rides before the first driver connects
  cancelExpiredSearchingRides().catch(() => {});

  cron.schedule('0 0 * * *', () => {
    anonymizeOldRides();
  });
  log.info('[CRON] Daily anonymization job scheduled for 00:00.');

  cron.schedule('*/2 * * * *', () => {
    staleRideWatchdog();
  });
  log.info('[CRON] Stale ride watchdog scheduled every 2 minutes.');

  cron.schedule('*/15 * * * *', () => {
    cancelExpiredSearchingRides();
  });
  log.info('[CRON] Expired searching-ride cleanup scheduled every 15 minutes.');

  cron.schedule('*/5 * * * *', () => {
    autoSurge();
  });
  log.info('[CRON] Auto-surge pricing scheduled every 5 minutes.');

  // Caducidad del estado "conectado": cada 30 minutos basta, el umbral es de horas.
  cron.schedule('*/30 * * * *', () => {
    expireStaleOnlineDrivers();
  });
  log.info(`[CRON] Stale online-driver expiry scheduled every 30 minutes (${ONLINE_STALE_HOURS}h threshold).`);

  // Cada minuto: el plazo para encontrar reemplazo es de minutos, no de horas.
  cron.schedule('* * * * *', () => {
    cancelarReasignacionesVencidas();
    revisarParadasEnSilencio().catch((err: unknown) => log.warn({ err: (err as Error)?.message }, '[CRON] ride check failed'));
  });
  log.info(`[CRON] Reassignment timeout check scheduled every minute (${MINUTOS_PARA_REEMPLAZO} min).`);

  // Pagos atrasados al chofer: cada 15 minutos.
  cron.schedule('*/15 * * * *', () => {
    pagarChoferesPendientes();
  });
  log.info('[CRON] Pending driver payouts scheduled every 15 minutes.');

  // T002: Re-dispatch unaccepted rides every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    driverAcceptanceTimeout();
  });
  log.info('[CRON] Driver acceptance timeout check scheduled every 5 minutes.');

  // Dispatch scheduled rides when they enter the 90-min pickup window
  cron.schedule('*/5 * * * *', () => {
    dispatchScheduledRides();
  });
  // Run immediately on startup in case server restarted with scheduled rides already in window
  dispatchScheduledRides().catch(() => {});
  log.info('[CRON] Scheduled ride dispatch job running every 5 minutes.');

  // Scheduled ride reminders: 24h and 1h before pickup
  cron.schedule('*/5 * * * *', () => {
    sendScheduledRideReminders();
  });
  log.info('[CRON] Scheduled ride reminder job running every 5 minutes.');

  // Rate reminders: 2h after completed rides with no rating
  cron.schedule('*/30 * * * *', () => {
    sendRateReminders();
  });
  log.info('[CRON] Rate reminder job running every 30 minutes.');

  // Weekly earnings summary: every Monday at 9 AM
  cron.schedule('0 9 * * 1', () => {
    sendWeeklyEarningsSummary();
  });
  log.info('[CRON] Weekly earnings summary scheduled for Monday 09:00.');

  // T019: Reset stale streaks every hour (drivers offline >12h lose streak)
  cron.schedule('0 * * * *', () => {
    resetStaleStreaks();
  });
  log.info('[CRON] Driver streak reset scheduled every hour.');

  // Flag dormant drivers once daily at 03:00
  cron.schedule('0 3 * * *', () => {
    flagInactiveDrivers();
  });
  log.info('[CRON] Inactive driver flagging scheduled daily at 03:00.');

  // Check cancellation patterns every 6 hours
  cron.schedule('0 */6 * * *', () => {
    checkCancellationPatterns();
  });
  log.info('[CRON] Cancellation pattern check scheduled every 6 hours.');

  // Document expiry check daily at 08:00
  // Cada 2 minutos: notas de voz que se quedaron a medias.
  cron.schedule('*/2 * * * *', () => {
    retranscribirNotasPendientes();
  });

  cron.schedule('0 8 * * *', () => {
    checkDocumentExpiry();
  });
  log.info('[CRON] Document expiry check scheduled daily at 08:00.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Document Expiry — alert at 30d/7d, auto-suspend at 0d
// ─────────────────────────────────────────────────────────────────────────────

/** El correo que acompaña al push. Nunca lanza: un fallo de correo no frena el cron. */
async function avisarVencimientoPorCorreo(driverId: string, docKey: string, expiry: string, fase: FaseVencimiento) {
  try {
    const { data: perfil } = await supabaseAdmin.from('profiles')
      .select('email, first_name, last_name, role').eq('id', driverId).maybeSingle();
    if (!perfil?.email) return;
    const catalogo = await catalogoCompleto(audienciaDeRol(perfil.role as string | null)).catch(() => []);
    const etiqueta = catalogo.find(d => d.key === docKey)?.label ?? docMeta(docKey).label;
    const r = await enviarAvisoVencimientoDocumento(
      { email: perfil.email as string, name: [perfil.first_name, perfil.last_name].filter(Boolean).join(' ') },
      etiqueta, expiry, fase,
    );
    if (!r.sent) log.warn(`[CRON] Correo de vencimiento (${fase}) no enviado a ${driverId}: ${r.message}`);
  } catch (err) {
    log.warn({ err }, `[CRON] Correo de vencimiento (${fase}) falló para ${driverId}`);
  }
}

async function checkDocumentExpiry() {
  log.info('[CRON] Running document expiry check...');
  try {
    const now       = new Date();
    const in30days  = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const in15days  = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const in7days   = new Date(now.getTime() +  7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const today     = now.toISOString().slice(0, 10);

    const { data: docs } = await supabaseAdmin
      .from('driver_documents')
      .select('id, driver_id, document_type, expiry_date, notified_30d, notified_15d, notified_7d')
      .not('expiry_date', 'is', null)
      .lte('expiry_date', in30days);

    if (!docs?.length) {
      log.info('[CRON] No expiring documents found.');
      return;
    }

    for (const doc of docs) {
      const expiry     = (doc as Record<string,unknown>).expiry_date as string;
      const driverId   = (doc as Record<string,unknown>).driver_id  as string;
      const docType    = ((doc as Record<string,unknown>).document_type as string) || 'document';
      const docId      = (doc as Record<string,unknown>).id as string;
      const n30        = (doc as Record<string,unknown>).notified_30d as boolean;
      const n15        = (doc as Record<string,unknown>).notified_15d as boolean;
      const n7         = (doc as Record<string,unknown>).notified_7d  as boolean;

      if (expiry <= today) {
        // Expired — suspend driver
        await supabaseAdmin.from('profiles').update({
          is_online:       false,
          needs_review:    true,
          updated_at:      now.toISOString(),
        }).eq('id', driverId);

        notifyUser(driverId, {
          title: '⚠️ Document Expired — Account Suspended',
          body:  `Your ${docType} has expired. Your account has been temporarily suspended. Please upload a valid document to resume driving.`,
          data:  { type: 'document_expired', doc_id: docId, screen: 'driver_documents' },
        }).catch(() => {});
        // El push se repite cada día mientras siga vencido; el correo, sólo el día que vence.
        if (expiry === today) avisarVencimientoPorCorreo(driverId, docType, expiry, 'vencido');

        log.info(`[CRON] Driver ${driverId} suspended — ${docType} expired on ${expiry}`);

      } else if (expiry <= in7days && !n7) {
        // Atomic claim first before sending push
        const { data: claimed } = await supabaseAdmin
          .from('driver_documents')
          .update({ notified_7d: true, updated_at: now.toISOString() })
          .eq('id', docId)
          .eq('notified_7d', false)
          .select('id');

        if (!claimed || claimed.length === 0) continue;

        notifyUser(driverId, {
          title: '⚠️ Document Expiring in 7 Days',
          body:  `Your ${docType} expires on ${expiry}. Upload a renewal now to avoid suspension.`,
          data:  { type: 'document_expiring_7d', doc_id: docId, screen: 'driver_documents' },
        }).catch(() => {});
        avisarVencimientoPorCorreo(driverId, docType, expiry, '7d');

        log.info(`[CRON] Driver ${driverId} notified — ${docType} expires ${expiry} (7d warning)`);

      } else if (expiry <= in15days && !n15) {
        const { data: claimed } = await supabaseAdmin
          .from('driver_documents')
          .update({ notified_15d: true, updated_at: now.toISOString() })
          .eq('id', docId)
          .eq('notified_15d', false)
          .select('id');

        if (!claimed || claimed.length === 0) continue;

        notifyUser(driverId, {
          title: '⚠️ Document Expiring in 15 Days',
          body:  `Your ${docType} expires on ${expiry}. Upload a renewal soon to avoid suspension.`,
          data:  { type: 'document_expiring_15d', doc_id: docId, screen: 'driver_documents' },
        }).catch(() => {});
        avisarVencimientoPorCorreo(driverId, docType, expiry, '15d');

        log.info(`[CRON] Driver ${driverId} notified — ${docType} expires ${expiry} (15d warning)`);

      } else if (expiry <= in30days && !n30) {
        // Atomic claim first before sending push
        const { data: claimed } = await supabaseAdmin
          .from('driver_documents')
          .update({ notified_30d: true, updated_at: now.toISOString() })
          .eq('id', docId)
          .eq('notified_30d', false)
          .select('id');

        if (!claimed || claimed.length === 0) continue;

        notifyUser(driverId, {
          title: '📋 Document Expiring in 30 Days',
          body:  `Your ${docType} expires on ${expiry}. Please renew it soon to continue driving.`,
          data:  { type: 'document_expiring_30d', doc_id: docId, screen: 'driver_documents' },
        }).catch(() => {});
        avisarVencimientoPorCorreo(driverId, docType, expiry, '30d');

        log.info(`[CRON] Driver ${driverId} notified — ${docType} expires ${expiry} (30d warning)`);
      }
    }
  } catch (err: any) {
    log.error({ err: err }, '[CRON] Document expiry check failed');
  }
}
