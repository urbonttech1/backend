import { Router, Request, Response } from "express";
import { requireSupabaseAuth } from "../../middleware";
import { logger } from '../../lib/logger';
import { usoEnVivo } from "../../services/hourlyBooking";
import { cargarServiciosPorHora } from "../../services/hourlyTracking";
import { cobrarExtrasPorHora, extrasPendientesDe } from "../../services/hourlyExtrasPayment";
import { errMsg } from './helpers';

/**
 * Reserva por hora: el contador en vivo y el pago del extra que falló.
 * Contrato para la app en `docs/API_RESERVA_POR_HORA_MOBILE.md`.
 */
export function registerHourlyRoutes(router: Router): void {

// GET /api/rides/hourly-extras/outstanding — lo que el pasajero debe de un servicio
// por hora. La app lo mira antes de dejarle reservar otro.
router.get('/hourly-extras/outstanding', requireSupabaseAuth, async (req: Request, res: Response) => {
  const deuda = await extrasPendientesDe(String(req.supabaseUid));
  return res.json({ outstanding: deuda });
});

// GET /api/rides/:id/hourly-usage — tiempo y millas del servicio hasta ahora.
router.get('/:id/hourly-usage', requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const s = (await cargarServiciosPorHora([req.params.id])).get(req.params.id);
    if (!s) return res.status(400).json({ error: 'This ride is not an hourly booking.', errorCode: 'NOT_HOURLY' });

    const uid = req.supabaseUid;
    if (req.supabaseRole !== 'admin' && s.passenger_id !== uid && s.driver_id !== uid) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    return res.json(usoEnVivo(s.id, s.terminos, s));
  } catch (err: unknown) {
    logger.error(`[POR_HORA] hourly-usage ${req.params.id}: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Failed to fetch hourly usage' });
  }
});

// POST /api/rides/:id/hourly-extras/pay — el pasajero paga el extra que no se
// pudo cobrar solo. Si el banco pide autenticación, devuelve el clientSecret;
// tras completarla, la app llama otra vez y aquí se recoge el resultado.
router.post('/:id/hourly-extras/pay', requireSupabaseAuth, async (req: Request, res: Response) => {
  try {
    const s = (await cargarServiciosPorHora([req.params.id])).get(req.params.id);
    if (!s) return res.status(400).json({ error: 'This ride is not an hourly booking.', errorCode: 'NOT_HOURLY' });
    if (s.passenger_id !== req.supabaseUid) {
      return res.status(403).json({ error: 'Only the passenger can pay for this ride.' });
    }

    const { paymentMethodId } = req.body as { paymentMethodId?: unknown };
    const resultado = await cobrarExtrasPorHora(req.params.id, {
      enSesion: true,
      paymentMethodId: typeof paymentMethodId === 'string' && paymentMethodId ? paymentMethodId : undefined,
    });

    switch (resultado.status) {
      case 'charged':
        return res.json(resultado);
      case 'requires_action':
        return res.json(resultado);
      case 'nothing_to_pay':
        return res.status(409).json({ error: 'There is nothing to pay for this ride.', errorCode: 'NOTHING_TO_PAY' });
      case 'failed':
        return res.status(resultado.errorCode === 'PAYMENTS_UNAVAILABLE' ? 503 : 402).json(resultado);
    }
  } catch (err: unknown) {
    logger.error(`[POR_HORA] hourly-extras/pay ${req.params.id}: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Failed to charge the hourly extras' });
  }
});

}
