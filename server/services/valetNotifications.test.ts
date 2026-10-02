import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/client', () => ({ supabaseAdmin: {} }));
vi.mock('./fcm', () => ({ notifyUser: vi.fn() }));

import { paraValet } from './valetNotifications';

const base = (type: string) => ({
  title: 'Your driver has arrived!',
  body: 'Your chauffeur is at the pickup location.',
  data: { type, ride_id: 'r1', screen: 'ride_tracking' },
});

describe('paraValet', () => {
  it('nombra al huésped y la reserva', () => {
    const p = paraValet(base('driver_arrived'), { guest: 'Mr. Smith', ref: 'URB-ABC123' });
    expect(p.title).toBe('Driver has arrived');
    expect(p.body).toContain('Mr. Smith (URB-ABC123)');
  });

  it('sin nombre usa «your guest»', () => {
    expect(paraValet(base('ride_completed')).body).toContain('your guest');
  });

  it('lleva siempre al dashboard del valet y conserva el evento original', () => {
    const p = paraValet(base('ride_confirmed'), { guest: 'Ana' });
    expect(p.data).toMatchObject({ type: 'valet_ride_update', event: 'ride_confirmed', screen: 'valet-dashboard', ride_id: 'r1' });
  });

  it('un tipo desconocido conserva el texto pero cambia la pantalla', () => {
    const p = paraValet({ title: 'X', body: 'Y', data: { type: 'otro' } });
    expect(p.title).toBe('X');
    expect(p.data?.screen).toBe('valet-dashboard');
  });
});
