import { describe, it, expect } from 'vitest';
import { normalizarComision, comoPorcentaje, COMISION_MAXIMA } from './commissionConfig';

describe('normalizarComision', () => {
  it('convierte el porcentaje del panel en tasa', () => {
    expect(normalizarComision(15)).toBe(0.15);
    expect(normalizarComision(10)).toBe(0.10);
    expect(normalizarComision(12.5)).toBe(0.125);
  });

  it('acepta texto, con coma o con punto', () => {
    expect(normalizarComision('15')).toBe(0.15);
    expect(normalizarComision('17,5')).toBe(0.175);
  });

  it('cero es válido: dejar de cobrar comisión', () => {
    expect(normalizarComision(0)).toBe(0);
  });

  it('rechaza lo que no es una tasa y los errores de tecleo', () => {
    expect(normalizarComision(-1)).toBeNull();
    expect(normalizarComision('quince')).toBeNull();
    expect(normalizarComision(undefined)).toBeNull();
    // 150 en vez de 15: el chofer se quedaría sin nada.
    expect(normalizarComision(150)).toBeNull();
    expect(normalizarComision(COMISION_MAXIMA * 100)).toBe(COMISION_MAXIMA);
  });

  it('ida y vuelta con comoPorcentaje', () => {
    expect(comoPorcentaje(0.15)).toBe(15);
    expect(comoPorcentaje(normalizarComision('17.25')!)).toBe(17.25);
  });
});
