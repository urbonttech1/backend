import { describe, it, expect } from 'vitest';
import { numeroOpcional } from './driverLocation';

describe('numeroOpcional — rumbo y velocidad del GPS', () => {
  it('conserva los números, incluido el cero', () => {
    // 0 es un dato real: el coche mirando al norte, o parado.
    expect(numeroOpcional(0)).toBe(0);
    expect(numeroOpcional(187.5)).toBe(187.5);
  });

  it('lo que no se reportó es null, no 0', () => {
    // Con 0 el mapa del pasajero giraba al norte de golpe cada vez que el GPS
    // no calculaba el rumbo.
    expect(numeroOpcional(null)).toBeNull();
    expect(numeroOpcional(undefined)).toBeNull();
    expect(numeroOpcional('')).toBeNull();
    expect(numeroOpcional(NaN)).toBeNull();
  });

  it('acepta números como texto', () => {
    expect(numeroOpcional('92.4')).toBe(92.4);
    expect(numeroOpcional('norte')).toBeNull();
  });
});
