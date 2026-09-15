import { describe, it, expect } from 'vitest';
import { vistaDelConductor, mergeDriverHistory, liberacionPorViaje, type DriverRideEventRow } from './driverHistoryView';

/**
 * La ficha del conductor en el panel y su pestaña Trips sólo listaban viajes con
 * su `driver_id`. Un viaje que canceló, que le reasignaron o que se le ofreció y
 * el pasajero canceló antes de asignarse desaparecía de ambos lados.
 */

const FELIPE = 'felipe';
const OTRO = 'otro';

function evento(ride_id: string, event: DriverRideEventRow['event'], extra: Partial<DriverRideEventRow> = {}): DriverRideEventRow {
  return { ride_id, driver_id: FELIPE, event, reason: null, created_at: '2026-09-14T22:10:00Z', ...extra };
}

function viajes(...rows: Record<string, unknown>[]) {
  return new Map(rows.map(r => [String(r.id), r]));
}

describe('historial del conductor', () => {
  it('una oferta que el pasajero canceló antes de asignarse sale como cancelada por el pasajero', () => {
    const filas = vistaDelConductor(FELIPE, [evento('r1', 'offered')], viajes(
      { id: 'r1', ride_status: 'cancelled', driver_id: null, cancel_reason: 'wrong_pickup', fare: 37.64 },
    ));
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ id: 'r1', ride_status: 'cancelled', cancel_reason: 'wrong_pickup', cancelled_by: 'passenger', history_source: 'offered' });
  });

  it('una oferta que tomó otro conductor no es historia de este conductor', () => {
    const filas = vistaDelConductor(FELIPE, [evento('r1', 'offered')], viajes(
      { id: 'r1', ride_status: 'completed', driver_id: OTRO },
    ));
    expect(filas).toEqual([]);
  });

  it('una oferta que sigue buscando conductor no sale', () => {
    const filas = vistaDelConductor(FELIPE, [evento('r1', 'offered')], viajes(
      { id: 'r1', ride_status: 'searching', driver_id: null },
    ));
    expect(filas).toEqual([]);
  });

  it('si el conductor canceló, sale cancelado aunque otro terminara el viaje, sin ganancias ajenas', () => {
    const filas = vistaDelConductor(
      FELIPE,
      [evento('r1', 'driver_cancelled', { reason: 'driver_cancelled', created_at: '2026-09-14T22:20:00Z' })],
      viajes({ id: 'r1', ride_status: 'completed', driver_id: OTRO, driver_earnings: 30, tip_amount: 5, cancel_reason: null }),
    );
    expect(filas[0]).toMatchObject({
      ride_status: 'cancelled',
      cancel_reason: 'driver_cancelled',
      cancelled_at: '2026-09-14T22:20:00Z',
      driver_earnings: null,
      tip_amount: 0,
      cancelled_by: 'driver',
      history_source: 'driver_cancelled',
    });
  });

  it('una reasignación del sistema sale como cancelada por el sistema', () => {
    const filas = vistaDelConductor(FELIPE, [evento('r1', 'reassigned', { reason: 'driver_inactive' })], viajes(
      { id: 'r1', ride_status: 'searching', driver_id: null },
    ));
    expect(filas[0]).toMatchObject({ ride_status: 'cancelled', cancel_reason: 'driver_inactive', cancelled_by: 'system' });
  });

  it('si el viaje volvió a estar asignado a él, no se agrega otra vez', () => {
    const filas = vistaDelConductor(FELIPE, [evento('r1', 'driver_cancelled')], viajes(
      { id: 'r1', ride_status: 'completed', driver_id: FELIPE },
    ));
    expect(filas).toEqual([]);
  });

  it('la cancelación del conductor manda sobre la oferta del mismo viaje', () => {
    const filas = vistaDelConductor(
      FELIPE,
      [evento('r1', 'offered'), evento('r1', 'driver_cancelled', { reason: 'too_far' })],
      viajes({ id: 'r1', ride_status: 'searching', driver_id: null }),
    );
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ cancelled_by: 'driver', cancel_reason: 'too_far' });
  });

  it('ignora eventos de otros conductores', () => {
    const filas = vistaDelConductor(FELIPE, [evento('r1', 'offered', { driver_id: OTRO })], viajes(
      { id: 'r1', ride_status: 'cancelled', driver_id: null },
    ));
    expect(filas).toEqual([]);
  });
});

describe('liberacionPorViaje', () => {
  it('ignora las ofertas: a quien sólo se le ofreció no soltó el viaje', () => {
    expect(liberacionPorViaje([evento('r1', 'offered')]).size).toBe(0);
  });

  it('la cancelación del conductor manda sobre una reasignación posterior del sistema', () => {
    const l = liberacionPorViaje([
      evento('r1', 'driver_cancelled', { driver_id: FELIPE, reason: 'vehicle_issue', created_at: '2026-09-14T22:45:00Z' }),
      evento('r1', 'reassigned', { driver_id: OTRO, reason: 'driver_inactive', created_at: '2026-09-14T22:49:00Z' }),
    ]);
    expect(l.get('r1')).toMatchObject({ driver_id: FELIPE, event: 'driver_cancelled', reason: 'vehicle_issue' });
  });

  it('entre dos cancelaciones de conductor gana la más reciente', () => {
    const l = liberacionPorViaje([
      evento('r1', 'driver_cancelled', { driver_id: FELIPE, created_at: '2026-09-14T22:40:00Z' }),
      evento('r1', 'driver_cancelled', { driver_id: OTRO, created_at: '2026-09-14T22:50:00Z' }),
    ]);
    expect(l.get('r1')?.driver_id).toBe(OTRO);
  });
});

describe('mergeDriverHistory', () => {
  it('no repite viajes y ordena del más reciente al más antiguo', () => {
    const asignados = [
      { id: 'a', created_at: '2026-09-14T21:31:37.981', ride_status: 'completed' },
      { id: 'b', created_at: '2026-09-14T21:02:43.717', ride_status: 'completed' },
    ];
    const extras = [
      { id: 'c', created_at: '2026-09-14T22:12:24.241', ride_status: 'cancelled' },
      { id: 'a', created_at: '2026-09-14T21:31:37.981', ride_status: 'cancelled' },
    ];
    const unidos = mergeDriverHistory(asignados, extras);
    expect(unidos.map(r => r.id)).toEqual(['c', 'a', 'b']);
    expect(unidos.find(r => r.id === 'a')?.ride_status).toBe('completed');
  });
});
