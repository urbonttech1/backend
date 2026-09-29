import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/client', () => ({ supabaseAdmin: {} }));
vi.mock('../db/pool', () => ({ pool: {} }));
vi.mock('./fcm', () => ({ notifyUser: vi.fn(), sendMulticast: vi.fn() }));
vi.mock('./socketService', () => ({ broadcastScheduledOffer: vi.fn(), SCHEDULED_OFFER_RADIUS_KM: 0 }));
vi.mock('./driverRideHistory', () => ({ recordRideOffers: vi.fn() }));

import { scheduledStartableAt } from './scheduledOffer';

describe('scheduledStartableAt — desde cuándo el chofer puede iniciar la reserva', () => {
  it('abre la ventana `lead` minutos antes de la hora reservada', () => {
    expect(scheduledStartableAt('2026-10-03T15:00:00.000Z', 30)?.toISOString()).toBe('2026-10-03T14:30:00.000Z');
    expect(scheduledStartableAt('2026-10-03T15:00:00.000Z', 90)?.toISOString()).toBe('2026-10-03T13:30:00.000Z');
  });

  it('no retiene nada si la reserva no tiene una hora válida', () => {
    expect(scheduledStartableAt(null, 30)).toBeNull();
    expect(scheduledStartableAt(undefined, 30)).toBeNull();
    expect(scheduledStartableAt('mañana', 30)).toBeNull();
  });
});
