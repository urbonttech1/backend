/**
 * Reserva por hora: las millas del servicio y lo que ven las apps.
 *
 * Cada posición del chofer entra por `guardarUbicacion` (REST cada 30 s y
 * socket cada 3 s). Si el chofer tiene un servicio por hora en curso, el punto
 * se suma aquí. Las reglas de qué punto cuenta están en hourlyBooking.ts.
 *
 * El seguimiento empieza al subir el pasajero. Se abre explícitamente desde
 * `verify-pin` y desde el cambio a `in_progress`, y también solo, con el primer
 * punto que llegue: el viaje puede pasar a en curso por más de un camino y
 * ninguno debe dejar el servicio sin medir.
 *
 * Nada de esto lanza. Una medición que falla no puede tumbar la posición del
 * chofer, que es lo que hace que los viajes encuentren conductor.
 */
import { pool } from '../db/pool';
import { logger } from '../lib/logger';
import { getFareClass } from '../config/pricing';
import {
  evaluarPunto, leerTerminos, terminosDeReserva, vistaPorHora,
  type FilaPorHora, type TerminosPorHora,
} from './hourlyBooking';

const err = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ── Qué choferes están en un servicio por hora ───────────────────────────────

/**
 * chofer → viaje. Se relee cada 30 s: así un punto GPS de un chofer que no
 * está en un servicio por hora —casi todos— no toca la base.
 */
const TTL_MS = 30_000;
let activos = new Map<string, string>();
let cargadoEn = 0;
let cargando: Promise<void> | null = null;

async function refrescar(): Promise<void> {
  if (Date.now() - cargadoEn < TTL_MS) return;
  if (cargando) return cargando;
  cargando = (async () => {
    try {
      const { rows } = await pool.query<{ id: string; driver_id: string }>(
        `SELECT id, driver_id FROM rides
          WHERE booking_type = 'hourly' AND ride_status = 'in_progress' AND driver_id IS NOT NULL`,
      );
      activos = new Map(rows.map((r) => [String(r.driver_id), String(r.id)]));
      cargadoEn = Date.now();
    } catch (e) {
      logger.warn(`[POR_HORA] No se pudieron leer los servicios en curso: ${err(e)}`);
    } finally {
      cargando = null;
    }
  })();
  return cargando;
}

/** Fuerza la relectura en el próximo punto. Al empezar o terminar un servicio. */
export function invalidarServiciosPorHora(): void {
  cargadoEn = 0;
}

/** Para el socket, que es síncrono: sin consultar, con lo último leído. */
export function esServicioPorHoraEnCurso(rideId: string): boolean {
  for (const id of activos.values()) if (id === rideId) return true;
  return false;
}

// ── Seguimiento ──────────────────────────────────────────────────────────────

/**
 * Abre la medición con la posición actual del chofer como punto de partida, si
 * es reciente. Idempotente: si ya estaba abierta, no la toca.
 */
export async function iniciarSeguimientoPorHora(rideId: string, driverId: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO ride_hourly_tracking (ride_id, driver_id, last_lat, last_lng, last_ms)
       SELECT $1, $2, dl.lat, dl.lng,
              CASE WHEN dl.lat IS NULL THEN NULL ELSE (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint END
         FROM (SELECT 1) uno
         LEFT JOIN driver_locations dl
           ON dl.driver_id = $2 AND dl.updated_at > NOW() - INTERVAL '2 minutes'
       ON CONFLICT (ride_id) DO NOTHING`,
      [rideId, driverId],
    );
  } catch (e) {
    logger.warn(`[POR_HORA] ${rideId}: no se pudo abrir la medición: ${err(e)}`);
  } finally {
    invalidarServiciosPorHora();
  }
}

/** Abre la medición si el viaje es por hora. Para quien no sabe el tipo del viaje. */
export async function iniciarSiEsPorHora(rideId: string, driverId: string | null | undefined): Promise<void> {
  if (!driverId) return;
  try {
    const { rows } = await pool.query(`SELECT booking_type FROM rides WHERE id = $1`, [rideId]);
    if (rows[0]?.booking_type === 'hourly') await iniciarSeguimientoPorHora(rideId, driverId);
  } catch (e) {
    logger.warn(`[POR_HORA] ${rideId}: no se pudo comprobar el tipo de viaje: ${err(e)}`);
  }
}

export interface PuntoChofer {
  driverId: string;
  lat: number;
  lng: number;
  accuracy?: number | null;
}

/** Suma un punto al servicio por hora del chofer, si tiene uno en curso. */
export async function registrarPuntoPorHora(p: PuntoChofer): Promise<void> {
  try {
    await refrescar();
    const rideId = activos.get(String(p.driverId));
    if (!rideId) return;

    // La hora del servidor, no la del teléfono: el punto de partida se toma con
    // la del servidor, y un reloj de teléfono atrasado haría descartar como
    // viejos los primeros minutos del servicio.
    const at = Date.now();
    const accuracy = typeof p.accuracy === 'number' && Number.isFinite(p.accuracy) ? p.accuracy : null;

    const { rows } = await pool.query(
      `SELECT last_lat, last_lng, last_ms, closed_at FROM ride_hourly_tracking WHERE ride_id = $1`,
      [rideId],
    );
    const fila = rows[0] as { last_lat: number | null; last_lng: number | null; last_ms: string | null; closed_at: unknown } | undefined;

    if (!fila) {
      // Nadie abrió la medición (otro camino a en curso): la abre este punto,
      // como partida si es fiable.
      const sirve = evaluarPunto(null, { lat: p.lat, lng: p.lng, at, accuracy }).accion === 'primero';
      await pool.query(
        `INSERT INTO ride_hourly_tracking (ride_id, driver_id, last_lat, last_lng, last_ms, points)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (ride_id) DO NOTHING`,
        [rideId, p.driverId, sirve ? p.lat : null, sirve ? p.lng : null, sirve ? at : null, sirve ? 1 : 0],
      );
      return;
    }
    if (fila.closed_at) return;

    const ultimo = fila.last_lat != null && fila.last_lng != null && fila.last_ms != null
      ? { lat: Number(fila.last_lat), lng: Number(fila.last_lng), at: Number(fila.last_ms) }
      : null;
    const d = evaluarPunto(ultimo, { lat: p.lat, lng: p.lng, at, accuracy });

    if (d.accion === 'esperar') return;
    if (d.accion === 'descartar') {
      await pool.query(`UPDATE ride_hourly_tracking SET discarded = discarded + 1 WHERE ride_id = $1`, [rideId]);
      return;
    }
    if (d.accion === 'primero') {
      await pool.query(
        `UPDATE ride_hourly_tracking SET last_lat = $2, last_lng = $3, last_ms = $4, points = points + 1, updated_at = NOW()
          WHERE ride_id = $1 AND closed_at IS NULL AND last_ms IS NULL`,
        [rideId, p.lat, p.lng, at],
      );
      return;
    }
    // Candado optimista: si otro punto se escribió entre la lectura y esta
    // escritura —llegan por el socket y por REST, a veces a otra instancia—, éste
    // se descarta en vez de sumar el mismo tramo dos veces.
    await pool.query(
      `UPDATE ride_hourly_tracking
          SET meters = meters + $2, last_lat = $3, last_lng = $4, last_ms = $5,
              points = points + 1,
              max_gap_seconds = GREATEST(max_gap_seconds, $6),
              degraded = degraded OR $7,
              updated_at = NOW()
        WHERE ride_id = $1 AND closed_at IS NULL AND last_ms = $8`,
      [rideId, d.metros, p.lat, p.lng, at, Math.round(d.huecoMs / 1000), d.degradado, ultimo!.at],
    );
  } catch (e) {
    logger.warn(`[POR_HORA] Punto GPS no registrado para ${p.driverId}: ${err(e)}`);
  }
}

/**
 * Cierra la medición y devuelve lo medido. Los puntos que lleguen después no
 * suman. Sin medición —el GPS nunca llegó—, 0 metros y marcada como degradada:
 * no se le cobra al pasajero una milla que no se midió.
 */
export async function cerrarSeguimiento(rideId: string): Promise<{ meters: number; degraded: boolean }> {
  try {
    const { rows } = await pool.query(
      `UPDATE ride_hourly_tracking SET closed_at = COALESCE(closed_at, NOW()), updated_at = NOW()
        WHERE ride_id = $1 RETURNING meters, degraded, points`,
      [rideId],
    );
    invalidarServiciosPorHora();
    if (!rows[0]) return { meters: 0, degraded: true };
    return { meters: Number(rows[0].meters) || 0, degraded: rows[0].degraded === true || Number(rows[0].points) === 0 };
  } catch (e) {
    logger.error(`[POR_HORA] ${rideId}: no se pudo cerrar la medición: ${err(e)}`);
    return { meters: 0, degraded: true };
  }
}

/** Marca un aviso como enviado. `true` sólo la primera vez: evita repetirlo. */
export async function marcarAviso(rideId: string, clave: string): Promise<boolean> {
  try {
    const { rowCount } = await pool.query(
      `UPDATE ride_hourly_tracking SET notified = notified || jsonb_build_object($2::text, true)
        WHERE ride_id = $1 AND NOT (notified ? $2)`,
      [rideId, clave],
    );
    return (rowCount ?? 0) > 0;
  } catch (e) {
    logger.warn(`[POR_HORA] ${rideId}: no se pudo marcar el aviso ${clave}: ${err(e)}`);
    return false;
  }
}

// ── Lectura para las apps ────────────────────────────────────────────────────

export interface ServicioPorHora extends FilaPorHora {
  id:             string;
  passenger_id:   string | null;
  driver_id:      string | null;
  terminos:       TerminosPorHora;
}

/**
 * Los servicios por hora de esos viajes, con su medición. Directo a Postgres:
 * las columnas nuevas no dependen de que PostgREST haya recargado su caché.
 * Un viaje sin condiciones congeladas —anterior a esto— usa la tabla vigente.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function cargarServiciosPorHora(idsCrudos: string[]): Promise<Map<string, ServicioPorHora>> {
  const out = new Map<string, ServicioPorHora>();
  // Un id mal formado haría fallar la consulta entera con un error de tipo.
  const ids = idsCrudos.filter((id) => UUID_RE.test(id));
  if (!ids.length) return out;
  const { rows } = await pool.query(
    `SELECT r.id, r.passenger_id, r.driver_id, r.ride_status, r.vehicle_type, r.hourly_hours, r.surge_multiplier,
            r.scheduled_at, r.wait_started_at, r.started_at, r.completed_at,
            r.hourly_terms, r.hourly_extras, r.hourly_extras_status,
            t.meters, t.degraded
       FROM rides r
       LEFT JOIN ride_hourly_tracking t ON t.ride_id = r.id
      WHERE r.id = ANY($1::uuid[]) AND r.booking_type = 'hourly'`,
    [ids],
  );
  for (const r of rows) {
    let terminos = leerTerminos(r.hourly_terms);
    if (!terminos) {
      const rule = getFareClass(String(r.vehicle_type ?? ''));
      const horas = Number(r.hourly_hours);
      if (rule && Number.isFinite(horas) && horas > 0) {
        terminos = terminosDeReserva(rule, horas, Number(r.surge_multiplier) || 1);
      }
    }
    if (!terminos) continue;
    out.set(String(r.id), {
      id: String(r.id),
      passenger_id: r.passenger_id ? String(r.passenger_id) : null,
      driver_id: r.driver_id ? String(r.driver_id) : null,
      ride_status: String(r.ride_status),
      scheduled_at: r.scheduled_at,
      wait_started_at: r.wait_started_at,
      started_at: r.started_at,
      completed_at: r.completed_at,
      meters: r.meters == null ? null : Number(r.meters),
      degraded: r.degraded ?? null,
      hourly_extras: r.hourly_extras,
      hourly_extras_status: r.hourly_extras_status ?? null,
      terminos,
    });
  }
  return out;
}

/**
 * Añade `hourly` a los viajes por hora de una lista. Los demás no se tocan, y
 * si la lectura falla la lista sale igual que antes.
 */
export async function adjuntarPorHora<T extends Record<string, unknown>>(viajes: T[]): Promise<T[]> {
  const ids = viajes.filter((v) => v?.booking_type === 'hourly' && v.id).map((v) => String(v.id));
  if (!ids.length) return viajes;
  try {
    const servicios = await cargarServiciosPorHora(ids);
    const ahora = Date.now();
    return viajes.map((v) => {
      const s = servicios.get(String(v.id));
      return s ? { ...v, hourly: vistaPorHora(s.terminos, s, ahora) } : v;
    });
  } catch (e) {
    logger.warn(`[POR_HORA] No se pudo adjuntar el detalle por hora: ${err(e)}`);
    return viajes;
  }
}
