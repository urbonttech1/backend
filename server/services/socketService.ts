import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { createContextLogger } from '../lib/logger';
import { supabaseAdmin } from '../db/client';
import { pool } from '../db/pool';
import { getDriverPriorityTiers } from './driverScore';
import { reassignRide, type ReassignReason } from './rideReassignment';
import { recordRideOffers } from './driverRideHistory';

// ── Redis Adapter (optional — activate by setting REDIS_URL env var) ──────────
// Required for multi-instance / horizontal scaling so all instances share the
// same Socket.IO rooms. Without it, a passenger on instance A won't receive
// events from a driver connected to instance B.
// Install: pnpm add @socket.io/redis-adapter ioredis
let _redisAdapterReady = false;
async function applyRedisAdapter(ioServer: SocketIOServer): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return; // Single-instance mode — in-memory adapter is fine
  try {
    const { createAdapter } = await import('@socket.io/redis-adapter');
    const { default: Redis } = await import('ioredis');
    const pubClient = new Redis(redisUrl, { lazyConnect: false, enableReadyCheck: true });
    const subClient = pubClient.duplicate();
    await Promise.all([
      new Promise<void>((res, rej) => { pubClient.once('ready', res); pubClient.once('error', rej); }),
      new Promise<void>((res, rej) => { subClient.once('ready', res); subClient.once('error', rej); }),
    ]);
    ioServer.adapter(createAdapter(pubClient, subClient));
    _redisAdapterReady = true;
    log.info({ redisUrl: redisUrl.replace(/:\/\/.*@/, '://***@') }, '[REDIS] Socket.IO Redis adapter active — multi-instance ready');
  } catch (err: any) {
    log.error({ err }, '[REDIS] Failed to connect Redis adapter — falling back to in-memory (single-instance only)');
  }
}
export function isRedisAdapterReady(): boolean { return _redisAdapterReady; }

const log = createContextLogger('SOCKET');

let io: SocketIOServer | null = null;
export function getIo(): SocketIOServer | null { return io; }

// Tracks pending reassignment timers keyed by driverId
// Timer fires 5 min after disconnect if driver hasn't reconnected
const pendingReassignTimers = new Map<string, NodeJS.Timeout>();

// ── T001: GPS Inactivity Detection ───────────────────────────────────────────
// If a driver sends no location for GPS_INACTIVITY_MS, they are marked offline
const GPS_INACTIVITY_MS = 10 * 60 * 1000; // 10 minutes
const gpsInactivityTimers = new Map<string, NodeJS.Timeout>();

function resetGpsInactivityTimer(driverId: string, _socketId: string): void {
  const existing = gpsInactivityTimers.get(driverId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    gpsInactivityTimers.delete(driverId);
    log.warn({ driverId }, '[GPS_INACTIVITY] No location for 10 min — marking driver offline');
    try {
      await supabaseAdmin.from('driver_locations').update({
        is_online:  false,
        updated_at: new Date().toISOString(),
      }).eq('driver_id', driverId);
      io?.to('nearby_drivers_broadcast').emit('driver:went_offline', { driverId, reason: 'gps_inactivity' });
    } catch {}
  }, GPS_INACTIVITY_MS);

  gpsInactivityTimers.set(driverId, timer);
}

// ── T014: Stop Detection ─────────────────────────────────────────────────────
// During in_progress rides: if driver location doesn't change >50m in 5 min → alert
const STOP_DETECTION_MS    = 5 * 60 * 1000; // 5 minutes
const STOP_DISTANCE_METERS = 50;
interface LocationPoint { lat: number; lng: number; ts: number; }
const driverLastLocation = new Map<string, LocationPoint>();
const stopDetectionTimers = new Map<string, NodeJS.Timeout>();

// ── T022: Route Deviation Detection ──────────────────────────────────────────
// If driver strays >500m from any planned route point mid-trip → alert passenger
const ROUTE_DEVIATION_THRESHOLD_M = 500;
interface RoutePoint { lat: number; lng: number; }
const rideRouteCache = new Map<string, RoutePoint[]>(); // rideId → waypoints
const deviationAlerted = new Set<string>();              // rideIds already alerted

/** Called by rides.ts (or frontend socket event) to register the planned route */
export function setRouteForRide(rideId: string, waypoints: RoutePoint[]): void {
  rideRouteCache.set(rideId, waypoints);
  deviationAlerted.delete(rideId); // reset on new route
}

export function clearRouteForRide(rideId: string): void {
  rideRouteCache.delete(rideId);
  deviationAlerted.delete(rideId);
}

function minDistanceToRoute(point: LocationPoint, route: RoutePoint[]): number {
  if (route.length === 0) return Infinity;
  let min = Infinity;
  for (const wp of route) {
    const d = haversineMeters(point, { ...wp, ts: 0 });
    if (d < min) min = d;
  }
  return min;
}

// Distance below which we consider the driver "back on route" and allow re-alerting
const ROUTE_BACK_ON_TRACK_M = 150;

function checkRouteDeviation(driverId: string, rideId: string, loc: LocationPoint): void {
  const route = rideRouteCache.get(rideId);
  if (!route || route.length === 0) return;
  const dist = minDistanceToRoute(loc, route);

  // If driver was previously alerted but has returned close to the route,
  // clear the alert flag so a subsequent deviation triggers a fresh alert.
  if (deviationAlerted.has(rideId) && dist <= ROUTE_BACK_ON_TRACK_M) {
    deviationAlerted.delete(rideId);
    log.info({ driverId, rideId, distMeters: Math.round(dist) }, '[ROUTE_DEV] Driver back on route — deviation alert reset');
    return;
  }

  if (deviationAlerted.has(rideId)) return; // already alerted, still off-route

  if (dist > ROUTE_DEVIATION_THRESHOLD_M) {
    deviationAlerted.add(rideId);
    log.warn({ driverId, rideId, distMeters: Math.round(dist) }, '[ROUTE_DEV] Driver deviated >500m from planned route');
    io?.to(`ride:${rideId}`).emit('ride:route_deviation', {
      rideId,
      driverId,
      distanceMeters: Math.round(dist),
      message: 'Your driver has deviated from the planned route. We are monitoring the situation.',
      ts: Date.now(),
    });
  }
}

function haversineMeters(a: LocationPoint, b: LocationPoint): number {
  const R = 6_371_000; // Earth radius in meters
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const c = 2 * Math.atan2(
    Math.sqrt(sinDLat * sinDLat + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * sinDLng * sinDLng),
    Math.sqrt(1 - sinDLat * sinDLat - Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * sinDLng * sinDLng),
  );
  return R * c;
}

function checkStopDetection(driverId: string, rideId: string, newLoc: LocationPoint): void {
  const prev = driverLastLocation.get(driverId);
  const distMoved = prev ? haversineMeters(prev, newLoc) : Infinity;

  if (distMoved > STOP_DISTANCE_METERS) {
    // Driver moved — reset stop timer and update last position
    driverLastLocation.set(driverId, newLoc);
    const existing = stopDetectionTimers.get(driverId);
    if (existing) clearTimeout(existing);
    stopDetectionTimers.delete(driverId);
    return;
  }

  // Driver hasn't moved much — start stop timer if not already running
  if (!stopDetectionTimers.has(driverId)) {
    const timer = setTimeout(async () => {
      stopDetectionTimers.delete(driverId);
      log.warn({ driverId, rideId }, '[STOP_DETECT] Driver stopped for 5 min mid-trip');
      // Alert passenger
      try {
        const { data: ride } = await supabaseAdmin
          .from('rides')
          .select('passenger_id')
          .eq('id', rideId)
          .maybeSingle();
        if (ride) {
          io?.to(`ride:${rideId}`).emit('ride:stop_detected', {
            rideId,
            driverId,
            message: 'Your driver appears to have stopped. We are monitoring the situation.',
            ts: Date.now(),
          });
        }
      } catch {}
    }, STOP_DETECTION_MS);
    stopDetectionTimers.set(driverId, timer);
  }
}

export function initSocketIO(httpServer: HttpServer): SocketIOServer {
  // Allow all origins — the app is served from the same Hyperlift domain as the
  // server, so the socket connection is same-origin. For mobile/web clients from
  // any domain, we allow all to avoid stale URL mismatches breaking connections.
  const SOCKET_ALLOWED_ORIGINS = [
    'https://app.urbont.com',
    'https://www.urbont.com',
    'https://urbont.com',
    // ── Orígenes nativos de Capacitor ────────────────────────────────────────
    // La app ya no carga app.urbont.com: las pantallas viajan dentro del APK y
    // Capacitor las sirve desde el propio teléfono.
    'capacitor://localhost',   // iOS, y algunas configuraciones de Android
    'https://localhost',       // Android con androidScheme: 'https' — el habitual
    'http://localhost',        // Android con androidScheme: 'http'
    'ionic://localhost',       // Ionic y versiones antiguas de Capacitor
    // ─────────────────────────────────────────────────────────────────────────
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:8080',
    // Dynamic env-var origins (Hyperlift preview, staging, custom domain)
    ...(process.env.APP_URL ? [process.env.APP_URL] : []),
    ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()) : []),
  ];

  // Allow wildcard patterns for preview and staging domains
  const SOCKET_ALLOWED_PATTERNS = [
    /^https:\/\/[a-z0-9-]+\.hyperlift\.app$/,
    /^https:\/\/[a-z0-9-]+\.urbont\.app$/,
  ];

  io = new SocketIOServer(httpServer, {
    cors: {
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        if (!origin) {
          // No origin — same-origin requests (server-side, mobile native, Capacitor)
          callback(null, true);
          return;
        }
        // Igualdad exacta, nunca `startsWith`.
        //
        // Antes esto era `origin === o || origin.startsWith(o)`, y ese segundo
        // término dejaba pasar `http://localhost.evil.com` —empieza por
        // `http://localhost`— y también `https://app.urbont.com.evil.com`.
        // Cualquiera que registrara uno de esos dominios abría un socket contra
        // la API con credenciales. Un origen es una cadena completa o no es.
        const exactMatch = SOCKET_ALLOWED_ORIGINS.includes(origin);
        const patternMatch = SOCKET_ALLOWED_PATTERNS.some(p => p.test(origin));
        if (exactMatch || patternMatch) {
          callback(null, true);
        } else {
          log.warn({ origin }, 'Socket.IO CORS: blocked unknown origin');
          callback(null, false);
        }
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 30000,
    pingInterval: 10000,
  });

  // Apply Redis adapter asynchronously — does not block server startup.
  // If REDIS_URL is not set, this is a no-op and in-memory adapter is used.
  void applyRedisAdapter(io);

  // ── JWT verification middleware ───────────────────────────────────────────
  // Verifies the Supabase access token from socket.handshake.auth.token.
  // Non-blocking: invalid/missing tokens are allowed through (backward-compatible
  // with clients that don't yet send a token) but flagged as unverified.
  // When SUPABASE_JWT_SECRET is set, the verified userId is attached to the socket
  // and used to cross-check the client-supplied userId field.
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (token) {
      try {
        const { default: jwt } = await import('jsonwebtoken');
        const secret = process.env.SUPABASE_JWT_SECRET;
        if (secret) {
          const decoded = jwt.verify(token, secret) as { sub?: string };
          (socket as unknown as Record<string,unknown>).verifiedUserId = decoded.sub ?? null;
        }
      } catch {
        log.warn({ socketId: socket.id }, '[SOCKET] Presented JWT token failed verification');
      }
    }
    next();
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.handshake.auth?.userId as string | undefined;
    const userRole = socket.handshake.auth?.role as string | undefined;

    log.info({ socketId: socket.id, userId, userRole }, 'client connected');

    // Cancel any pending reassignment timer if this driver just reconnected
    if (userId && pendingReassignTimers.has(userId)) {
      clearTimeout(pendingReassignTimers.get(userId)!);
      pendingReassignTimers.delete(userId);
      log.info({ userId }, '[reconnect] Driver reconnected — reassignment timer cancelled');

      // Mark driver back online in DB
      void (async () => {
        try {
          await supabaseAdmin
            .from('driver_locations')
            .update({ is_online: true, updated_at: new Date().toISOString() })
            .eq('driver_id', userId);
        } catch { /* fire-and-forget */ }
      })();
    }

    // Multi-instance room routing: each authenticated user and driver joins their dedicated room
    if (userId) {
      socket.join(`user:${userId}`);
      if (userRole === 'driver' || userRole === 'chauffeur') {
        socket.join(`driver:${userId}`);
        registerDriverSocket(userId, socket.id);
      }
    }

    // ── Ride room management ─────────────────────────────────────────────────

    socket.on('join:ride', async (rideId: string) => {
      if (!rideId) return;
      await socket.join(`ride:${rideId}`);
      log.info({ socketId: socket.id, userId, rideId }, 'joined ride room');
      socket.emit('joined:ride', { rideId });

      // Catch-up: emit the current ride status immediately so this socket
      // doesn't miss any status change that happened before it joined the room.
      // This fixes the race where a driver accepts while the passenger socket
      // was still connecting / not yet in the room.
      try {
        const { data: rideSnap } = await supabaseAdmin
          .from('rides')
          .select('ride_status, driver_id, passenger_id')
          .eq('id', rideId)
          .maybeSingle();
        if (rideSnap) {
          const snap = rideSnap as { ride_status: string; driver_id: string | null; passenger_id: string | null };
          const catchUpPayload = {
            rideId,
            status: snap.ride_status,
            driverId: snap.driver_id ?? undefined,
            passengerId: snap.passenger_id ?? undefined,
          };
          // Emit both event names for backward compatibility with older client versions
          // that may only listen to ride:status_update (Capacitor builds cached before the rename).
          socket.emit('ride:status_changed', catchUpPayload);
          socket.emit('ride:status_update', catchUpPayload);
          log.info({ socketId: socket.id, rideId, status: snap.ride_status }, 'catch-up status emitted on room join');

          // ── Private chat room ──────────────────────────────────────────────
          // `ride:${rideId}` above is intentionally joinable by anyone who knows
          // the ride's UUID — it's what powers the public "track my ride" share
          // link (GPS + status only, no login required, by design). Chat is NOT
          // meant to be link-shareable, so only join the chat room for sockets
          // whose authenticated userId actually matches this ride's passenger,
          // driver, or an admin. The public tracking page connects with no
          // userId, so it's naturally excluded here — no client changes needed.
          const isParticipant = !!userId && (userId === snap.passenger_id || userId === snap.driver_id);
          if (isParticipant || userRole === 'admin') {
            await socket.join(`ride-chat:${rideId}`);
          }
        }
      } catch (err: any) {
        log.warn({ err: err?.message, rideId }, 'catch-up status fetch failed');
      }
    });

    socket.on('leave:ride', async (rideId: string) => {
      await socket.leave(`ride:${rideId}`);
      await socket.leave(`ride-chat:${rideId}`);
      log.info({ socketId: socket.id, userId, rideId }, 'left ride room');
    });

    // ── T022: Passenger/app registers planned route for deviation detection ──
    socket.on('ride:set_route', (payload: { rideId: string; waypoints: RoutePoint[] }) => {
      if (!payload?.rideId || !Array.isArray(payload.waypoints)) return;
      setRouteForRide(payload.rideId, payload.waypoints);
      log.info({ rideId: payload.rideId, points: payload.waypoints.length }, '[ROUTE_DEV] Route registered');
    });

    // ── Driver: real-time location push ─────────────────────────────────────
    // Driver emits location; server relays to the ride room instantly.
    // Simultaneously, the HTTP /api/drivers/location endpoint persists to DB.

    socket.on('driver:location', async (payload: {
      rideId?: string;
      lat: number;
      lng: number;
      heading: number;
      speed: number;
      rideStatus?: string;
    }) => {
      if (!userId || !payload.lat || !payload.lng) return;

      // ── T001: Reset GPS inactivity timer on every location update ───────────
      resetGpsInactivityTimer(userId, socket.id);

      // Broadcast location to every listener in the ride room
      if (payload.rideId) {
        socket.to(`ride:${payload.rideId}`).emit('location:driver_update', {
          driverId: userId,
          lat: payload.lat,
          lng: payload.lng,
          heading: payload.heading ?? 0,
          speed: payload.speed ?? 0,
          ts: Date.now(),
        });

        // ── T014: Stop detection during in_progress rides ────────────────────
        if (payload.rideStatus === 'in_progress' || payload.rideStatus === 'in-progress') {
          const loc = { lat: payload.lat, lng: payload.lng, ts: Date.now() };
          checkStopDetection(userId, payload.rideId, loc);
          // ── T022: Route deviation detection ────────────────────────────────
          checkRouteDeviation(userId, payload.rideId, loc);
        } else {
          // Not in progress — clear any stop detection for this driver
          const t = stopDetectionTimers.get(userId);
          if (t) { clearTimeout(t); stopDetectionTimers.delete(userId); }
        }
      }

      // Also broadcast to passengers watching the booking map
      io?.to('nearby_drivers_broadcast').emit('driver:nearby_update', {
        driverId: userId,
        lat: payload.lat,
        lng: payload.lng,
        heading: payload.heading ?? 0,
        speed: payload.speed ?? 0,
        ts: Date.now(),
      });

      // Also persist to DB asynchronously (non-blocking)
      persistDriverLocation(userId, payload).catch(() => {});
    });

    // ── Passenger: subscribe to nearby driver updates ────────────────────────
    socket.on('passenger:watch_nearby', () => {
      socket.join('nearby_drivers_broadcast');
    });

    socket.on('passenger:leave_nearby', () => {
      socket.leave('nearby_drivers_broadcast');
    });

    // ── Ride status broadcast ────────────────────────────────────────────────

    socket.on('driver:join_availability', (data?: { vehicleCategory?: string }) => {
      if (userRole === 'driver' || userRole === 'chauffeur') {
        // Join the global pool
        socket.join('available_drivers');
        // Join the category-specific pool (from event payload or socket auth)
        const category = (data?.vehicleCategory || (socket.handshake.auth as Record<string, unknown>).vehicleCategory || '').toString().toLowerCase();
        if (category) {
          const normalizedCat = normalizeVehicleCategory(category);
          const catRoom = vehicleCategoryRoom(category);
          socket.join(catRoom);
          log.info({ userId, category, normalizedCat, catRoom }, 'driver joined category room');

          // ── Uber-style vehicle upgrade logic ─────────────────────────────────
          // SUV drivers can also serve sedan (Business Class) bookings — a larger
          // vehicle can accommodate passengers who requested a smaller class.
          // Sedan drivers cannot accept SUV bookings (insufficient seats).
          if (normalizedCat === 'suv') {
            socket.join('available_drivers:executive'); // receives Business Class ride pushes
            log.info({ userId }, 'SUV driver also joined executive room (upgrade logic)');
          }
          // First Class (signature) drivers can serve SUV and sedan bookings
          if (normalizedCat === 'signature') {
            socket.join('available_drivers:suv');
            socket.join('available_drivers:executive');
            log.info({ userId }, 'First Class driver also joined suv+executive rooms (upgrade logic)');
          }
          // Van drivers can serve any booking class (most capacity)
          if (normalizedCat === 'van') {
            socket.join('available_drivers:suv');
            socket.join('available_drivers:executive');
            log.info({ userId }, 'Van driver also joined suv+executive rooms (upgrade logic)');
          }
        }
        if (userId) registerDriverSocket(userId, socket.id, category || undefined);

        // Re-assert online status in the DB every time the driver (re)joins the
        // pool — including on socket.io's automatic reconnects after the app was
        // backgrounded. Without this, a brief disconnect (app switch) flips
        // is_online to false on the 'disconnect' handler and nothing guaranteed
        // to flip it back, so the driver reopens the app to find themselves
        // shown as offline even though they never toggled it off.
        if (userId) {
          void (async () => {
            try {
              await supabaseAdmin
                .from('driver_locations')
                .update({ is_online: true, updated_at: new Date().toISOString() })
                .eq('driver_id', userId);
            } catch { /* fire-and-forget */ }
          })();
        }
        log.info({ userId, category }, 'driver joined availability pool');
      }
    });

    socket.on('driver:leave_availability', () => {
      socket.leave('available_drivers');
      // Leave all category rooms
      for (const cat of ['signature', 'executive', 'suv', 'van', 'concierge']) {
        socket.leave(`available_drivers:${cat}`);
      }
      if (userId) {
        unregisterDriverSocket(userId);
        // Notify nearby passenger watchers that this driver is no longer available
        io?.to('nearby_drivers_broadcast').emit('driver:went_offline', { driverId: userId });
      }
      log.info({ userId }, 'driver left availability pool');
    });

    // ── Driver arrived at pickup — relay to passenger instantly ─────────────
    socket.on('driver:arrived', (payload: { rideId: string }) => {
      if (!payload.rideId || !userId) return;
      socket.to(`ride:${payload.rideId}`).emit('ride:driver_arrived', {
        rideId: payload.rideId,
        driverId: userId,
        ts: Date.now(),
      });
      log.info({ rideId: payload.rideId, userId }, 'driver:arrived → ride:driver_arrived broadcast');
    });

    socket.on('disconnect', () => {
      if (userId) {
        unregisterDriverSocket(userId);
        io?.to('nearby_drivers_broadcast').emit('driver:went_offline', { driverId: userId });

        // Mark driver offline in DB immediately so the watchdog can detect it
        void (async () => {
          try {
            await supabaseAdmin
              .from('driver_locations')
              .update({ is_online: false, updated_at: new Date().toISOString() })
              .eq('driver_id', userId);
          } catch { /* fire-and-forget */ }
        })();

        // Grace period: if driver doesn't reconnect within 5 min and has an active ride → reassign
        const gracePeriodMs = 5 * 60 * 1000;
        const timer = setTimeout(async () => {
          // Check if driver reconnected in the meantime
          if (driverSocketMap.has(userId)) return; // driver is back online

          try {
            const { data: activeRides } = await supabaseAdmin
              .from('rides')
              .select('id, driver_id, ride_status')
              .eq('driver_id', userId)
              .in('ride_status', ['confirmed', 'in_progress'])
              .limit(1);

            if (activeRides?.length) {
              const ride = activeRides[0] as { id: string; driver_id: string; ride_status: string };
              log.warn({ rideId: ride.id, userId }, '[socket] Driver offline 5 min with active ride — reassigning');
              await reassignRide(ride.id, 'driver_disconnected' as ReassignReason, userId);
            }
          } catch (err: any) {
            log.error({ err: err?.message, userId }, '[socket] Grace period reassign error');
          }
        }, gracePeriodMs);

        // Clear any previous timer (edge case: rapid disconnect/reconnect/disconnect)
        const existing = pendingReassignTimers.get(userId);
        if (existing) clearTimeout(existing);
        pendingReassignTimers.set(userId, timer);

        // T001: Clear GPS inactivity timer on disconnect (offline already)
        const inactivityTimer = gpsInactivityTimers.get(userId);
        if (inactivityTimer) { clearTimeout(inactivityTimer); gpsInactivityTimers.delete(userId); }

        // T014: Clear stop detection timer on disconnect
        const stopTimer = stopDetectionTimers.get(userId);
        if (stopTimer) { clearTimeout(stopTimer); stopDetectionTimers.delete(userId); }
        driverLastLocation.delete(userId);
      }
      log.info({ socketId: socket.id, userId }, 'client disconnected');
    });
  });

  log.info('Socket.IO server initialized');
  return io;
}

export function broadcastRideStatus(rideId: string, status: string, extra: Record<string, unknown> = {}) {
  if (!io) return;
  const payload = { rideId, status, ...extra };

  // ── Room broadcast (passenger + any other subscriber in the ride room) ──────
  // Only emit ride:status_changed — the authoritative event name.
  // ride:status_update was a legacy alias that caused double-processing on the
  // frontend (useRealtimeRide listens to both). Removed from broadcast to prevent
  // duplicate state updates and unnecessary re-renders.
  io.to(`ride:${rideId}`).emit('ride:status_changed', payload);

  // ── Direct delivery to driver socket ────────────────────────────────────────
  // The driver dashboard does NOT join the ride room (it only joins the driver
  // availability rooms).  We use the driverSocketMap registry to deliver the
  // event directly to the driver's connected socket so they receive it even
  // without being in the ride room.
  // NOTE: In multi-instance deployments (Redis adapter), ensure all instances
  // share the same driverSocketMap via Redis — the current in-memory map only
  // works reliably on a single server instance.
  const driverId = (extra.driverId as string | undefined) ?? '';
  if (driverId) {
    // Deliver to driver's room (propagates to all instances via Redis adapter)
    io.to(`driver:${driverId}`).emit('ride:status_changed', payload);
    const driverSocketId = driverSocketMap.get(driverId);
    if (driverSocketId) {
      log.info({ rideId, status, driverId, driverSocketId }, 'direct driver socket delivery');
      io.sockets.sockets.get(driverSocketId)?.join(`ride-chat:${rideId}`);
    }

    // ── Terminal state cleanup ─────────────────────────────────────────────────
    // When a ride reaches a terminal status, proactively clear all per-driver
    // timers so they cannot fire against an already-closed ride room.
    // Without this, the stop-detection timer could fire after completion and
    // emit ride:stop_detected to a dead room; the GPS inactivity timer could
    // trigger a spurious driver_inactive reassignment event on a finished ride.
    if (status === 'completed' || status === 'cancelled') {
      const stopTimer = stopDetectionTimers.get(driverId);
      if (stopTimer) { clearTimeout(stopTimer); stopDetectionTimers.delete(driverId); }
      const gpsTimer = gpsInactivityTimers.get(driverId);
      if (gpsTimer) { clearTimeout(gpsTimer); gpsInactivityTimers.delete(driverId); }
      log.info({ rideId, status, driverId }, 'cleared stop/GPS timers on terminal ride status');
    }
  }

  log.info({ rideId, status }, 'broadcast ride status');
}

export function broadcastChatMessage(rideId: string, msg: {
  id: string;
  senderRole: string;
  originalText: string;
  translatedText?: string;
  createdAt: string;
}): void {
  if (!io) return;
  // Private room — only sockets whose authenticated userId matched this
  // ride's passenger/driver (or an admin) get joined to this room. See the
  // join:ride handler above. Do NOT switch this back to the public
  // `ride:${rideId}` room — that one is intentionally joinable by anyone
  // with the ride's UUID (public tracking links) and must never carry chat.
  io.to(`ride-chat:${rideId}`).emit('chat:new_message', { rideId, ...msg });
}

export function getIO(): SocketIOServer | null {
  return io;
}

// ── Driver socket registry ───────────────────────────────────────────────────
// driverId → socketId mapping for targeted dispatch
const driverSocketMap = new Map<string, string>();
// driverId → vehicleCategory (business | suv | concierge | any)
const driverVehicleMap = new Map<string, string>();

export function registerDriverSocket(driverId: string, socketId: string, vehicleCategory?: string) {
  driverSocketMap.set(driverId, socketId);
  if (vehicleCategory) driverVehicleMap.set(driverId, vehicleCategory.toLowerCase());
}
export function unregisterDriverSocket(driverId: string) {
  driverSocketMap.delete(driverId);
  driverVehicleMap.delete(driverId);
}

// ── Vehicle type → driver category normalization ─────────────────────────────
// Both the passenger's ride vehicle type ("Business Class", "SUV XL") and the
// driver's profile category ("executive", "suv", "concierge") are normalized
// to a canonical key so they can be compared reliably.
export function normalizeVehicleCategory(vehicleType: string): string {
  const t = vehicleType.toLowerCase().trim();
  // First Class / Signature — must check before 'suv' because "suv-lx" contains 'first class'
  if (t === 'signature' || t.includes('first class') || t.includes('first-class') || t === 'suv-lx') return 'signature';
  // Business Class / Sedan / Executive — "sedan" is the driver-profile category stored by vehicleData.ts
  if (t === 'sedan' || t === 'executive' || t.includes('business')) return 'executive';
  // SUV
  if (t === 'suv' || t.includes('suv')) return 'suv';
  // Van / Sprinter
  if (t === 'van' || t.includes('van') || t.includes('sprinter')) return 'van';
  // Concierge / Luxury
  if (t.includes('concierge') || t.includes('luxury')) return 'concierge';
  return t;
}

// Returns the Socket.IO room name for a given vehicle type or driver category
function vehicleCategoryRoom(vehicleType: string): string {
  const cat = normalizeVehicleCategory(vehicleType);
  if (cat === 'signature')  return 'available_drivers:signature';
  if (cat === 'executive')  return 'available_drivers:executive';
  if (cat === 'suv')        return 'available_drivers:suv';
  if (cat === 'van')        return 'available_drivers:van';
  if (cat === 'concierge')  return 'available_drivers:concierge';
  return 'available_drivers';
}

// ── Haversine distance in km ─────────────────────────────────────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Distance-aware dispatch ───────────────────────────────────────────────────
// When pickup coordinates are available:
//   Wave 0 (immediate) : connected drivers within  5 km of pickup
//   Wave 1 (4 s delay) : connected drivers within 15 km of pickup not yet notified
//   Wave 2 (8 s delay) : all remaining connected drivers (catchall)
//
// When coordinates are unavailable, falls back to score-based priority tiers.
//
export function notifyAvailableDrivers(
  rideId: string,
  vehicleType: string,
  pickupAddress: string,
  pickupLat?: number | null,
  pickupLng?: number | null,
) {
  if (!io) return;

  const payload = { rideId, vehicleType, pickupAddress, ts: Date.now() };
  const hasCoords = typeof pickupLat === 'number' && typeof pickupLng === 'number';

  if (hasCoords) {
    // ── True wave dispatch (Uber-style): nearest + highest-score drivers FIRST.
    // We deliberately do NOT broadcast to category/global rooms at t=0, because
    // doing so would let every driver race for the request and nullify the
    // priority/score system. The waves below escalate over ~15s if no top
    // driver accepts, and a final room broadcast acts as a safety net.
    dispatchByDistance(rideId, vehicleType, pickupAddress, pickupLat!, pickupLng!, payload);
  } else {
    // ── No coords: fall back to score-based priority waves ─────────────────
    log.info({ rideId, vehicleType }, 'no coords — score-based dispatch only');
    dispatchByScore(rideId, payload);
  }

  log.info({ rideId, vehicleType, hasCoords, poolSize: driverSocketMap.size }, 'dispatch started');
}

async function dispatchByDistance(
  rideId: string,
  vehicleType: string,
  pickupAddress: string,
  pickupLat: number,
  pickupLng: number,
  payload: object,
) {
  if (!io) return;

  // ── 1) Pull driver locations (only those with a recent ping) ─────────────
  let nearbyRows: Array<{ driver_id: string; lat: number; lng: number; distance_km: number }> = [];
  try {
    const { data, error } = await supabaseAdmin.rpc('find_nearby_drivers', {
      ref_lat: pickupLat,
      ref_lng: pickupLng,
    });
    if (!error && data) {
      nearbyRows = (data as Record<string, unknown>[]).map((r) => ({
        driver_id: String(r.driver_id),
        lat: Number(r.lat),
        lng: Number(r.lng),
        distance_km: Number(r.distance_km),
      }));
    } else if (error) {
      throw error;
    }
  } catch (err: any) {
    log.warn({ err: err?.message }, 'find_nearby_drivers RPC failed — fallback to pool.query');
    try {
      const result = await pool.query(`
        SELECT driver_id, lat, lng
        FROM driver_locations
        WHERE is_online = true
          AND updated_at >= NOW() - INTERVAL '5 minutes'
      `);
      nearbyRows = result.rows.map(r => {
        const dist = haversineKm(pickupLat, pickupLng, parseFloat(r.lat), parseFloat(r.lng));
        return {
          driver_id: r.driver_id,
          lat: parseFloat(r.lat),
          lng: parseFloat(r.lng),
          distance_km: Math.round(dist * 10) / 10,
        };
      });
    } catch (fallbackErr: unknown) {
      const fallbackErrMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      log.error({ err: fallbackErrMessage }, 'driver_locations fallback query failed');
    }
  }

  // ── 2) Pull priority scores for connected drivers (score = quality signal) ─
  const connectedDrivers = Array.from(driverSocketMap.entries()); // [driverId, socketId]
  const connectedIds     = connectedDrivers.map(([id]) => id);

  const scoreMap = new Map<string, number>();
  if (connectedIds.length > 0) {
    try {
      const { data: profiles } = await supabaseAdmin
        .from('profiles')
        .select('id,priority_score,is_blocked')
        .in('id', connectedIds);
      for (const p of profiles ?? []) {
        if (p.is_blocked) continue;
        scoreMap.set(p.id, parseFloat(p.priority_score ?? '1.0'));
      }
    } catch (err: any) {
      log.warn({ err: err?.message }, 'priority_score fetch failed — using default 1.0');
    }
  }

  // ── 3) Build candidate list: only connected, non-blocked drivers ─────────
  // effectiveScore (lower = better): distance penalty minus score reward.
  // A top driver (score 1.5) gets a 0.5 km "bonus" over a normal driver
  // (score 1.0), so quality slightly outweighs raw proximity.
  const nearbyMap = new Map(nearbyRows.map(r => [r.driver_id, r.distance_km]));

  type Candidate = { driverId: string; socketId: string; distanceKm: number; score: number; effective: number };
  const candidates: Candidate[] = [];
  for (const [driverId, socketId] of connectedDrivers) {
    if (connectedIds.length > 0 && !scoreMap.has(driverId)) continue; // blocked or unknown
    const distanceKm = nearbyMap.get(driverId) ?? 999;
    const score      = scoreMap.get(driverId) ?? 1.0;
    candidates.push({
      driverId,
      socketId,
      distanceKm,
      score,
      effective: distanceKm - score, // lower is better
    });
  }
  candidates.sort((a, b) => a.effective - b.effective);

  const notifiedIds = new Set<string>();
  const bumpRequestCount = (ids: string[]) => {
    if (ids.length === 0) return;
    pool.query(
      `UPDATE profiles SET total_requests_received = COALESCE(total_requests_received, 0) + 1 WHERE id = ANY($1::uuid[])`,
      [ids],
    ).catch(() => {});
  };

  const sendWave = (cands: Candidate[], waveLabel: string) => {
    if (!io || cands.length === 0) return;
    for (const c of cands) {
      if (notifiedIds.has(c.driverId)) continue;
      io.to(c.socketId).emit('ride:new_request', payload);
      // Multi-instance delivery: ensures driver on any Cloud Run instance receives dispatch
      io.to(`driver:${c.driverId}`).emit('ride:new_request', payload);
      notifiedIds.add(c.driverId);
    }
    bumpRequestCount(cands.map(c => c.driverId).filter(id => notifiedIds.has(id)));
    recordRideOffers(rideId, cands.map(c => c.driverId).filter(id => notifiedIds.has(id)), 'socket');
    log.info(
      { rideId, wave: waveLabel, count: cands.length, topDist: cands[0]?.distanceKm, topScore: cands[0]?.score },
      `wave dispatch ${waveLabel}`,
    );
  };

  // ── Wave 1 (t=0): top 3 candidates — exclusive window for best driver ─────
  // This is the heart of Uber-style wave dispatch: the best chofer gets first
  // dibs and ~5 seconds to respond before anyone else is even notified.
  const wave1 = candidates.slice(0, 3);
  sendWave(wave1, '1 (top 3)');

  // ── Wave 2 (t=5s): next batch of drivers within 5 km ─────────────────────
  setTimeout(() => {
    const wave2 = candidates
      .filter(c => !notifiedIds.has(c.driverId) && c.distanceKm <= 5)
      .slice(0, 7);
    sendWave(wave2, '2 (≤5 km)');
  }, 5000);

  // ── Wave 3 (t=10s): drivers within 15 km ─────────────────────────────────
  setTimeout(() => {
    const wave3 = candidates.filter(c => !notifiedIds.has(c.driverId) && c.distanceKm <= 15);
    sendWave(wave3, '3 (≤15 km)');
  }, 10000);

  // ── Wave 4 (t=15s): everyone else + room safety net ──────────────────────
  setTimeout(() => {
    if (!io) return;
    const wave4 = candidates.filter(c => !notifiedIds.has(c.driverId));
    sendWave(wave4, '4 (all remaining)');
    // Catch any driver who connected after dispatch started (unrouted to the
    // socket map yet) and any category-specific subscribers we missed.
    const catRoom = vehicleCategoryRoom(vehicleType);
    io.to(catRoom).emit('ride:new_request', payload);
    io.to('available_drivers').emit('ride:new_request', payload);
    log.info({ rideId, catRoom }, 'wave dispatch safety-net broadcast');
  }, 15000);
}

function dispatchByScore(rideId: string, payload: object) {
  if (!io) return;
  getDriverPriorityTiers()
    .then(({ top, mid, normal }) => {
      if (!io) return;

      // Wave 1 — top priority drivers (score >= 1.3)
      let wave1Count = 0;
      for (const driverId of top) {
        const sid = driverSocketMap.get(driverId);
        if (sid) { io.to(sid).emit('ride:new_request', payload); }
        io.to(`driver:${driverId}`).emit('ride:new_request', payload);
        wave1Count++;
      }
      log.info({ rideId, wave: 1, tier: top.length, sent: wave1Count }, 'score wave 1');
      recordRideOffers(rideId, top, 'socket');

      // Wave 2 — mid priority drivers (score 0.7 – 1.3)
      setTimeout(() => {
        if (!io) return;
        let wave2Count = 0;
        for (const driverId of mid) {
          const sid = driverSocketMap.get(driverId);
          if (sid) { io.to(sid).emit('ride:new_request', payload); }
          io.to(`driver:${driverId}`).emit('ride:new_request', payload);
          wave2Count++;
        }
        log.info({ rideId, wave: 2, tier: mid.length, sent: wave2Count }, 'score wave 2');
        recordRideOffers(rideId, mid, 'socket');
      }, 4000);

      // Wave 3 — lower priority drivers (score < 0.7)
      setTimeout(() => {
        if (!io) return;
        let wave3Count = 0;
        for (const driverId of normal) {
          const sid = driverSocketMap.get(driverId);
          if (sid) { io.to(sid).emit('ride:new_request', payload); }
          io.to(`driver:${driverId}`).emit('ride:new_request', payload);
          wave3Count++;
        }
        log.info({ rideId, wave: 3, tier: normal.length, sent: wave3Count }, 'score wave 3');
        recordRideOffers(rideId, normal, 'socket');
      }, 8000);
    })
    .catch((err) => {
      log.warn({ rideId, err: err?.message }, 'priority tier fetch failed');
    });
}

// ── Persist driver location to DB (fire-and-forget) ─────────────────────────

async function persistDriverLocation(driverId: string, pos: { lat: number; lng: number; heading: number; speed: number }) {
  try {
    await supabaseAdmin.rpc('upsert_driver_location', {
      p_driver_id: driverId,
      p_lat: pos.lat,
      p_lng: pos.lng,
      p_heading: pos.heading ?? 0,
      p_speed: pos.speed ?? 0,
    });
  } catch {
    // If RPC doesn't exist yet, fall back to table upsert
    await supabaseAdmin.from('driver_locations').upsert({
      driver_id: driverId,
      lat: pos.lat,
      lng: pos.lng,
      heading: pos.heading ?? 0,
      speed: pos.speed ?? 0,
      is_online: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'driver_id' });
  }
}
