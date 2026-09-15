import { supabaseAdmin } from '../db/client';
import { createContextLogger } from '../lib/logger';
import { vistaDelConductor, type DriverRideEventRow, type DriverRideEventType } from './driverHistoryView';

/**
 * Guarda y lee `driver_ride_events`: a qué conductores se les ofreció cada viaje
 * y cuáles lo soltaron. Escribir nunca bloquea ni lanza — es historial, no parte
 * del despacho. Leer tampoco: si la tabla aún no existe, las listas quedan como
 * estaban.
 */

const log = createContextLogger('DRIVER_HISTORY');
const TABLE = 'driver_ride_events';

type EventInsert = {
  ride_id: string;
  driver_id: string;
  event: DriverRideEventType;
  reason?: string | null;
  metadata?: Record<string, unknown>;
};

function guardar(filas: EventInsert[], contexto: Record<string, unknown>): void {
  if (filas.length === 0) return;
  Promise.resolve(
    supabaseAdmin.from(TABLE).upsert(filas, { onConflict: 'ride_id,driver_id,event', ignoreDuplicates: true }),
  )
    .then(({ error }) => {
      if (error) log.warn({ ...contexto, err: error.message }, 'driver ride event not saved');
    })
    .catch((err: unknown) => {
      log.warn({ ...contexto, err: err instanceof Error ? err.message : String(err) }, 'driver ride event not saved');
    });
}

/** Conductores a los que se les acaba de enviar la oferta de un viaje. */
export function recordRideOffers(rideId: string, driverIds: string[], channel: 'socket' | 'push'): void {
  const ids = [...new Set(driverIds.filter(Boolean))];
  if (!rideId || ids.length === 0) return;
  guardar(ids.map(driver_id => ({ ride_id: rideId, driver_id, event: 'offered' as const, metadata: { channel } })), { rideId, channel });
}

/** Un conductor dejó de tener el viaje: lo canceló o el sistema se lo reasignó. */
export function recordDriverRelease(
  rideId: string,
  driverId: string,
  event: 'driver_cancelled' | 'reassigned',
  reason: string | null,
): void {
  if (!rideId || !driverId) return;
  guardar([{ ride_id: rideId, driver_id: driverId, event, reason }], { rideId, driverId, event });
}

// Columnas que `vistaDelConductor` necesita, se pidan o no en el select del llamador.
const COLUMNAS_NECESARIAS = ['id', 'driver_id', 'ride_status', 'cancel_reason', 'cancelled_at', 'created_at'];

function conColumnasNecesarias(columns: string): string {
  const faltan = COLUMNAS_NECESARIAS.filter(c => !new RegExp(`(^|[\\s,])${c}([\\s,]|$)`).test(columns));
  return faltan.length ? `${columns}, ${faltan.join(', ')}` : columns;
}

/**
 * Entradas de historial por conductor, ya en la forma de fila de `rides` con las
 * columnas pedidas (ver `vistaDelConductor`). `driverIds` null = todos los
 * conductores con eventos.
 */
export async function loadDriverHistoryExtras(
  driverIds: string[] | null,
  columns: string,
): Promise<Map<string, Record<string, unknown>[]>> {
  const resultado = new Map<string, Record<string, unknown>[]>();
  try {
    let consulta = supabaseAdmin
      .from(TABLE)
      .select('ride_id, driver_id, event, reason, created_at')
      .in('event', ['offered', 'driver_cancelled', 'reassigned']);
    if (driverIds) consulta = consulta.in('driver_id', driverIds);
    const { data: eventos, error } = await consulta.order('created_at', { ascending: false }).limit(5000);
    if (error) {
      log.warn({ err: error.message }, 'driver ride events unavailable');
      return resultado;
    }
    const filas = (eventos ?? []) as DriverRideEventRow[];
    if (filas.length === 0) return resultado;

    const rideIds = [...new Set(filas.map(e => e.ride_id))];
    const ridesById = new Map<string, Record<string, unknown>>();
    const select = conColumnasNecesarias(columns);
    for (let i = 0; i < rideIds.length; i += 100) {
      const { data: rides, error: ridesError } = await supabaseAdmin
        .from('rides')
        .select(select)
        .in('id', rideIds.slice(i, i + 100));
      if (ridesError) {
        log.warn({ err: ridesError.message }, 'rides for driver history unavailable');
        return resultado;
      }
      for (const r of (rides ?? []) as unknown as Record<string, unknown>[]) ridesById.set(String(r.id), r);
    }

    for (const driverId of new Set(filas.map(e => e.driver_id))) {
      const vista = vistaDelConductor(driverId, filas, ridesById);
      if (vista.length) resultado.set(driverId, vista);
    }
  } catch (err: unknown) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'driver history extras failed');
  }
  return resultado;
}
