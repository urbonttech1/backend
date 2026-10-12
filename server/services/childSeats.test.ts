import { describe, expect, it } from 'vitest';
import { esReservaConTiempo, leerSillas, textoSillas } from './childSeats';

describe('sillas de una reserva', () => {
  it('acepta las tres cantidades y deja vacías las que no piden', () => {
    const leido = leerSillas({ rear_facing: 1, booster: 2 });
    expect(leido).toEqual({ ok: true, seats: { rear_facing: 1, forward_facing: 0, booster: 2 } });
  });

  it('rechaza un tipo desconocido, un negativo y más de cuatro', () => {
    expect(leerSillas({ infant: 1 }).ok).toBe(false);
    expect(leerSillas({ rear_facing: -1 }).ok).toBe(false);
    expect(leerSillas({ rear_facing: 3, booster: 2 }).ok).toBe(false);
  });

  it('una reserva es la que falta más de 30 minutos', () => {
    const lejos = new Date(Date.now() + 45 * 60 * 1000).toISOString();
    const cerca = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    expect(esReservaConTiempo(lejos)).toBe(true);
    expect(esReservaConTiempo(cerca)).toBe(false);
    expect(esReservaConTiempo(null)).toBe(false);
  });

  it('el texto de la oferta está en inglés', () => {
    expect(textoSillas({ rear_facing: 1, forward_facing: 0, booster: 2 }))
      .toBe('Needs 1 rear-facing seat and 2 booster seats');
  });
});
