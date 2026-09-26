import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
import Stripe from 'stripe';
import { requireSupabaseAuth } from '../middleware';
import { cobrarPropina, fueRechazada } from '../services/rideTip';
import { supabaseAdmin } from '../db/client';

const _TIPS_SK = process.env.STRIPE_SECRET_KEY || '';
let _tipsStripe: Stripe | null = null;
function getStripe(): Stripe | null {
  if (_tipsStripe) return _tipsStripe;
  if (!_TIPS_SK) { logger.warn('[WARN] STRIPE_SECRET_KEY not set — tips unavailable.'); return null; }
  _tipsStripe = new Stripe(_TIPS_SK);
  return _tipsStripe;
}

export const tipsRouter = Router();

// POST /api/tips/:rideId — add a tip to a completed ride
tipsRouter.post('/:rideId', requireSupabaseAuth, async (req: Request, res: Response) => {
  // La pantalla de historial llama aquí. Antes cobraba la propina y no
  // transfería nada al chofer: el dinero se quedaba en la cuenta de Urbont.
  // Ahora usa el mismo servicio que las rutas de viaje.
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: 'Payment service unavailable' });

  try {
    const resultado = await cobrarPropina({
      stripe,
      rideId: req.params.rideId,
      passengerId: req.supabaseUid!,
      amount: Number((req.body as { amount?: number }).amount),
    });

    if (fueRechazada(resultado)) {
      return res.status(resultado.estado).json({ error: resultado.motivo, code: resultado.codigo });
    }

    return res.json({
      success: true,
      tipAmount: resultado.monto,
      paymentIntentId: resultado.paymentIntentId,
      transferId: resultado.transferId,
    });
  } catch (err: unknown) {
    logger.error(`[TIPS] Error creating tip payment: ${errMsg(err)}`);
    return res.status(500).json({ error: 'Failed to process tip' });
  }
});

// GET /api/tips/:rideId — get tip status for a ride
tipsRouter.get('/:rideId', requireSupabaseAuth, async (req: Request, res: Response) => {
  const uid = req.supabaseUid!;
  const { data: ride } = await supabaseAdmin
    .from('rides')
    .select('tip_amount, tip_pi_id')
    .eq('id', req.params.rideId)
    .eq('passenger_id', uid)
    .maybeSingle();

  res.json({ tipAmount: ride?.tip_amount || null, tipPiId: ride?.tip_pi_id || null });
});
