import { describe, it, expect } from 'vitest';
import { centavosDeViaje, agruparDeuda } from './pendingPayouts';

describe('centavosDeViaje', () => {
  it('convierte dólares a centavos redondeando', () => {
    expect(centavosDeViaje(24.62)).toBe(2462);
    expect(centavosDeViaje('24.62')).toBe(2462);
    expect(centavosDeViaje(0.005)).toBe(1);
  });

  it('no paga lo que no es un importe positivo', () => {
    expect(centavosDeViaje(0)).toBe(0);
    expect(centavosDeViaje(-5)).toBe(0);
    expect(centavosDeViaje(null)).toBe(0);
    expect(centavosDeViaje(undefined)).toBe(0);
    expect(centavosDeViaje('')).toBe(0);
    expect(centavosDeViaje('abc')).toBe(0);
  });
});

describe('agruparDeuda', () => {
  it('junta los viajes de cada chofer y suma lo que se le debe', () => {
    const deuda = agruparDeuda([
      { id: 'r1', driver_id: 'd1', driver_earnings: 24.62 },
      { id: 'r2', driver_id: 'd1', driver_earnings: 34.66 },
      { id: 'r3', driver_id: 'd2', driver_earnings: 19.77 },
    ]);
    expect(deuda).toHaveLength(2);
    const d1 = deuda.find(d => d.driverId === 'd1')!;
    expect(d1.viajes.map(v => v.id)).toEqual(['r1', 'r2']);
    expect(d1.totalCentavos).toBe(5928);
    expect(deuda.find(d => d.driverId === 'd2')!.totalCentavos).toBe(1977);
  });

  it('descarta viajes sin chofer o sin importe', () => {
    expect(agruparDeuda([
      { id: 'r1', driver_id: null, driver_earnings: 20 },
      { id: 'r2', driver_id: '   ', driver_earnings: 20 },
      { id: 'r3', driver_id: 'd1', driver_earnings: 0 },
      { id: 'r4', driver_id: 'd1', driver_earnings: null },
    ])).toEqual([]);
  });

  it('sin deuda, lista vacía', () => {
    expect(agruparDeuda([])).toEqual([]);
  });
});
