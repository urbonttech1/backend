import { describe, it, expect } from 'vitest';
import { viajesVarados, esViajeVarado } from './staleRides';

const AHORA = new Date('2026-09-23T18:00:00Z');
const haceMin = (m: number) => new Date(AHORA.getTime() - m * 60 * 1000).toISOString();

const candidato = (extra: Record<string, unknown> = {}) => ({
  id: 'r1', driver_id: 'd1', ride_status: 'in_progress', ultimaPosicion: haceMin(1), ...extra,
});

describe('esViajeVarado — viaje en curso, pasajero a bordo', () => {
  it('sin posición NO se le quita: puede ser el GPS, no el chofer', () => {
    // Era justo lo que pasaba: driver_locations estaba vacía por un fallo de
    // escritura y a todos los viajes de más de 4 minutos se les buscaba otro
    // chofer, incluso al terminar el trayecto.
    expect(esViajeVarado(candidato({ ultimaPosicion: null }), AHORA)).toBe(false);
    expect(esViajeVarado(candidato({ ultimaPosicion: undefined }), AHORA)).toBe(false);
  });

  it('con posición vieja de más de doce minutos, sí', () => {
    expect(esViajeVarado(candidato({ ultimaPosicion: haceMin(13) }), AHORA)).toBe(true);
    expect(esViajeVarado(candidato({ ultimaPosicion: haceMin(11) }), AHORA)).toBe(false);
  });
});

describe('esViajeVarado — camino a recoger', () => {
  const enCamino = (extra: Record<string, unknown> = {}) => candidato({ ride_status: 'confirmed', ...extra });

  it('sin posición se reasigna: el pasajero todavía no está con él', () => {
    expect(esViajeVarado(enCamino({ ultimaPosicion: null }), AHORA)).toBe(true);
  });

  it('el plazo es de cinco minutos', () => {
    expect(esViajeVarado(enCamino({ ultimaPosicion: haceMin(6) }), AHORA)).toBe(true);
    expect(esViajeVarado(enCamino({ ultimaPosicion: haceMin(4) }), AHORA)).toBe(false);
  });
});

describe('viajesVarados', () => {
  it('no toca los viajes ya terminados ni los que buscan chofer', () => {
    const lista = [
      candidato({ id: 'a', ride_status: 'completed', ultimaPosicion: null }),
      candidato({ id: 'b', ride_status: 'searching', ultimaPosicion: null }),
      candidato({ id: 'c', ride_status: 'cancelled', ultimaPosicion: haceMin(30) }),
    ];
    expect(viajesVarados(lista, AHORA)).toEqual([]);
  });

  it('separa los que sí hay que reasignar', () => {
    const lista = [
      candidato({ id: 'a', ride_status: 'in_progress', ultimaPosicion: null }),       // no
      candidato({ id: 'b', ride_status: 'in_progress', ultimaPosicion: haceMin(20) }), // sí
      candidato({ id: 'c', ride_status: 'confirmed', ultimaPosicion: null }),          // sí
    ];
    expect(viajesVarados(lista, AHORA).map(v => v.id)).toEqual(['b', 'c']);
  });
});
