import { describe, it, expect } from 'vitest';
import { normalizarIncidente, telefonoEmergencias } from './driverIncident';

const RIDE = '07b47866-11aa-4ea6-8f21-dea545924727';
const AHORA = new Date('2026-09-16T18:00:00Z');

const ok = (body: Record<string, unknown>) => {
  const r = normalizarIncidente(body, AHORA);
  if ('errorCode' in r) throw new Error(`esperaba ok y llegó ${r.errorCode}`);
  return r.incidente;
};
const error = (body: Record<string, unknown>) => {
  const r = normalizarIncidente(body, AHORA);
  if (!('errorCode' in r)) throw new Error('esperaba un error');
  return r;
};

describe('normalizarIncidente — el formulario de Help', () => {
  it('accidente grave: severidad alta en el panel y aviso inmediato', () => {
    const i = ok({
      category: 'accident', severity: 'severe', description: 'Rear-ended at a light',
      rideId: RIDE, location: { lat: 10.98, lng: -74.81 }, occurredAt: '2026-09-16T17:54:00Z',
    });
    expect(i).toMatchObject({
      tipo: 'accident', severidad: 'high', severidadApp: 'severe', avisarYa: true,
      rideId: RIDE, lat: 10.98, lng: -74.81, occurredAt: '2026-09-16T17:54:00.000Z',
    });
  });

  it('escala de severidad: minor → low, moderate → medium, sin aviso inmediato', () => {
    expect(ok({ category: 'accident', severity: 'minor' })).toMatchObject({ severidad: 'low', avisarYa: false });
    expect(ok({ category: 'accident', severity: 'moderate' })).toMatchObject({ severidad: 'medium', avisarYa: false });
  });

  it('los demás tipos ignoran la severidad y usan la suya', () => {
    expect(ok({ category: 'cannot_pickup', severity: 'severe', description: 'Road closed' }))
      .toMatchObject({ tipo: 'cannot_pickup', severidad: 'medium', severidadApp: null, avisarYa: false });
    expect(ok({ category: 'other' }).severidad).toBe('low');
  });

  it('acepta los nombres alternativos de cada tipo', () => {
    expect(ok({ type: 'vehicle_breakdown' }).tipo).toBe('vehicle_issue');
    expect(ok({ category: 'roadside' }).tipo).toBe('roadside_assistance');
    expect(ok({ category: 'Other_Incident' }).tipo).toBe('other');
  });

  it('acepta message en lugar de description, y lat/lng sueltos', () => {
    const i = ok({ category: 'other', message: 'Passenger left an item', lat: '25.76', lng: '-80.19' });
    expect(i.descripcion).toBe('Passenger left an item');
    expect(i).toMatchObject({ lat: 25.76, lng: -80.19 });
  });

  it('sin ubicación ni fecha: ubicación vacía y fecha del reporte', () => {
    const i = ok({ category: 'other' });
    expect(i).toMatchObject({ lat: null, lng: null, occurredAt: AHORA.toISOString(), rideId: null });
  });
});

describe('normalizarIncidente — errores con código', () => {
  it('tipo desconocido o ausente', () => {
    expect(error({ category: 'flood' })).toMatchObject({ errorCode: 'INVALID_CATEGORY', field: 'category' });
    expect(error({})).toMatchObject({ errorCode: 'INVALID_CATEGORY' });
  });

  it('accidente sin severidad o con una inválida', () => {
    expect(error({ category: 'accident' })).toMatchObject({ errorCode: 'MISSING_SEVERITY', field: 'severity' });
    expect(error({ category: 'accident', severity: 'critical' })).toMatchObject({ errorCode: 'INVALID_SEVERITY' });
  });

  it('ubicación incompleta o fuera de rango', () => {
    expect(error({ category: 'other', location: { lat: 10.98 } })).toMatchObject({ errorCode: 'INVALID_LOCATION' });
    expect(error({ category: 'other', lat: 91, lng: 0 })).toMatchObject({ errorCode: 'INVALID_LOCATION' });
    expect(error({ category: 'other', lat: 'x', lng: 0 })).toMatchObject({ errorCode: 'INVALID_LOCATION' });
  });

  it('fecha inválida o en el futuro', () => {
    expect(error({ category: 'other', occurredAt: 'ayer' })).toMatchObject({ errorCode: 'INVALID_OCCURRED_AT' });
    expect(error({ category: 'other', occurredAt: '2026-09-16T19:00:00Z' })).toMatchObject({ errorCode: 'INVALID_OCCURRED_AT' });
  });

  it('acepta unos minutos de desfase de reloj', () => {
    expect(ok({ category: 'other', occurredAt: '2026-09-16T18:03:00Z' }).occurredAt).toBe('2026-09-16T18:03:00.000Z');
  });

  it('id de viaje inválido y descripción larga', () => {
    expect(error({ category: 'other', rideId: 'N/A' })).toMatchObject({ errorCode: 'INVALID_RIDE_ID' });
    expect(error({ category: 'other', description: 'a'.repeat(3001) })).toMatchObject({ errorCode: 'DESCRIPTION_TOO_LONG' });
  });
});

describe('telefonoEmergencias', () => {
  it('911 en EE. UU. y 123 en Colombia', () => {
    expect(telefonoEmergencias('US')).toBe('911');
    expect(telefonoEmergencias('co')).toBe('123');
  });

  it('null si el país no se conoce', () => {
    expect(telefonoEmergencias('ZZ')).toBeNull();
    expect(telefonoEmergencias(null)).toBeNull();
  });
});
