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

import { normalizarReglasValet, REGLAS_VALET_POR_DEFECTO, setReglasValet, getReglasValet } from './valetCommission';

describe('comisión del valet configurable', () => {
  const reglas = { minimo: 15, umbral: 80, porcentaje: 0.2 };

  it('usa las reglas que se le pasen', () => {
    expect(comisionValet(50, reglas)).toBe(15);
    expect(comisionValet(80, reglas)).toBe(15);
    expect(comisionValet(100, reglas)).toBe(20);
  });

  it('las reglas vigentes cambian el resultado por defecto y se pueden restaurar', () => {
    setReglasValet(reglas);
    expect(comisionValet(50)).toBe(15);
    setReglasValet(REGLAS_VALET_POR_DEFECTO);
    expect(getReglasValet()).toEqual(REGLAS_VALET_POR_DEFECTO);
    expect(comisionValet(50)).toBe(10);
  });

  it('convierte lo que manda el panel: USD, USD y porcentaje', () => {
    expect(normalizarReglasValet({ minimumUsd: 12, thresholdUsd: '90', percent: '12,5' }))
      .toEqual({ reglas: { minimo: 12, umbral: 90, porcentaje: 0.125 } });
  });

  it('rechaza valores fuera de rango o que no son números', () => {
    expect(normalizarReglasValet({ minimumUsd: -1, thresholdUsd: 100, percent: 10 })).toMatchObject({ field: 'minimumUsd' });
    expect(normalizarReglasValet({ minimumUsd: 10, thresholdUsd: 0, percent: 10 })).toMatchObject({ field: 'thresholdUsd' });
    expect(normalizarReglasValet({ minimumUsd: 10, thresholdUsd: 100, percent: 99 })).toMatchObject({ field: 'percent' });
    expect(normalizarReglasValet({ minimumUsd: 'abc', thresholdUsd: 100, percent: 10 })).toMatchObject({ field: 'minimumUsd' });
  });
});
