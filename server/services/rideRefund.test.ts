import { describe, it, expect, vi, beforeEach } from 'vitest';

const stripe = {
  paymentIntents: { retrieve: vi.fn(), cancel: vi.fn() },
  refunds: { create: vi.fn() },
};
vi.mock('../api/rides/helpers', () => ({ getStripe: () => stripe }));
vi.mock('../lib/logger', () => ({
  createContextLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
// El reembolso ahora se registra, y ese servicio importa la base: sin este
// mock el test abriría una conexión real sólo para comprobar a quién llama.
const registrarEvento = vi.fn();
vi.mock('./paymentEvents', () => ({
  registrarEvento: (...a: unknown[]) => registrarEvento(...a),
  eventoDesdeReembolso: (r: { id: string }) => ({ kind: 'refund', stripe_object_id: r.id }),
}));

import { devolverCobroDelViaje } from './rideRefund';

beforeEach(() => vi.clearAllMocks());

describe('devolverCobroDelViaje — viaje cancelado por el sistema', () => {
  it('reembolsa entero lo que se cobró al reservar', async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_1', status: 'succeeded' });
    stripe.refunds.create.mockResolvedValue({ id: 're_1' });
    await devolverCobroDelViaje('pi_1', 'ride-1');
    expect(stripe.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_1' });
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it('deja registrado el reembolso contra su viaje', async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_6', status: 'succeeded' });
    stripe.refunds.create.mockResolvedValue({ id: 're_6' });
    await devolverCobroDelViaje('pi_6', 'ride-6');
    expect(registrarEvento).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'refund', stripe_object_id: 're_6' }),
      'ride-6',
    );
  });

  it('liberar una retención no registra nada: no salió dinero', async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_7', status: 'requires_capture' });
    await devolverCobroDelViaje('pi_7', 'ride-7');
    expect(registrarEvento).not.toHaveBeenCalled();
  });

  it('libera la retención si aún no se había capturado', async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_2', status: 'requires_capture' });
    await devolverCobroDelViaje('pi_2', 'ride-2');
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_2');
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it('no toca un pago que nunca se completó', async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_3', status: 'requires_payment_method' });
    await devolverCobroDelViaje('pi_3', 'ride-3');
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it('sin pago asociado no llama a Stripe', async () => {
    await devolverCobroDelViaje(null, 'ride-4');
    expect(stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it('un fallo de Stripe no se propaga al cron', async () => {
    stripe.paymentIntents.retrieve.mockRejectedValue(new Error('network'));
    await expect(devolverCobroDelViaje('pi_5', 'ride-5')).resolves.toBeUndefined();
  });
});
