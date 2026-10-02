/**
 * Pagar al valet la comisión que se le quedó debiendo.
 *
 * La comisión se transfiere en el momento del cobro con tarjeta (webhook de
 * Stripe), pero solo si el valet ya tiene su cuenta conectada. Si no la tenía, el
 * webhook lo dejaba en el log y la comisión se quedaba sin pagar para siempre:
 * conectar la cuenta después no la recuperaba. Esto la recupera.
 *
 * Solo viajes cobrados con tarjeta y completados. Los de efectivo no pasan por
 * Stripe —el valet no recibe nada por esa vía— y los cancelados o reembolsados
 * no generan comisión.
 */
import type Stripe from 'stripe';
import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';
import { puedeCobrar } from './connectStatus';
import { estadoConnectAlDia, cargoDelViaje } from './payoutRecovery';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export interface ViajeConComision {
  id: string;
  valet_surcharge?: unknown;
  valet_commission_paid?: unknown;
  payment_method?: unknown;
  payment_status?: unknown;
  payment_intent_id?: unknown;
  ride_status?: unknown;
  dispatched_by_valet?: unknown;
}

export const esEfectivo = (v: ViajeConComision): boolean => String(v.payment_method ?? '').toLowerCase() === 'cash';

/**
 * Centavos de comisión que se le pueden pagar por ese viaje; 0 si no corresponde.
 *
 * Con tarjeta, el cobro ya pasó por Stripe. En efectivo el conductor cobra todo en
 * mano y la plataforma lo anota como lo que él le debe (`platform_fee_amount`):
 * la comisión del valet la adelanta la plataforma y se recupera de ahí. Por eso
 * el efectivo solo se paga si se pide expresamente (`efectivo`).
 */
export function comisionPagableCentavos(v: ViajeConComision, opts: { efectivo?: boolean } = {}): number {
  if (v.dispatched_by_valet !== true) return 0;
  if (v.valet_commission_paid === true) return 0;
  if (v.ride_status !== 'completed') return 0;
  if (esEfectivo(v)) {
    if (!opts.efectivo) return 0;
  } else {
    if (v.payment_status !== 'paid') return 0;
    if (!v.payment_intent_id) return 0;
  }
  const usd = Number(v.valet_surcharge);
  return Number.isFinite(usd) && usd > 0 ? Math.round(usd * 100) : 0;
}

export interface ResultadoComisiones {
  viajesRevisados: number;
  viajesPagados: number;
  centavosPagados: number;
  valetsSinConnect: number;
}

/** De todos los valets o de uno. Nunca lanza: un fallo se reintenta en la siguiente pasada. */
export async function pagarComisionesValetPendientes(opts: {
  stripe: Stripe;
  valetId?: string;
  limite?: number;
  /** Incluye los viajes en efectivo. Solo desde el panel: el cron nunca los paga. */
  efectivo?: boolean;
}): Promise<ResultadoComisiones> {
  const { stripe, valetId } = opts;
  const resultado: ResultadoComisiones = { viajesRevisados: 0, viajesPagados: 0, centavosPagados: 0, valetsSinConnect: 0 };

  let consulta = supabaseAdmin.from('rides')
    .select('id, valet_user_id, valet_surcharge, valet_commission_paid, payment_method, payment_status, payment_intent_id, ride_status, dispatched_by_valet')
    .eq('dispatched_by_valet', true)
    .eq('ride_status', 'completed')
    .not('valet_user_id', 'is', null)
    .or('valet_commission_paid.is.null,valet_commission_paid.eq.false')
    .gt('valet_surcharge', 0)
    .limit(opts.limite ?? 200);
  if (valetId) consulta = consulta.eq('valet_user_id', valetId);

  const { data, error } = await consulta;
  if (error) {
    logger.error(`[VALET_PAYOUT] No se pudieron leer las comisiones pendientes: ${error.message}`);
    return resultado;
  }

  const porValet = new Map<string, Array<ViajeConComision & { centavos: number }>>();
  for (const fila of (data ?? []) as Array<ViajeConComision & { valet_user_id: string }>) {
    const centavos = comisionPagableCentavos(fila, { efectivo: opts.efectivo });
    if (centavos <= 0) continue;
    const lista = porValet.get(fila.valet_user_id) ?? [];
    lista.push({ ...fila, centavos });
    porValet.set(fila.valet_user_id, lista);
    resultado.viajesRevisados++;
  }

  for (const [id, viajes] of porValet) {
    const { data: perfil } = await supabaseAdmin.from('profiles')
      .select('stripe_account_id, stripe_connect_status').eq('id', id).maybeSingle();
    const accountId = perfil?.stripe_account_id as string | null;
    const estado = await estadoConnectAlDia({
      stripe, driverId: id, accountId, estadoGuardado: perfil?.stripe_connect_status as string | null,
    });
    if (!accountId || !puedeCobrar(estado)) {
      resultado.valetsSinConnect++;
      continue;
    }

    for (const v of viajes) {
      try {
        // Atada al cobro del viaje: sin `source_transaction` tira del saldo de la
        // plataforma, que los payouts automáticos dejan en cero.
        const efectivo = esEfectivo(v);
        // En efectivo no hay cargo del que colgarse: sale del saldo de la plataforma.
        const cargo = efectivo ? null : await cargoDelViaje(stripe, String(v.payment_intent_id));
        const transfer = await stripe.transfers.create({
          amount: v.centavos,
          currency: 'usd',
          destination: accountId,
          ...(cargo ? { source_transaction: cargo } : {}),
          description: `Valet commission (${efectivo ? 'cash' : 'catch-up'}) for ride ${v.id}`,
          metadata: { ride_id: v.id, valet_user_id: id, type: efectivo ? 'valet_commission_cash' : 'valet_commission_catchup' },
        }, {
          // Con tarjeta, la misma clave que usa el webhook: si ya la pagó, Stripe lo reconoce.
          idempotencyKey: efectivo ? `valet_commission_cash_${v.id}` : `valet_commission_${v.id}_${String(v.payment_intent_id)}`,
        });
        await supabaseAdmin.from('rides').update({
          valet_commission_paid: true,
          valet_commission_transfer_id: transfer.id,
          updated_at: new Date().toISOString(),
        }).eq('id', v.id);
        resultado.viajesPagados++;
        resultado.centavosPagados += v.centavos;
        logger.info(`[VALET_PAYOUT] $${(v.centavos / 100).toFixed(2)} a ${accountId} por el viaje ${v.id} (transfer ${transfer.id})`);
      } catch (err: unknown) {
        logger.error(`[VALET_PAYOUT] Falló la comisión del viaje ${v.id} (${(err as { code?: string })?.code || 'sin código'}): ${errMsg(err)}`);
      }
    }
  }
  return resultado;
}
