/**
 * Recuperar el dinero que el chofer no ha cobrado.
 *
 * Aquí vive lo que habla con Stripe y con la base; las reglas puras están en
 * `connectStatus.ts` y `pendingPayouts.ts`, que se pueden probar sin entorno.
 *
 * El problema que resuelve: el pago al chofer sólo se intentaba cuando
 * `profiles.stripe_connect_status` decía 'active', y esa columna la escribía
 * únicamente el webhook `account.updated`, al que el endpoint de Stripe nunca
 * estuvo suscrito. Choferes con la cuenta impecable —`transfers: active`,
 * `payouts_enabled`— quedaron marcados como «sin Connect», y sus viajes se
 * cobraron al pasajero sin transferirles nada.
 */

import type Stripe from 'stripe';
import { supabaseAdmin } from '../db/client';
import { logger } from '../lib/logger';
import { estadoDeCuenta, puedeCobrar, hayQueConsultarAStripe, type EstadoConnect, type CuentaConnect } from './connectStatus';
import { agruparDeuda, type ViajePendiente } from './pendingPayouts';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/**
 * El estado de verdad del chofer, consultando a Stripe si la columna no lo da
 * por activo, y dejando la columna al día.
 *
 * Nunca lanza: si Stripe no contesta se devuelve lo que decía la columna, que
 * es como se comportaba antes. Un pago que no se puede hacer hoy queda con
 * `driver_earnings` escrito y se recupera después.
 */
export async function estadoConnectAlDia(opts: {
  stripe: Stripe;
  driverId: string;
  accountId: string | null | undefined;
  estadoGuardado: string | null | undefined;
}): Promise<EstadoConnect> {
  const { stripe, driverId, accountId, estadoGuardado } = opts;

  if (!accountId) return 'not_connected';
  if (!hayQueConsultarAStripe(accountId, estadoGuardado)) return 'active';

  try {
    const cuenta = await stripe.accounts.retrieve(accountId);
    const estado = estadoDeCuenta(cuenta as CuentaConnect);
    if (estado !== estadoGuardado) {
      await supabaseAdmin
        .from('profiles')
        .update({ stripe_connect_status: estado, updated_at: new Date().toISOString() })
        .eq('id', driverId);
      logger.info(`[CONNECT] ${driverId} (${accountId}): ${estadoGuardado || 'sin estado'} → ${estado} según Stripe`);
    }
    return estado;
  } catch (err: unknown) {
    logger.error(`[CONNECT] No se pudo consultar ${accountId} en Stripe: ${err instanceof Error ? err.message : String(err)}`);
    return (estadoGuardado as EstadoConnect) || 'not_connected';
  }
}

export interface ResultadoPagoPendiente {
  viajesRevisados: number;
  viajesPagados: number;
  centavosPagados: number;
  choferesSinConnect: number;
}

/**
 * Paga lo que se deba, de todos los choferes o de uno solo.
 *
 * Nunca lanza: un chofer que falla no impide pagar a los demás, y un viaje que
 * falla se reintenta en la siguiente pasada. La clave de idempotencia es la
 * misma que usa el pago normal, así que un viaje no se paga dos veces aunque
 * el cron y el webhook coincidan.
 */
export async function pagarViajesPendientes(opts: {
  stripe: Stripe;
  /** Sin él, se repasan todos los choferes. */
  driverId?: string;
  /** Tope por pasada, para no encadenar cientos de llamadas a Stripe. */
  limite?: number;
}): Promise<ResultadoPagoPendiente> {
  const { stripe, driverId } = opts;
  const limite = opts.limite ?? 200;
  const resultado: ResultadoPagoPendiente = {
    viajesRevisados: 0, viajesPagados: 0, centavosPagados: 0, choferesSinConnect: 0,
  };

  let consulta = supabaseAdmin
    .from('rides')
    .select('id, driver_id, driver_earnings')
    .eq('ride_status', 'completed')
    .is('stripe_transfer_id', null)
    .gt('driver_earnings', 0)
    .limit(limite);
  if (driverId) consulta = consulta.eq('driver_id', driverId);

  const { data, error } = await consulta;
  if (error) {
    logger.error(`[PENDING_PAYOUTS] No se pudieron leer los viajes pendientes: ${error.message}`);
    return resultado;
  }

  const deuda = agruparDeuda((data ?? []) as ViajePendiente[]);
  resultado.viajesRevisados = deuda.reduce((n, d) => n + d.viajes.length, 0);
  if (deuda.length === 0) return resultado;

  for (const chofer of deuda) {
    const { data: perfil } = await supabaseAdmin
      .from('profiles')
      .select('stripe_account_id, stripe_connect_status')
      .eq('id', chofer.driverId)
      .maybeSingle();

    const accountId = perfil?.stripe_account_id as string | null;
    const estado = await estadoConnectAlDia({
      stripe,
      driverId: chofer.driverId,
      accountId,
      estadoGuardado: perfil?.stripe_connect_status as string | null,
    });

    if (!accountId || !puedeCobrar(estado)) {
      resultado.choferesSinConnect++;
      logger.info(`[PENDING_PAYOUTS] ${chofer.driverId} debe $${(chofer.totalCentavos / 100).toFixed(2)} pero sigue en '${estado}'.`);
      continue;
    }

    for (const viaje of chofer.viajes) {
      try {
        const transfer = await stripe.transfers.create({
          amount: viaje.centavos,
          currency: 'usd',
          destination: accountId,
          description: `Driver payout (atrasado) for completed ride ${viaje.id}`,
          metadata: {
            ride_id: viaje.id,
            driver_id: chofer.driverId,
            type: 'driver_ride_payout_catchup',
          },
        }, {
          idempotencyKey: `driver_catchup_${viaje.id}_${accountId}`,
        });

        await supabaseAdmin.from('rides').update({
          stripe_transfer_id: transfer.id,
          updated_at: new Date().toISOString(),
        }).eq('id', viaje.id);

        resultado.viajesPagados++;
        resultado.centavosPagados += viaje.centavos;
        logger.info(`[PENDING_PAYOUTS] $${(viaje.centavos / 100).toFixed(2)} a ${accountId} por el viaje ${viaje.id} (transfer ${transfer.id})`);
      } catch (err: unknown) {
        logger.error(`[PENDING_PAYOUTS] Falló el atrasado del viaje ${viaje.id}: ${errMsg(err)}`);
      }
    }
  }

  return resultado;
}
