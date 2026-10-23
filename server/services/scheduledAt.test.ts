import { describe, expect, it } from 'vitest';
import { citaAUtc } from './scheduledAt';

describe('citaAUtc', () => {
  it('lee las 7:30 de Miami en horario de verano como 11:30 UTC', () => {
    expect(citaAUtc('2026-10-23T07:30')).toBe('2026-10-23T11:30:00.000Z');
    expect(citaAUtc('2026-10-23T07:30:00')).toBe('2026-10-23T11:30:00.000Z');
  });

  it('lee las 7:30 de Miami en invierno como 12:30 UTC', () => {
    expect(citaAUtc('2026-01-15T07:30')).toBe('2026-01-15T12:30:00.000Z');
  });

  it('conserva un instante que ya trae zona', () => {
    expect(citaAUtc('2026-10-23T11:30:00.000Z')).toBe('2026-10-23T11:30:00.000Z');
    expect(citaAUtc('2026-10-23T07:30:00-04:00')).toBe('2026-10-23T11:30:00.000Z');
  });

  it('no inventa una cita cuando no hay hora', () => {
    expect(citaAUtc('')).toBeNull();
    expect(citaAUtc(null)).toBeNull();
    expect(citaAUtc('mañana')).toBeNull();
  });
});
