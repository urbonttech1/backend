import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/pool', () => ({ pool: { query: vi.fn() } }));

import { normalizarEfectivo, porDefecto } from './cashConfig';

describe('normalizarEfectivo', () => {
  it('acepta booleanos y las palabras del panel', () => {
    expect(normalizarEfectivo(true)).toBe(true);
    expect(normalizarEfectivo(false)).toBe(false);
    expect(normalizarEfectivo('on')).toBe(true);
    expect(normalizarEfectivo('OFF')).toBe(false);
  });

  it('rechaza lo que no es un valor claro', () => {
    for (const v of [null, undefined, 1, 'sí', {}]) expect(normalizarEfectivo(v)).toBeNull();
  });
});

describe('porDefecto', () => {
  it('activo salvo CASH_PAYMENTS=off', () => {
    expect(porDefecto({} as NodeJS.ProcessEnv)).toBe(true);
    expect(porDefecto({ CASH_PAYMENTS: 'off' } as NodeJS.ProcessEnv)).toBe(false);
    expect(porDefecto({ CASH_PAYMENTS: 'on' } as NodeJS.ProcessEnv)).toBe(true);
  });
});
