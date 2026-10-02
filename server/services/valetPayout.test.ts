import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/client', () => ({ supabaseAdmin: {} }));
vi.mock('./payoutRecovery', () => ({ estadoConnectAlDia: vi.fn(), cargoDelViaje: vi.fn() }));

import { comisionPagableCentavos } from './valetPayout';

const viaje = {
  id: 'r1', dispatched_by_valet: true, ride_status: 'completed', payment_status: 'paid',
  payment_method: 'card', payment_intent_id: 'pi_1', valet_surcharge: 10, valet_commission_paid: false,
};

describe('comisionPagableCentavos', () => {
  it('paga la comisión de un viaje con tarjeta, completado y cobrado', () => {
    expect(comisionPagableCentavos(viaje)).toBe(1000);
  });

  it('respeta los decimales', () => {
    expect(comisionPagableCentavos({ ...viaje, valet_surcharge: 12.35 })).toBe(1235);
  });

  it('no paga dos veces', () => {
    expect(comisionPagableCentavos({ ...viaje, valet_commission_paid: true })).toBe(0);
  });

  it('el efectivo solo se paga si se pide expresamente', () => {
    const efectivo = { ...viaje, payment_method: 'cash', payment_status: 'pending', payment_intent_id: null };
    expect(comisionPagableCentavos(efectivo)).toBe(0);
    expect(comisionPagableCentavos(efectivo, { efectivo: true })).toBe(1000);
  });

  it('el efectivo cancelado o ya pagado tampoco se paga', () => {
    const efectivo = { ...viaje, payment_method: 'cash', payment_status: 'pending', payment_intent_id: null };
    expect(comisionPagableCentavos({ ...efectivo, ride_status: 'cancelled' }, { efectivo: true })).toBe(0);
    expect(comisionPagableCentavos({ ...efectivo, valet_commission_paid: true }, { efectivo: true })).toBe(0);
  });

  it('no paga cancelados ni sin cobrar', () => {
    expect(comisionPagableCentavos({ ...viaje, ride_status: 'cancelled' })).toBe(0);
    expect(comisionPagableCentavos({ ...viaje, payment_status: 'refunded' })).toBe(0);
    expect(comisionPagableCentavos({ ...viaje, payment_intent_id: null })).toBe(0);
  });

  it('un viaje que no es de valet o sin comisión no genera nada', () => {
    expect(comisionPagableCentavos({ ...viaje, dispatched_by_valet: false })).toBe(0);
    expect(comisionPagableCentavos({ ...viaje, valet_surcharge: 0 })).toBe(0);
    expect(comisionPagableCentavos({ ...viaje, valet_surcharge: null })).toBe(0);
  });
});
