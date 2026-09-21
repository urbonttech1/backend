import { describe, it, expect } from 'vitest';
import { normalizarTasa, comoPorcentaje, TASA_POR_DEFECTO, TASA_MAXIMA } from './taxConfig';

describe('normalizarTasa — lo que el panel escribe', () => {
  it('convierte el porcentaje en tasa', () => {
    expect(normalizarTasa(6.5)).toBe(0.065);
    expect(normalizarTasa(7)).toBe(0.07);
    expect(normalizarTasa(0)).toBe(0);
  });

  it('acepta texto, con coma o con punto', () => {
    expect(normalizarTasa('6.5')).toBe(0.065);
    expect(normalizarTasa('6,5')).toBe(0.065);
  });

  it('conserva hasta cuatro decimales de porcentaje', () => {
    expect(normalizarTasa(6.4912)).toBe(0.064912);
  });

  it('rechaza lo que no es una tasa, y los errores de tecleo', () => {
    expect(normalizarTasa(-1)).toBeNull();
    expect(normalizarTasa('mucho')).toBeNull();
    expect(normalizarTasa(undefined)).toBeNull();
    // 65 en vez de 6,5: sin tope, un viaje de $22 cobraría $14 de impuesto.
    expect(normalizarTasa(65)).toBeNull();
    expect(normalizarTasa(TASA_MAXIMA * 100)).toBe(TASA_MAXIMA);
  });

  it('ida y vuelta con comoPorcentaje', () => {
    expect(comoPorcentaje(TASA_POR_DEFECTO)).toBe(6.5);
    expect(comoPorcentaje(normalizarTasa('7.25')!)).toBe(7.25);
  });
});
