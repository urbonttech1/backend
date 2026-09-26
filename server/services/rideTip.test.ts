import { describe, it, expect, vi, beforeEach } from 'vitest';

const viajes = { data: null as unknown, update: vi.fn() };
const perfiles: Record<string, unknown> = {};

vi.mock('../db/client', () => ({
  supabaseAdmin: {
    from: (tabla: string) => ({
      select: () => ({
        eq: (_c: string, valor: string) => ({
          maybeSingle: async () => ({
            data: tabla === 'rides' ? viajes.data : perfiles[valor] ?? null,
          }),
        }),
      }),
      update: (campos: unknown) => ({ eq: async () => { viajes.update(campos); return { data: null }; } }),
    }),
  },
}));
vi.mock('../lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./fcm', () => ({ notifyUser: vi.fn(async () => {}) }));
vi.mock('./payoutRecovery', () => ({ estadoConnectAlDia: vi.fn(async () => estadoDelChofer) }));

let estadoDelChofer = 'active';

import { cobrarPropina, fueRechazada } from './rideTip';

const PASAJERO = 'pax-1';
const CHOFER = 'drv-1';

const viajeCompleto = {
  id: 'ride-1', ride_status: 'completed', passenger_id: PASAJERO,
  driver_id: CHOFER, tip_amount: null, payment_method: 'card',
};

const stripeFalso = () => ({
  paymentMethods: { list: vi.fn(async () => ({ data: [{ id: 'pm_1' }] })) },
  paymentIntents: { create: vi.fn(async () => ({ id: 'pi_1', latest_charge: 'ch_1', status: 'succeeded' })) },
  transfers: { create: vi.fn(async () => ({ id: 'tr_1' })) },
});

const cobrar = (stripe: unknown, amount = 5) =>
  cobrarPropina({ stripe: stripe as never, rideId: 'ride-1', passengerId: PASAJERO, amount });

beforeEach(() => {
  estadoDelChofer = 'active';
  viajes.data = viajeCompleto;
  viajes.update.mockClear();
  perfiles[PASAJERO] = { stripe_customer_id: 'cus_1' };
  perfiles[CHOFER] = { stripe_account_id: 'acct_1', stripe_connect_status: 'active' };
});

describe('cobrarPropina', () => {
  it('cobra y transfiere la propina entera al chofer', async () => {
    const stripe = stripeFalso();
    const r = await cobrar(stripe, 5);

    expect(fueRechazada(r)).toBe(false);
    // Urbont no cobra comisión sobre la propina: van los 500 centavos.
    expect(stripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 500, destination: 'acct_1', source_transaction: 'ch_1' }),
      expect.anything(),
    );
  });

  it('el cobro va sin el pasajero delante, con su tarjeta guardada', async () => {
    // Sin esto Stripe rechaza la llamada antes de crear nada, que es lo que
    // pasaba: no hay ni un PaymentIntent de propina en toda la cuenta.
    const stripe = stripeFalso();
    await cobrar(stripe);
    expect(stripe.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_method: 'pm_1', off_session: true, confirm: true }),
      expect.anything(),
    );
  });

  it('no cobra si el chofer no puede recibir la propina', async () => {
    // El agujero que dejó $169 sin pagar: cobrar y descubrir después que no hay
    // a dónde mandarlo.
    estadoDelChofer = 'pending';
    const stripe = stripeFalso();
    const r = await cobrar(stripe);

    expect(fueRechazada(r) && r.codigo).toBe('CHOFER_NO_COBRABLE');
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
    expect(viajes.update).not.toHaveBeenCalled();
  });

  it('rechaza importes fuera de rango sin tocar Stripe', async () => {
    const stripe = stripeFalso();
    for (const monto of [0, -5, 201, NaN]) {
      const r = await cobrar(stripe, monto);
      expect(fueRechazada(r) && r.codigo).toBe('IMPORTE_INVALIDO');
    }
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('solo el pasajero del viaje puede dejar propina', async () => {
    const r = await cobrarPropina({
      stripe: stripeFalso() as never, rideId: 'ride-1', passengerId: 'otro', amount: 5,
    });
    expect(fueRechazada(r) && r.codigo).toBe('NO_ES_TU_VIAJE');
  });

  it('solo viajes completados, y no los de efectivo', async () => {
    viajes.data = { ...viajeCompleto, ride_status: 'in_progress' };
    expect(fueRechazada(await cobrar(stripeFalso())) && 'VIAJE_NO_VALIDO').toBe('VIAJE_NO_VALIDO');

    viajes.data = { ...viajeCompleto, payment_method: 'cash' };
    const r = await cobrar(stripeFalso());
    expect(fueRechazada(r) && r.codigo).toBe('VIAJE_NO_VALIDO');
  });

  it('no cobra dos veces el mismo viaje', async () => {
    viajes.data = { ...viajeCompleto, tip_amount: 5 };
    const r = await cobrar(stripeFalso());
    expect(fueRechazada(r) && r.codigo).toBe('YA_TIENE_PROPINA');
  });

  it('sin tarjeta guardada no se puede cobrar', async () => {
    perfiles[PASAJERO] = { stripe_customer_id: null };
    const r = await cobrar(stripeFalso());
    expect(fueRechazada(r) && r.codigo).toBe('SIN_TARJETA');
  });

  it('un cobro que no llega a succeeded no se registra ni se transfiere', async () => {
    // El fallo del 26/09: Stripe devolvió el PaymentIntent en
    // requires_payment_method sin lanzar error, y el codigo viejo lo dio por
    // bueno. El chofer vio $10 que nadie habia pagado.
    const stripe = stripeFalso();
    stripe.paymentIntents.create = vi.fn(async () => ({ id: 'pi_1', latest_charge: 'ch_1', status: 'requires_payment_method' }));

    const r = await cobrar(stripe);
    expect(fueRechazada(r) && r.codigo).toBe('COBRO_FALLIDO');
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    expect(viajes.update).not.toHaveBeenCalled();
  });

  it('si la transferencia falla, la propina queda registrada y el cobro hecho', async () => {
    // El pasajero ya pagó: devolver un error le haría reintentar y pagar otra vez.
    const stripe = stripeFalso();
    stripe.transfers.create = vi.fn(async () => { throw new Error('sin saldo'); });

    const r = await cobrar(stripe);
    expect(fueRechazada(r)).toBe(false);
    expect(!fueRechazada(r) && r.transferId).toBeUndefined();
    expect(viajes.update).toHaveBeenCalledWith(expect.objectContaining({ tip_amount: 5 }));
  });
});
