/**
 * Reserva por hora: cerrar el servicio y cobrar lo que pasó del bloque.
 *
 * El bloque se cobra al reservar, como toda reserva. Lo que pase de él —tiempo
 * extra y millas extra— se cobra aparte al terminar, contra la tarjeta guardada
 * del pasajero: el mismo camino que la propina y el cargo de limpieza. No se
 * suma al cobro de la reserva porque ese ya está hecho.
 *
 * Si la tarjeta rechaza o el banco pide autenticación, el extra queda `failed`
 * y el pasajero lo paga desde la app (`POST /api/rides/:id/hourly-extras/pay`).
 * Al chofer se le transfiere su parte cuando el cobro entra, no antes.
 */
import type Stripe from 'stripe';
import { pool } from '../db/pool';
import { logger } from '../lib/logger';
import { getStripe } from '../api/rides/helpers';
import { calculateStripeTax } from '../api/integrations';
import { getPlatformCommission } from '../config/pricing';
import { codigoPostalDeDirecciones } from './taxLocation';
import { tasaImpuestoRespaldo } from './taxConfig';
import { calcularReparto } from './rideMetrics';
import { ensureComisionFresh } from './commissionConfig';
import { estadoConnectAlDia } from './payoutRecovery';
import { notifyUser } from './fcm';
import { passengerNotif } from './notificationTemplates';
import { calcularExtras, inicioDelReloj, type EstadoExtras, type ResumenPorHora, type TerminosPorHora } from './hourlyBooking';
import { cargarServiciosPorHora, cerrarSeguimiento } from './hourlyTracking';

const err = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Stripe no cobra menos de esto. Un extra menor se perdona. */
const COBRO_MINIMO_CENTAVOS = 50;

async function impuestoDelExtra(rideId: string, centavos: number): Promise<number> {
  try {
    const { rows } = await pool.query(`SELECT pickup_address, dropoff_address FROM rides WHERE id = $1`, [rideId]);
    const postal = codigoPostalDeDirecciones(rows[0]?.pickup_address, rows[0]?.dropoff_address);
    const stripe = getStripe();
    if (stripe) {
      const calc = await calculateStripeTax(stripe, centavos, `hourly-extras-${rideId}`, postal);
      return calc.taxAmountCents / 100;
    }
    return Math.round(centavos * (await tasaImpuestoRespaldo())) / 100;
  } catch (e) {
    logger.warn(`[POR_HORA] ${rideId}: impuesto del extra con la tasa de respaldo: ${err(e)}`);
    return Math.round(centavos * (await tasaImpuestoRespaldo())) / 100;
  }
}

/**
 * Al terminar: cierra la medición, calcula el extra con su impuesto y lo deja
 * guardado como `pending` (o `none` si no hay). El cobro va después, aparte.
 * `null` si el viaje no es por hora.
 */
export async function cerrarServicioPorHora(
  rideId: string,
  terminadoEn: string,
): Promise<{ resumen: ResumenPorHora; estado: EstadoExtras; terminos: TerminosPorHora } | null> {
  const s = (await cargarServiciosPorHora([rideId])).get(rideId);
  if (!s) return null;

  const medido = await cerrarSeguimiento(rideId);
  const inicio = inicioDelReloj({
    scheduledAt: s.scheduled_at,
    arrivedAt: s.wait_started_at,
    startedAt: s.started_at ?? terminadoEn,
  });
  const fin = Date.parse(terminadoEn);
  const extras = calcularExtras(s.terminos, { elapsedMs: inicio === null ? 0 : fin - inicio, meters: medido.meters });

  const subtotalCents = Math.round(extras.extras_subtotal * 100);
  const impuesto = subtotalCents > 0 ? await impuestoDelExtra(rideId, subtotalCents) : 0;
  const total = r2(extras.extras_subtotal + impuesto);

  let driverShare = 0;
  if (subtotalCents > 0) {
    await ensureComisionFresh();
    driverShare = calcularReparto({
      fareCents: subtotalCents,
      taxCents: Math.round(impuesto * 100),
      commissionRate: getPlatformCommission(),
    }).driverPayoutCents / 100;
  }

  const perdonado = subtotalCents > 0 && Math.round(total * 100) < COBRO_MINIMO_CENTAVOS;
  const estado: EstadoExtras = subtotalCents > 0 && !perdonado ? 'pending' : 'none';
  const resumen: ResumenPorHora & { waived?: boolean } = {
    ...extras,
    starts_at: inicio === null ? null : new Date(inicio).toISOString(),
    ended_at: terminadoEn,
    extras_tax: impuesto,
    extras_total: total,
    gps_quality: medido.degraded ? 'degraded' : 'good',
    driver_share: driverShare,
    ...(perdonado ? { waived: true } : {}),
  };

  await pool.query(
    `UPDATE rides SET hourly_extras = $2::jsonb, hourly_extras_status = $3 WHERE id = $1`,
    [rideId, JSON.stringify(resumen), estado],
  );
  logger.info(`[POR_HORA] ${rideId}: cerrado. ${extras.elapsed_minutes} min, ${extras.miles_measured} mi, extra $${total} (${estado}).`);
  return { resumen, estado, terminos: s.terminos };
}

export type ResultadoExtras =
  | { status: 'charged'; paymentIntentId: string }
  | { status: 'requires_action'; paymentIntentId: string; clientSecret: string }
  | { status: 'failed'; errorCode: 'CARD_DECLINED' | 'NO_CARD' | 'PAYMENTS_UNAVAILABLE'; message: string }
  | { status: 'nothing_to_pay' };

interface FilaCobro {
  passenger_id: string | null;
  driver_id: string | null;
  payment_intent_id: string | null;
  hourly_extras: (ResumenPorHora & { attempts?: number; driver_transfer_id?: string }) | null;
  hourly_extras_status: EstadoExtras | null;
  hourly_extras_payment_intent_id: string | null;
  stripe_customer_id: string | null;
}

async function guardar(rideId: string, cambios: Record<string, unknown>, estado: EstadoExtras, piId?: string | null): Promise<void> {
  await pool.query(
    `UPDATE rides
        SET hourly_extras = COALESCE(hourly_extras, '{}'::jsonb) || $2::jsonb,
            hourly_extras_status = $3,
            hourly_extras_payment_intent_id = COALESCE($4, hourly_extras_payment_intent_id)
      WHERE id = $1
        -- Un fallo que llega tarde no pisa un cobro ya hecho.
        AND (hourly_extras_status IS DISTINCT FROM 'charged' OR $3 = 'charged')`,
    [rideId, JSON.stringify(cambios), estado, piId ?? null],
  );
}

/**
 * La tarjeta con la que se cobra el extra: la que pagó la reserva si quedó
 * guardada, si no la predeterminada, si no la primera.
 */
async function tarjetaParaElExtra(stripe: Stripe, customerId: string, reservaPi: string | null): Promise<string | null> {
  if (reservaPi) {
    try {
      const pi = await stripe.paymentIntents.retrieve(reservaPi);
      const pmId = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id;
      if (pmId) {
        const pm = await stripe.paymentMethods.retrieve(pmId);
        if (pm.customer === customerId) return pm.id;
      }
    } catch { /* se sigue con la predeterminada */ }
  }
  const cliente = await stripe.customers.retrieve(customerId);
  if (!('deleted' in cliente && cliente.deleted)) {
    const pred = (cliente as Stripe.Customer).invoice_settings?.default_payment_method;
    if (pred) return typeof pred === 'string' ? pred : pred.id;
  }
  const lista = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
  return lista.data[0]?.id ?? null;
}

/** Cobro hecho: se marca, se paga al chofer su parte y se avisa al pasajero. */
async function finalizar(stripe: Stripe, rideId: string, fila: FilaCobro, pi: Stripe.PaymentIntent): Promise<ResultadoExtras> {
  const { rowCount } = await pool.query(
    `UPDATE rides
        SET hourly_extras_status = 'charged',
            hourly_extras_payment_intent_id = $2,
            hourly_extras = COALESCE(hourly_extras, '{}'::jsonb) || jsonb_build_object('charged_at', NOW()::text)
      WHERE id = $1 AND hourly_extras_status IS DISTINCT FROM 'charged'`,
    [rideId, pi.id],
  );
  // Otro proceso ya lo marcó (el reintento del pasajero y el automático a la vez).
  if (!rowCount) return { status: 'charged', paymentIntentId: pi.id };

  const resumen = fila.hourly_extras;
  if (fila.passenger_id && resumen) {
    notifyUser(fila.passenger_id, passengerNotif.hourlyExtrasCharged(rideId, resumen.extras_total)).catch(() => {});
  }

  const parteCents = Math.round(Number(resumen?.driver_share ?? 0) * 100);
  if (fila.driver_id && parteCents > 0) {
    try {
      const { rows } = await pool.query(
        `SELECT stripe_account_id, stripe_connect_status FROM profiles WHERE id = $1`,
        [fila.driver_id],
      );
      const perfil = rows[0] as { stripe_account_id?: string; stripe_connect_status?: string } | undefined;
      const estado = await estadoConnectAlDia({
        stripe,
        driverId: fila.driver_id,
        accountId: perfil?.stripe_account_id,
        estadoGuardado: perfil?.stripe_connect_status,
      });
      if (estado !== 'active' || !perfil?.stripe_account_id) {
        logger.warn(`[POR_HORA] ${rideId}: extra cobrado, pero el chofer no puede recibir (${estado}). Pago pendiente.`);
        await guardar(rideId, { driver_transfer_status: 'pending' }, 'charged');
      } else {
        const transfer = await stripe.transfers.create({
          amount: parteCents,
          currency: 'usd',
          destination: perfil.stripe_account_id,
          source_transaction: typeof pi.latest_charge === 'string' ? pi.latest_charge : undefined,
          description: `Hourly booking extras for ride ${rideId}`,
          metadata: { ride_id: rideId, type: 'hourly_extras' },
        }, { idempotencyKey: `hourly_extras_transfer_${rideId}` });
        await guardar(rideId, { driver_transfer_id: transfer.id, driver_transfer_status: 'paid' }, 'charged');
      }
    } catch (e) {
      logger.error(`[POR_HORA] ${rideId}: extra cobrado (${pi.id}) pero la transferencia al chofer falló: ${err(e)}`);
      await guardar(rideId, { driver_transfer_status: 'failed' }, 'charged').catch(() => {});
    }
  }
  return { status: 'charged', paymentIntentId: pi.id };
}

/**
 * Cobra el extra. Sin `enSesion` es el cobro automático al terminar, fuera de
 * sesión. Con `enSesion` lo pide el pasajero desde la app: si el banco pide
 * autenticación devuelve el `clientSecret` para completarla, y la siguiente
 * llamada recoge el resultado.
 */
export async function cobrarExtrasPorHora(
  rideId: string,
  opts: { paymentMethodId?: string; enSesion?: boolean } = {},
): Promise<ResultadoExtras> {
  const { rows } = await pool.query(
    `SELECT r.passenger_id, r.driver_id, r.payment_intent_id, r.hourly_extras, r.hourly_extras_status,
            r.hourly_extras_payment_intent_id, p.stripe_customer_id
       FROM rides r LEFT JOIN profiles p ON p.id = r.passenger_id
      WHERE r.id = $1`,
    [rideId],
  );
  const fila = rows[0] as FilaCobro | undefined;
  if (!fila || !fila.hourly_extras) return { status: 'nothing_to_pay' };
  // El pasajero sólo paga lo que falló: mientras el cobro automático está en
  // marcha (`pending`), un segundo intento podría cobrar dos veces.
  const cobrables = opts.enSesion ? ['failed', 'requires_action'] : ['pending', 'failed', 'requires_action'];
  if (!fila.hourly_extras_status || !cobrables.includes(fila.hourly_extras_status)) {
    return { status: 'nothing_to_pay' };
  }
  const resumen = fila.hourly_extras;
  const cents = Math.round(Number(resumen.extras_total) * 100);
  if (!(cents >= COBRO_MINIMO_CENTAVOS)) return { status: 'nothing_to_pay' };

  const stripe = getStripe();
  if (!stripe) {
    await guardar(rideId, { failure_code: 'PAYMENTS_UNAVAILABLE' }, 'failed');
    return { status: 'failed', errorCode: 'PAYMENTS_UNAVAILABLE', message: 'Payments are not available right now.' };
  }

  // Un intento anterior pudo terminar bien tras la autenticación del banco.
  if (fila.hourly_extras_payment_intent_id) {
    try {
      const previo = await stripe.paymentIntents.retrieve(fila.hourly_extras_payment_intent_id);
      if (previo.status === 'succeeded') return await finalizar(stripe, rideId, fila, previo);
      if (previo.status === 'requires_action' && !opts.paymentMethodId && previo.client_secret) {
        return { status: 'requires_action', paymentIntentId: previo.id, clientSecret: previo.client_secret };
      }
    } catch (e) {
      logger.warn(`[POR_HORA] ${rideId}: no se pudo leer el intento anterior: ${err(e)}`);
    }
  }

  const fallo = async (errorCode: 'CARD_DECLINED' | 'NO_CARD', message: string, piId?: string | null, intento?: number) => {
    await guardar(rideId, { failure_code: errorCode, ...(intento ? { attempts: intento } : {}) }, 'failed', piId);
    if (!opts.enSesion && fila.passenger_id) {
      notifyUser(fila.passenger_id, passengerNotif.hourlyExtrasFailed(rideId, resumen.extras_total)).catch(() => {});
    }
    return { status: 'failed' as const, errorCode, message };
  };

  const customerId = fila.stripe_customer_id;
  if (!customerId) return fallo('NO_CARD', 'There is no saved card to charge.');

  let pmId: string | null;
  try {
    if (opts.paymentMethodId) {
      const pm = await stripe.paymentMethods.retrieve(opts.paymentMethodId);
      pmId = pm.customer === customerId ? pm.id : null;
    } else {
      pmId = await tarjetaParaElExtra(stripe, customerId, fila.payment_intent_id);
    }
  } catch {
    pmId = null;
  }
  if (!pmId) return fallo('NO_CARD', 'There is no saved card to charge.');

  const intento = Number(resumen.attempts ?? 0) + 1;
  const subtotalCents = Math.round(Number(resumen.extras_subtotal) * 100);
  const taxCents = Math.round(Number(resumen.extras_tax) * 100);
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create({
      amount: cents,
      currency: 'usd',
      customer: customerId,
      payment_method: pmId,
      payment_method_types: ['card'],
      confirm: true,
      ...(opts.enSesion ? {} : { off_session: true }),
      description: 'URBONT hourly booking — extra time and miles',
      metadata: {
        ride_id: rideId,
        type: 'hourly_extras',
        fare_cents: String(subtotalCents),
        tax_amount_cents: String(taxCents),
      },
    }, { idempotencyKey: `hourly_extras_${rideId}_${intento}` });
  } catch (e) {
    const piErr = (e as { payment_intent?: { id?: string } }).payment_intent;
    logger.warn(`[POR_HORA] ${rideId}: el cobro del extra falló (intento ${intento}): ${err(e)}`);
    return fallo('CARD_DECLINED', err(e), piErr?.id ?? null, intento);
  }

  if (pi.status === 'succeeded') {
    await guardar(rideId, { attempts: intento }, 'pending', pi.id);
    return finalizar(stripe, rideId, fila, pi);
  }
  if (pi.status === 'requires_action' && pi.client_secret) {
    await guardar(rideId, { attempts: intento }, 'requires_action', pi.id);
    return { status: 'requires_action', paymentIntentId: pi.id, clientSecret: pi.client_secret };
  }
  return fallo('CARD_DECLINED', `The payment ended in status ${pi.status}.`, pi.id, intento);
}

/** Lo que el pasajero debe de servicios por hora anteriores. */
export async function extrasPendientesDe(passengerId: string): Promise<{ rideId: string; amount: number; status: EstadoExtras } | null> {
  try {
    const { rows } = await pool.query(
      `SELECT id, hourly_extras, hourly_extras_status FROM rides
        WHERE passenger_id = $1 AND hourly_extras_status IN ('failed', 'requires_action')
        ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
      [passengerId],
    );
    const r = rows[0];
    if (!r) return null;
    return { rideId: String(r.id), amount: Number(r.hourly_extras?.extras_total ?? 0), status: r.hourly_extras_status };
  } catch (e) {
    // Si no se puede comprobar, no se bloquea a nadie.
    logger.warn(`[POR_HORA] No se pudo comprobar la deuda de ${passengerId}: ${err(e)}`);
    return null;
  }
}
