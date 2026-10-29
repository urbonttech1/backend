import { createContextLogger } from '../lib/logger';
import { supabaseAdmin } from '../db/client';
import { recordRideOffers } from './driverRideHistory';
import { audienciaDelViaje, RADIO_KM } from './dispatchAudience';
import { ensureZonesFresh, getZones, resolveZone } from './serviceZones';
import { pool } from '../db/pool';
import { enIdioma, resolverIdioma, type Idioma, type Texto } from './pushLanguage';

const log = createContextLogger('FCM');

type FirebaseMessaging = import('firebase-admin/messaging').Messaging;

let messaging: FirebaseMessaging | null = null;
let initialized = false;

async function getMessaging(): Promise<FirebaseMessaging | null> {
  if (initialized) return messaging;
  initialized = true;

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountJson) {
    log.warn('FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled');
    return null;
  }

  try {
    const admin = await import('firebase-admin');
    const serviceAccount = JSON.parse(serviceAccountJson);

    if (!admin.default.apps.length) {
      admin.default.initializeApp({
        credential: admin.default.credential.cert(serviceAccount),
      });
    }

    messaging = admin.default.messaging();
    log.info('Firebase Admin initialized');
    return messaging;
  } catch (err: any) {
    log.error({ err: err.message }, 'Failed to initialize Firebase Admin');
    return null;
  }
}

export interface PushPayload {
  /** Inglés. Es lo que recibe quien no tiene otro idioma o si falta `es`. */
  title: string;
  body: string;
  /** Español. Se elige por teléfono al enviar; ver `pushLanguage.ts`. */
  es?: Texto;
  data?: Record<string, string>;
  imageUrl?: string;
}

// ── Idioma de cada destinatario ──────────────────────────────────────────────
// Por SQL directo y no por el cliente de Supabase: un aviso masivo lleva miles
// de tokens, y `.in()` los pondría en la URL de la petición.
//
// Ante cualquier fallo —por ejemplo, la columna `language` aún no migrada— se
// devuelve vacío y todo sale en inglés, que es lo que pasaba antes.

async function idiomasDeTokens(tokens: string[]): Promise<Map<string, Idioma>> {
  const idiomas = new Map<string, Idioma>();
  try {
    const { rows } = await pool.query<{ token: string; language: string | null; preferencia: string | null; phone: string | null }>(
      `SELECT t.token, t.language, p.preferences->>'language' AS preferencia, p.phone
         FROM user_push_tokens t
         LEFT JOIN profiles p ON p.id = t.user_id
        WHERE t.token = ANY($1)`,
      [tokens],
    );
    for (const r of rows) {
      idiomas.set(r.token, resolverIdioma({ token: r.language, preferencia: r.preferencia, telefono: r.phone }));
    }
  } catch (err: any) {
    log.warn({ err: err.message }, 'push: no se pudo leer el idioma de los tokens; se envía en inglés');
  }
  return idiomas;
}

/** Idioma del usuario para lo que no va por token: el historial de la app. */
async function idiomaDeUsuario(userId: string): Promise<Idioma> {
  try {
    const { rows } = await pool.query<{ language: string | null; preferencia: string | null; phone: string | null }>(
      `SELECT (SELECT t.language FROM user_push_tokens t
                WHERE t.user_id = p.id AND t.active AND t.language IS NOT NULL
                ORDER BY t.updated_at DESC LIMIT 1) AS language,
              p.preferences->>'language' AS preferencia,
              p.phone
         FROM profiles p
        WHERE p.id = $1`,
      [userId],
    );
    const r = rows[0];
    return resolverIdioma({ token: r?.language, preferencia: r?.preferencia, telefono: r?.phone });
  } catch {
    return 'en';
  }
}

/** Los tokens agrupados por idioma. Sin versión en español no hace falta preguntar. */
async function agruparPorIdioma(tokens: string[], payload: PushPayload): Promise<Map<Idioma, string[]>> {
  if (!payload.es) return new Map([['en', tokens]]);
  const idiomas = await idiomasDeTokens(tokens);
  const grupos = new Map<Idioma, string[]>();
  for (const token of tokens) {
    const idioma = idiomas.get(token) ?? 'en';
    const grupo = grupos.get(idioma);
    if (grupo) grupo.push(token);
    else grupos.set(idioma, [token]);
  }
  return grupos;
}

// ── Per-notification delivery tuning ─────────────────────────────────────────
// Every message used to go out with the same generic options, which was fine
// while iOS push did not work at all. Now that it does, three independent axes
// matter, and conflating them gets it wrong: a chat message deserves immediate
// delivery but must never expire, while a ride offer needs both.

// Delivered immediately rather than batched for battery.
const HIGH_PRIORITY_TYPES = new Set([
  'new_ride',
  'ride_request',
  'scheduled_ride_offer',
  'scheduled_depart',
  'ride_confirmed',
  'driver_arriving_soon',
  'driver_arrived',
  'pickup_pin_verified',
  'ride_started',
  'chat_message',
  'payment_failed',
  'sos_alert',
]);

// Allowed to break through Focus / Do Not Disturb. Reserved for things the user
// is actively waiting on or that cost them money if missed.
const TIME_SENSITIVE_TYPES = new Set([
  'new_ride',
  'ride_request',
  'scheduled_ride_offer',
  'scheduled_depart',
  'driver_arriving_soon',
  'driver_arrived',
  'pickup_pin_verified',
  'payment_failed',
  'sos_alert',
]);

// Worthless if they arrive late, so they are dropped rather than queued. Only
// ride offers: a chat message from ten minutes ago is still worth reading.
const EPHEMERAL_TYPES = new Set([
  'new_ride',
  'ride_request',
  'scheduled_ride_offer',
]);
const EPHEMERAL_TTL_SECONDS = 60;

// Types where only the latest one is worth showing. "Arriving in 2 min" is noise
// once "your ride is here" has landed, and twenty chat pings are worse than one.
// Ride offers are deliberately absent — a driver has to see every distinct offer,
// and FCM only keeps 4 pending collapse keys per device.
const COLLAPSE_GROUPS: Record<string, string> = {
  ride_confirmed:               'ride',
  ride_searching:               'ride',
  driver_arriving_soon:         'ride',
  driver_arrived:               'ride',
  pickup_pin_verified:          'ride',
  ride_started:                 'ride',
  driver_cancelled_reassigning: 'ride',
  chat_message:                 'chat',
};

export function deliveryOptions(payload: PushPayload) {
  // El push del valet reescribe `type` a valet_ride_update y guarda el evento
  // real en `event`. La prioridad tiene que seguir al evento (llegada, PIN).
  const raw = payload.data?.type ?? '';
  const type = raw === 'valet_ride_update' ? (payload.data?.event || raw) : raw;
  const rideId = payload.data?.ride_id;

  const highPriority  = HIGH_PRIORITY_TYPES.has(type);
  const timeSensitive = TIME_SENSITIVE_TYPES.has(type);
  const ephemeral     = EPHEMERAL_TYPES.has(type);

  const group      = COLLAPSE_GROUPS[type];
  const collapseId = group && rideId ? `${group}_${rideId}` : undefined;

  return {
    android: {
      priority: (highPriority ? 'high' : 'normal') as 'high' | 'normal',
      ...(ephemeral ? { ttl: EPHEMERAL_TTL_SECONDS * 1000 } : {}),
      ...(collapseId ? { collapseKey: collapseId } : {}),
      notification: {
        sound: 'default',
        channelId: 'urbont_rides',
      },
    },
    apns: {
      headers: {
        // 'alert' is what makes iOS display the notification while the app is
        // backgrounded or killed. Without it the payload can be treated as a
        // silent background wake and never shown.
        'apns-push-type': 'alert',
        // 10 delivers immediately; 5 is the power-considerate value Apple asks
        // for on anything that is not time critical.
        'apns-priority': highPriority ? '10' : '5',
        ...(ephemeral
          ? { 'apns-expiration': String(Math.floor(Date.now() / 1000) + EPHEMERAL_TTL_SECONDS) }
          : {}),
        ...(collapseId ? { 'apns-collapse-id': collapseId } : {}),
      },
      payload: {
        aps: {
          sound: 'default',
          // Cuts through Focus / Do Not Disturb. iOS ignores it when the app is
          // not signed with the Time Sensitive Notifications entitlement, so it
          // is safe to send either way.
          ...(timeSensitive ? { 'interruption-level': 'time-sensitive' } : {}),
          // Groups every notification of one ride into a single thread.
          ...(rideId ? { threadId: rideId } : {}),
          // No badge on purpose. It was hardcoded to 1, so the icon carried a
          // permanent "1" that matched nothing and never cleared. Real unread
          // counts need the client to reset them — separate change.
        },
      },
    },
  };
}

export async function sendToToken(token: string, payload: PushPayload): Promise<boolean> {
  const fcm = await getMessaging();
  if (!fcm) return false;

  const [idioma] = (await agruparPorIdioma([token], payload)).keys();
  const mensaje = enIdioma(payload, idioma ?? 'en');

  try {
    await fcm.send({
      token,
      notification: {
        title: mensaje.title,
        body: mensaje.body,
        ...(mensaje.imageUrl ? { imageUrl: mensaje.imageUrl } : {}),
      },
      data: mensaje.data ?? {},
      ...deliveryOptions(mensaje),
    });
    return true;
  } catch (err: any) {
    if (err.code === 'messaging/registration-token-not-registered') {
      log.warn({ token: token.slice(-8) }, 'Stale FCM token — removing');
      await invalidateToken(token);
    } else {
      log.error({ err: err.message, token: token.slice(-8) }, 'FCM send error');
    }
    return false;
  }
}

export async function sendMulticast(tokens: string[], payload: PushPayload): Promise<{ sent: number; failed: number }> {
  if (tokens.length === 0) return { sent: 0, failed: 0 };
  const fcm = await getMessaging();
  if (!fcm) return { sent: 0, failed: 0 };

  // FCM sendEachForMulticast handles up to 500 tokens per batch; one set of
  // batches per language, each with its own text.
  const lotes: Array<{ chunk: string[]; mensaje: PushPayload }> = [];
  for (const [idioma, grupo] of await agruparPorIdioma(tokens, payload)) {
    const mensaje = enIdioma(payload, idioma);
    for (let i = 0; i < grupo.length; i += 500) {
      lotes.push({ chunk: grupo.slice(i, i + 500), mensaje });
    }
  }

  let sent = 0;
  let failed = 0;
  const staleTokens: string[] = [];

  for (const { chunk, mensaje } of lotes) {
    const response = await fcm.sendEachForMulticast({
      tokens: chunk,
      notification: {
        title: mensaje.title,
        body: mensaje.body,
        ...(mensaje.imageUrl ? { imageUrl: mensaje.imageUrl } : {}),
      },
      data: mensaje.data ?? {},
      ...deliveryOptions(mensaje),
    });

    sent += response.successCount;
    failed += response.failureCount;

    response.responses?.forEach((r, idx: number) => {
      if (r.success) return;
      if (r.error?.code === 'messaging/registration-token-not-registered') {
        staleTokens.push(chunk[idx]);
        return;
      }
      // Cualquier otro fallo se perdia: el multicast solo devolvia un contador
      // y no habia forma de saber por que no llegaba una notificacion. El codigo
      // distingue entre token invalido, credencial APNs ausente y payload malo.
      log.warn(
        { code: r.error?.code, err: r.error?.message, token: chunk[idx].slice(-8) },
        'FCM token delivery failed',
      );
    });
  }

  if (staleTokens.length > 0) {
    await invalidateTokens(staleTokens);
  }

  log.info({ sent, failed, total: tokens.length }, 'FCM multicast sent');
  return { sent, failed };
}

/**
 * Avisa por push del viaje a los conductores de su zona.
 *
 * `pickupLat`/`pickupLng` son opcionales por compatibilidad: sin ellas no hay
 * zona que comparar y sale a todos los conectados, como antes. Quién entra lo
 * decide `services/dispatchAudience`.
 */
export async function notifyNearbyDrivers(
  rideId: string,
  vehicleType: string,
  pickupAddress: string,
  pickupLat?: number | null,
  pickupLng?: number | null,
  radiusKm = RADIO_KM,
): Promise<void> {
  try {
    // Conductores conectados, sin exigir un ping de GPS reciente.
    //
    // Antes se pedia ademas `updated_at` de los ultimos 15 minutos, y eso
    // rompia justo el caso que el push existe para cubrir: iOS congela la app en
    // cuanto pasa a segundo plano, el intervalo que persiste la posicion se para
    // y `updated_at` se queda clavado. A los 15 minutos el conductor dejaba de
    // ser elegible, asi que no tenia socket (desconectado) ni push (filtrado).
    // Probado el 2026-10-01: 25 minutos en segundo plano y la oferta no llego.
    //
    // La frescura sirve para ordenar por cercania, no para decidir si el aviso
    // sale; de hecho `radiusKm` no se usa y esta funcion no filtra por distancia.
    // A quien cerro la app y no volvio lo cubre `expireStaleOnlineDrivers`, que
    // baja `is_online` tras 8 h sin señal.
    const { data: onlineDrivers, error } = await supabaseAdmin
      .from('driver_locations')
      .select('driver_id, lat, lng, updated_at')
      .eq('is_online', true);

    if (error || !onlineDrivers || onlineDrivers.length === 0) {
      log.info({ rideId }, 'No online drivers to notify');
      return;
    }

    type FilaUbicacion = { driver_id: string; lat: unknown; lng: unknown; updated_at: unknown };
    const filas = (onlineDrivers as unknown as FilaUbicacion[]);
    let driverIds = filas.map(d => d.driver_id);

    // ── Zona (grueso) y distancia (fino). Ver services/dispatchAudience ──────
    // Ante cualquier fallo se avisa a todos, como antes de este filtro.
    try {
      await ensureZonesFresh();
      const zonaDelViaje = typeof pickupLat === 'number' && typeof pickupLng === 'number'
        ? resolveZone(pickupLat, pickupLng)?.id ?? null
        : null;

      if (zonaDelViaje) {
        const { data: perfiles } = await supabaseAdmin
          .from('profiles').select('id, operating_city').in('id', driverIds);
        const ciudadDe = new Map((perfiles ?? []).map((p: Record<string, unknown>) => [String(p.id), (p.operating_city as string) ?? null]));

        const numero = (v: unknown): number | null => {
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        };
        const { avisar, motivos } = audienciaDelViaje(
          filas.map(d => ({
            driverId: d.driver_id,
            lat: numero(d.lat),
            lng: numero(d.lng),
            updatedAt: (d.updated_at as string) ?? null,
            operatingCity: ciudadDe.get(d.driver_id) ?? null,
          })),
          { zonaDelViaje, pickupLat, pickupLng, resolverZona: (la, ln) => resolveZone(la, ln)?.id ?? null, zonas: getZones(), radioKm: radiusKm },
        );
        log.info({ rideId, zona: zonaDelViaje, de: driverIds.length, a: avisar.length, motivos }, 'push: audiencia del viaje');
        driverIds = avisar;
      }
    } catch (filtroErr: unknown) {
      log.warn({ rideId, err: filtroErr instanceof Error ? filtroErr.message : String(filtroErr) }, 'push: no se pudo filtrar por zona; se avisa a todos');
    }

    if (driverIds.length === 0) {
      log.info({ rideId }, 'No drivers in the ride zone to notify');
      return;
    }

    // Get their FCM tokens
    const { data: tokenRows } = await supabaseAdmin
      .from('user_push_tokens')
      .select('user_id, token')
      .in('user_id', driverIds)
      .eq('active', true);

    const tokens = (tokenRows ?? []).map((r: unknown) => (r as { token: string }).token);
    if (tokens.length === 0) {
      log.info({ rideId, driverCount: driverIds.length }, 'Online drivers have no FCM tokens');
      return;
    }

    // Truncate address for notification
    const shortAddress = pickupAddress.length > 60 ? pickupAddress.slice(0, 57) + '...' : pickupAddress;

    await sendMulticast(tokens, {
      title: 'New Ride Request',
      body: `${vehicleType} needed — Pickup: ${shortAddress}`,
      data: {
        type: 'new_ride',
        ride_id: rideId,
        vehicle_type: vehicleType,
        screen: 'ride_offer',
      },
    });
    // Sólo quienes tenían token recibieron la oferta.
    recordRideOffers(rideId, (tokenRows ?? []).map((r: unknown) => (r as { user_id: string }).user_id), 'push');
  } catch (err: any) {
    log.error({ err: err.message, rideId }, 'notifyNearbyDrivers error');
  }
}

// Persist a notification to the in-app notifications table (fire-and-forget)
async function persistNotification(userId: string, payload: PushPayload): Promise<void> {
  try {
    // Se guarda ya traducido: el historial lo lee la app tal cual.
    const mensaje = enIdioma(payload, payload.es ? await idiomaDeUsuario(userId) : 'en');
    await supabaseAdmin.from('notifications').insert({
      user_id:    userId,
      title:      mensaje.title,
      body:       mensaje.body,
      notif_type: mensaje.data?.type ?? 'system',
      type:       mensaje.data?.type ?? 'system',
      read:       false,
      is_read:    false,
      data:    mensaje.data ?? {},
    });
  } catch { /* non-critical — never throw */ }
}

// Notify a specific user (passenger or driver)
export async function notifyUser(
  userId: string,
  payload: PushPayload,
): Promise<void> {
  try {
    // Persist to in-app notification history regardless of FCM status
    persistNotification(userId, payload).catch(() => {});

    const { data: tokenRows } = await supabaseAdmin
      .from('user_push_tokens')
      .select('token')
      .eq('user_id', userId)
      .eq('active', true);

    const tokens = (tokenRows ?? []).map((r: unknown) => (r as { token: string }).token);
    if (tokens.length === 0) return;

    await sendMulticast(tokens, payload);
  } catch (err: any) {
    log.error({ err: err.message, userId }, 'notifyUser error');
  }
}

async function invalidateToken(token: string): Promise<void> {
  await invalidateTokens([token]);
}

async function invalidateTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await supabaseAdmin
    .from('user_push_tokens')
    .update({ active: false })
    .in('token', tokens);
}
