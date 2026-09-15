/**
 * Cómo ve un conductor los viajes que ya no tiene asignados.
 *
 * `rides.driver_id` sólo guarda al conductor actual. Cuando un conductor cancela
 * un viaje que aceptó, o el sistema se lo reasigna, el viaje vuelve a `searching`
 * y pierde ese dato; y a quien sólo se le ofreció nunca lo tuvo. Estas funciones
 * cruzan `driver_ride_events` con los viajes para devolverle al conductor esas
 * entradas como canceladas, con la misma forma de fila que ya consumen la app y
 * el panel.
 */

export type DriverRideEventType = 'offered' | 'driver_cancelled' | 'reassigned';

export interface DriverRideEventRow {
  ride_id: string;
  driver_id: string;
  event: DriverRideEventType;
  reason: string | null;
  created_at: string;
}

type Row = Record<string, unknown>;

// Si el mismo conductor tiene varios eventos del mismo viaje, manda el que más
// dice de lo que pasó: haberlo cancelado pesa más que habérsele ofrecido.
const PRIORIDAD: Record<DriverRideEventType, number> = { driver_cancelled: 3, reassigned: 2, offered: 1 };

/** Entradas que un conductor debe ver además de sus viajes asignados. */
export function vistaDelConductor(driverId: string, events: DriverRideEventRow[], ridesById: Map<string, Row>): Row[] {
  const porViaje = new Map<string, DriverRideEventRow>();
  for (const e of events) {
    if (e.driver_id !== driverId) continue;
    const previo = porViaje.get(e.ride_id);
    if (!previo || PRIORIDAD[e.event] > PRIORIDAD[previo.event]) porViaje.set(e.ride_id, e);
  }

  const filas: Row[] = [];
  for (const [rideId, e] of porViaje) {
    const ride = ridesById.get(rideId);
    if (!ride) continue;
    // Si el viaje volvió a ser suyo, ya sale en su lista normal.
    if (ride.driver_id === driverId) continue;

    if (e.event === 'offered') {
      // Una oferta sólo es historia del conductor si el viaje terminó cancelado
      // sin que nadie lo aceptara. Si lo tomó otro, o sigue buscando, no es suyo.
      if (ride.ride_status !== 'cancelled' || ride.driver_id) continue;
      filas.push({ ...ride, cancelled_by: 'passenger', history_source: 'offered' });
      continue;
    }

    filas.push({
      ...ride,
      ride_status: 'cancelled',
      cancel_reason: e.reason ?? ride.cancel_reason ?? null,
      cancelled_at: e.created_at,
      // Lo que ganó o recibió de propina quien terminara el viaje no es de este conductor.
      driver_earnings: null,
      tip_amount: 0,
      cancelled_by: e.event === 'driver_cancelled' ? 'driver' : 'system',
      history_source: e.event,
    });
  }
  return filas;
}

/** Une viajes asignados y entradas de historial, sin repetir viaje y del más reciente al más antiguo. */
export function mergeDriverHistory(assigned: Row[], extras: Row[]): Row[] {
  const vistos = new Set(assigned.map(r => String(r.id)));
  const unidos = [...assigned];
  for (const r of extras) {
    if (vistos.has(String(r.id))) continue;
    vistos.add(String(r.id));
    unidos.push(r);
  }
  return unidos.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
}
