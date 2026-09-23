import { describe, it, expect } from 'vitest';
import { reasignacionesVencidas, limiteDeReasignacion, MINUTOS_PARA_REEMPLAZO } from './reassignTimeout';

const AHORA = new Date('2026-09-23T18:00:00Z');
const haceMinutos = (m: number) => new Date(AHORA.getTime() - m * 60 * 1000).toISOString();

const viaje = (extra: Record<string, unknown> = {}) => ({
  id: 'r1', ride_status: 'searching', driver_id: null, reassigning_since: haceMinutos(5), ...extra,
});

describe('reasignacionesVencidas', () => {
  it('vence a los dos minutos sin reemplazo', () => {
    expect(MINUTOS_PARA_REEMPLAZO).toBe(2);
    expect(reasignacionesVencidas([viaje()], AHORA).map(v => v.id)).toEqual(['r1']);
  });

  it('dentro del plazo se sigue buscando', () => {
    expect(reasignacionesVencidas([viaje({ reassigning_since: haceMinutos(1) })], AHORA)).toEqual([]);
  });

  it('justo en el límite ya cuenta', () => {
    expect(reasignacionesVencidas([viaje({ reassigning_since: haceMinutos(2) })], AHORA)).toHaveLength(1);
  });

  it('si otro chofer ya lo tomó, no se cancela', () => {
    expect(reasignacionesVencidas([viaje({ driver_id: 'd1', ride_status: 'confirmed' })], AHORA)).toEqual([]);
    expect(reasignacionesVencidas([viaje({ driver_id: 'd1' })], AHORA)).toEqual([]);
  });

  it('un viaje que nunca estuvo en reasignación no se toca', () => {
    // Los viajes buscando desde el principio los limpia el trabajo de las 2 horas.
    expect(reasignacionesVencidas([viaje({ reassigning_since: null })], AHORA)).toEqual([]);
    expect(reasignacionesVencidas([viaje({ reassigning_since: 'ayer' })], AHORA)).toEqual([]);
  });

  it('el plazo se puede ajustar', () => {
    expect(reasignacionesVencidas([viaje({ reassigning_since: haceMinutos(3) })], AHORA, 5)).toEqual([]);
    expect(limiteDeReasignacion(AHORA, 5).toISOString()).toBe('2026-09-23T17:55:00.000Z');
  });
});
