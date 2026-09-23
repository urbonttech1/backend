import { describe, it, expect } from 'vitest';
import { comisionValet, VALET_MINIMO_USD, VALET_UMBRAL_USD } from './valetCommission';

describe('comisionValet — la tabla acordada con el cliente', () => {
  it('hasta $100 de servicio, $10 fijos', () => {
    expect(comisionValet(50)).toBe(10);
    expect(comisionValet(75)).toBe(10);
    expect(comisionValet(100)).toBe(10);
  });

  it('por encima de $100, el 10 %', () => {
    expect(comisionValet(101)).toBe(10.10);
    expect(comisionValet(150)).toBe(15);
    expect(comisionValet(200)).toBe(20);
    expect(comisionValet(300)).toBe(30);
    expect(comisionValet(500)).toBe(50);
  });

  it('en el umbral no hay salto hacia abajo', () => {
    // El 10 % de $100 son $10: el tramo fijo y el porcentual se tocan.
    expect(comisionValet(VALET_UMBRAL_USD)).toBe(VALET_MINIMO_USD);
    expect(comisionValet(VALET_UMBRAL_USD + 0.01)).toBeGreaterThanOrEqual(VALET_MINIMO_USD);
  });

  it('redondea a centavos', () => {
    expect(comisionValet(133.33)).toBe(13.33);
    expect(comisionValet(101.55)).toBe(10.16);
  });

  it('un servicio sin precio no genera comisión', () => {
    expect(comisionValet(0)).toBe(0);
    expect(comisionValet(-5)).toBe(0);
    expect(comisionValet(null)).toBe(0);
    expect(comisionValet(undefined)).toBe(0);
    expect(comisionValet('abc')).toBe(0);
  });

  it('acepta el precio como texto, que es como llega del tablero', () => {
    expect(comisionValet('22.50')).toBe(10);
    expect(comisionValet('250')).toBe(25);
  });
});
