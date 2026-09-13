import { describe, it, expect } from 'vitest';
import { calcularSelfieDue, SELFIE_TRIP_INTERVAL, SELFIE_MAX_AGE_DAYS } from './driverScore';

/**
 * `selfieDue` estaba devuelto como `false` fijo. El endpoint que registra la
 * verificación sí escribía `last_selfie_at`, `trips_since_selfie` y
 * `selfie_due_at`, pero nadie los leía: el campo que la app recibe no podía
 * valer `true` nunca, y la verificación de identidad quedaba muerta por los dos
 * extremos a la vez.
 */

const hace = (dias: number) => new Date(Date.now() - dias * 86_400_000).toISOString();
const dentroDe = (dias: number) => new Date(Date.now() + dias * 86_400_000).toISOString();

describe('calcularSelfieDue', () => {
  it('no la exige a un conductor recién verificado', () => {
    expect(calcularSelfieDue({
      last_selfie_at: hace(1),
      trips_since_selfie: 3,
      selfie_due_at: null,
      trips_completed: 40,
    })).toBe(false);
  });

  it('la exige cuando el sistema marcó una fecha y ya pasó', () => {
    expect(calcularSelfieDue({
      selfie_due_at: hace(1),
      last_selfie_at: hace(1),
      trips_since_selfie: 0,
    })).toBe(true);
  });

  it('no la exige si la fecha marcada todavía no llegó', () => {
    expect(calcularSelfieDue({
      selfie_due_at: dentroDe(3),
      last_selfie_at: hace(1),
      trips_since_selfie: 0,
    })).toBe(false);
  });

  it('la exige al llegar al número de viajes', () => {
    expect(calcularSelfieDue({
      last_selfie_at: hace(1),
      trips_since_selfie: SELFIE_TRIP_INTERVAL,
    })).toBe(true);
    expect(calcularSelfieDue({
      last_selfie_at: hace(1),
      trips_since_selfie: SELFIE_TRIP_INTERVAL - 1,
    })).toBe(false);
  });

  it('la exige cuando pasó demasiado tiempo desde la última', () => {
    expect(calcularSelfieDue({ last_selfie_at: hace(SELFIE_MAX_AGE_DAYS + 1) })).toBe(true);
    expect(calcularSelfieDue({ last_selfie_at: hace(SELFIE_MAX_AGE_DAYS - 1) })).toBe(false);
  });

  it('a quien nunca se verificó, sólo cuando ya lleva viajes', () => {
    // No se le exige el primer día: un conductor que aún no trabajó no tiene
    // por qué pasar una verificación de identidad para empezar.
    expect(calcularSelfieDue({ last_selfie_at: null, trips_completed: 0 })).toBe(false);
    expect(calcularSelfieDue({ last_selfie_at: null, trips_completed: SELFIE_TRIP_INTERVAL })).toBe(true);
  });

  it('tolera un perfil sin ninguno de los campos', () => {
    expect(calcularSelfieDue({})).toBe(false);
  });
});
