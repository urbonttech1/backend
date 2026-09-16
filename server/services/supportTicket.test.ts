import { describe, it, expect } from 'vitest';
import { normalizarTicket } from './supportTicket';

const RIDE = '07b47866-11aa-4ea6-8f21-dea545924727';

const ok = (body: Record<string, unknown>) => {
  const r = normalizarTicket(body);
  if ('errorCode' in r) throw new Error(`esperaba ok y llegó ${r.errorCode}`);
  return r.ticket;
};

describe('normalizarTicket — lo que envía hoy cada pantalla de la app', () => {
  it('SOS del conductor: seguridad urgente, con el viaje sacado del texto', () => {
    const t = ok({
      category: 'safety',
      subject: 'EMERGENCY — Driver SOS',
      message: `Driver emergency alert triggered. Ride ID: ${RIDE}. Time: 2026-09-16T17:54:00Z`,
      priority: 'urgent',
    });
    expect(t.esSOS).toBe(true);
    expect(t.category).toBe('safety');
    expect(t.rideId).toBe(RIDE);
  });

  it('SOS sin viaje en curso («Ride ID: N/A») queda sin viaje', () => {
    const t = ok({ category: 'safety', message: 'Driver emergency alert triggered. Ride ID: N/A.', priority: 'urgent' });
    expect(t.esSOS).toBe(true);
    expect(t.rideId).toBeNull();
  });

  it('Roadside: acepta la categoría y el campo message', () => {
    const t = ok({ category: 'roadside_assistance', subject: 'Roadside Assistance: flat tire', message: 'Driver requested roadside assistance — type: flat_tire' });
    expect(t.category).toBe('roadside_assistance');
    expect(t.subject).toBe('Roadside Assistance: flat tire');
    expect(t.description).toContain('flat_tire');
    expect(t.esSOS).toBe(false);
  });

  it('chat de soporte del conductor y del pasajero, sin asunto', () => {
    const conductor = ok({ message: 'hola', source: 'driver_chat', category: 'driver_support' });
    expect(conductor.category).toBe('support_chat');
    expect(conductor.subject).toBe('Support Chat');
    expect(conductor.description).toBe('hola');
    expect(ok({ message: 'hi', category: 'customer_support' }).category).toBe('support_chat');
  });

  it('objetos perdidos: el objeto pasa al asunto', () => {
    const t = ok({ category: 'phone', description: 'Lost phone in my recent ride' });
    expect(t.category).toBe('lost_item');
    expect(t.subject).toBe('Lost item: phone');
  });

  it('ayuda del dashboard: lost_object y payment_issue', () => {
    expect(ok({ category: 'lost_object', subject: 'Lost Object', message: 'No additional details provided.' }).category).toBe('lost_item');
    expect(ok({ category: 'payment_issue', subject: 'Payment Issue', message: 'x' }).category).toBe('billing');
  });

  it('pantalla de soporte de la cuenta, con el formato original', () => {
    const t = ok({ category: 'billing', subject: 'Double charge', description: 'I was charged twice', priority: 'high', ride_id: RIDE });
    expect(t).toMatchObject({ category: 'billing', subject: 'Double charge', priority: 'high', rideId: RIDE });
  });

  it('una categoría desconocida va a other y se conserva como asunto', () => {
    const t = ok({ category: 'vehicle_noise', message: 'Strange noise' });
    expect(t.category).toBe('other');
    expect(t.subject).toBe('vehicle_noise');
  });

  it('acepta rideId en camelCase', () => {
    expect(ok({ message: 'x', rideId: RIDE }).rideId).toBe(RIDE);
  });

  it('prioridad por defecto: normal', () => {
    expect(ok({ message: 'x' }).priority).toBe('normal');
  });
});

describe('normalizarTicket — errores con código', () => {
  it('sin descripción', () => {
    expect(normalizarTicket({ category: 'billing', subject: 'x' })).toMatchObject({ ok: false, errorCode: 'MISSING_DESCRIPTION', field: 'description' });
    expect(normalizarTicket({ message: '   ' })).toMatchObject({ ok: false, errorCode: 'MISSING_DESCRIPTION' });
  });

  it('descripción demasiado larga', () => {
    expect(normalizarTicket({ message: 'a'.repeat(3001) })).toMatchObject({ ok: false, errorCode: 'DESCRIPTION_TOO_LONG' });
  });

  it('prioridad inválida', () => {
    expect(normalizarTicket({ message: 'x', priority: 'medium' })).toMatchObject({ ok: false, errorCode: 'INVALID_PRIORITY', field: 'priority' });
  });

  it('id de viaje inválido', () => {
    expect(normalizarTicket({ message: 'x', ride_id: 'N/A' })).toMatchObject({ ok: false, errorCode: 'INVALID_RIDE_ID', field: 'rideId' });
  });
});
