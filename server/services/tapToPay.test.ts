import { describe, it, expect } from 'vitest';
import { decidirCobroPresencial } from './tapToPay';

const CHOFER = 'd1';
const base = { driver_id: CHOFER, ride_status: 'in_progress', payment_status: 'pending', locked_fare: 38, fare: 30 };

describe('decidirCobroPresencial', () => {
  it('cobra el precio garantizado en centavos', () => {
    expect(decidirCobroPresencial(base, CHOFER)).toEqual({ ok: true, fareCents: 3800 });
  });

  it('usa fare si no hay precio garantizado', () => {
    expect(decidirCobroPresencial({ ...base, locked_fare: null }, CHOFER)).toEqual({ ok: true, fareCents: 3000 });
  });

  it('solo el chofer del viaje puede cobrarlo', () => {
    expect(decidirCobroPresencial(base, 'otro')).toMatchObject({ ok: false, errorCode: 'NOT_YOUR_RIDE' });
  });

  it('no cobra dos veces', () => {
    expect(decidirCobroPresencial({ ...base, payment_status: 'paid' }, CHOFER)).toMatchObject({ ok: false, errorCode: 'ALREADY_PAID' });
  });

  it('no cobra antes de recoger al pasajero', () => {
    expect(decidirCobroPresencial({ ...base, ride_status: 'accepted' }, CHOFER)).toMatchObject({ ok: false, errorCode: 'RIDE_NOT_STARTED' });
  });

  it('rechaza precios inválidos', () => {
    expect(decidirCobroPresencial({ ...base, locked_fare: 0.2 }, CHOFER)).toMatchObject({ ok: false, errorCode: 'INVALID_FARE' });
    expect(decidirCobroPresencial({ ...base, locked_fare: 'x', fare: null }, CHOFER)).toMatchObject({ ok: false, errorCode: 'INVALID_FARE' });
  });

  it('suma la espera al precio garantizado', () => {
    expect(decidirCobroPresencial({ ...base, wait_fee: 7.5 }, CHOFER)).toEqual({ ok: true, fareCents: 4550 });
  });

  it('no suma la espera a fare, que ya la incluye', () => {
    expect(decidirCobroPresencial({ ...base, locked_fare: null, fare: 45.5, wait_fee: 7.5 }, CHOFER)).toEqual({ ok: true, fareCents: 4550 });
  });

  it('no cobra un viaje ya pagado con tarjeta en la app', () => {
    expect(decidirCobroPresencial({ ...base, payment_intent_id: 'pi_123' }, CHOFER)).toMatchObject({ ok: false, errorCode: 'ALREADY_HAS_CARD_PAYMENT' });
  });

  it('viaje inexistente', () => {
    expect(decidirCobroPresencial(null, CHOFER)).toMatchObject({ ok: false, status: 404 });
  });
});
