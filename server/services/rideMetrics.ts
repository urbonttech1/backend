/**
 * URBONT Ride Metrics — Stripe Connect commission engine
 *
 * La comisión de Urbont es la que se fija en el panel (`commissionConfig`, por
 * defecto el 15 %) y sale de dentro del precio.
 *
 * All monetary output is in cents (integer) for direct use with Stripe:
 *   - application_fee_amount → la comisión de Urbont
 *   - transfer_data.amount   → lo que le queda al chofer
 */

import { centavosDe, impuestoDelCobro } from './rideTax';
import { BOOKING_FEE_USD, PLATFORM_COMMISSION, getPlatformCommission } from '../config/pricing';

export interface RideMetricsInput {
  totalFareUSD: number;
  /** Tasa a aplicar; si no se da, la vigente del panel. */
  commissionRate?: number;
}

export interface RideMetricsResult {
  totalCents: number;
  applicationFeeCents: number;
  driverPayoutCents: number;
  commissionRate: number;
}

/**
 * Lo que se queda Urbont de cada viaje, contenido en el precio. Era una
 * constante del 15 % aquí mismo, así que cambiar la comisión en el panel no
 * movía ni un centavo de los cobros ni de los pagos: sólo se guardaba. Ahora es
 * la del panel (`getPlatformCommission`, que se refresca con
 * `ensureComisionFresh`), y quien ya cobró pasa la tasa con la que lo hizo.
 */
function tasa(commissionRate?: number): number {
  return commissionRate !== undefined && Number.isFinite(commissionRate) && commissionRate >= 0 && commissionRate <= 0.5
    ? commissionRate
    : getPlatformCommission();
}

/**
 * La comisión con la que se creó un cobro, guardada en su metadata
 * (`commission_rate`). Pagarle al chofer con esa y no con la del día evita que,
 * si el panel la cambia entre el cobro y el pago, el reparto de Stripe y lo
 * apuntado en el viaje digan cosas distintas. `null` si no la trae.
 */
export function tasaDelCobro(metadata: Record<string, unknown> | null | undefined): number | null {
  const crudo = metadata?.commission_rate;
  const n = typeof crudo === 'string' && crudo.trim() !== '' ? Number(crudo) : typeof crudo === 'number' ? crudo : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 0.5 ? n : null;
}

/**
 * calculateRideMetrics
 *
 * Commission: la del panel (o `commissionRate`), el resto al chofer.
 *
 * @param input.totalFareUSD - Total trip fare in USD (e.g. 45.50)
 *
 * @example
 *   const m = calculateRideMetrics({ totalFareUSD: 45.50 });
 *   await stripe.paymentIntents.create({
 *     amount: m.totalCents,
 *     application_fee_amount: m.applicationFeeCents,
 *     transfer_data: { destination: driverStripeAccountId },
 *   });
 */
export interface RepartoInput {
  /** Precio del viaje en centavos, SIN impuesto: es lo que se reparte. */
  fareCents: number;
  /** Impuesto en centavos. Lo retiene la plataforma para declararlo. */
  taxCents?: number;
  /**
   * Comisión del valet en centavos, si el viaje lo despachó uno. Va dentro de
   * `fareCents` porque se le cobra al huésped, pero no es parte del servicio del
   * chofer: sin descontarla, el chofer se llevaba el 90 % de una comisión que es
   * de otro.
   */
  valetCents?: number;
  /**
   * Booking fijo, en centavos, que Urbont retiene entero. Va dentro del precio
   * y se resta de la parte del chofer después del 15 %, en instantáneo y en reserva.
   */
  bookingFeeCents?: number;
  /**
   * Aeropuerto o puerto, en centavos. Está dentro del precio y lleva impuesto,
   * pero no entra en el 15 %: Urbont se lo queda entero.
   */
  accessFeeCents?: number;
  /** Tasa a aplicar (la del cobro, si ya se cobró); si no se da, la del panel. */
  commissionRate?: number;
}

export interface RepartoResult {
  /** Lo que se le cobra a la tarjeta: precio + impuesto. */
  chargeCents: number;
  /** Lo que retiene la plataforma: su 15 %, el impuesto y la comisión del valet. */
  applicationFeeCents: number;
  /** Lo que le queda al chofer: el 85 % del servicio, sin impuesto ni comisión ajena. */
  driverPayoutCents: number;
  commissionRate: number;
}

/**
 * El reparto de un cobro con Stripe Connect.
 *
 * En un destination charge se manda `application_fee_amount` y el resto va al
 * chofer. Antes se mandaban a la vez `application_fee_amount` y
 * `transfer_data.amount`, que Stripe rechaza, así que el primer chofer con
 * cuenta conectada no habría podido cobrar.
 *
 * El impuesto va DENTRO de la comisión: lo retiene la plataforma porque es
 * quien lo declara, y así al chofer le llega el 90 % del precio limpio.
 */
/** El booking fijo, en centavos. Urbont se lo queda entero en un viaje de ahora. */
export const BOOKING_FEE_CENTS = Math.round(BOOKING_FEE_USD * 100);

/**
 * Cuánto booking se le resta al chofer.
 *
 * Urbont retiene los $2.50 completos, además del 15 % del precio, tanto en un
 * viaje instantáneo como en una reserva. El argumento se queda para que quien
 * llama pueda pasar el viaje sin cambiar de firma.
 */
export function bookingRetenidoPorUrbont(_viaje?: {
  scheduled_at?: unknown;
  booking_type?: unknown;
}): number {
  return BOOKING_FEE_CENTS;
}

export function calcularReparto({
  fareCents,
  taxCents = 0,
  valetCents = 0,
  bookingFeeCents = 0,
  accessFeeCents = 0,
  commissionRate,
}: RepartoInput): RepartoResult {
  if (fareCents < 0 || taxCents < 0 || valetCents < 0 || bookingFeeCents < 0 || accessFeeCents < 0) {
    throw new RangeError('los importes no pueden ser negativos');
  }
  if (valetCents > fareCents) throw new RangeError('la comisión del valet no puede superar el precio');

  // El aeropuerto y el puerto se cobran en el precio, pero no se reparten:
  // Urbont se queda esos $10 enteros y el 15 % sale de lo que queda.
  const acceso = Math.min(accessFeeCents, Math.max(0, fareCents - valetCents));
  const servicio = fareCents - valetCents - acceso;
  const rate = tasa(commissionRate);
  const comision = Math.round(servicio * rate);
  // Los $2.50 salen de la parte del chofer, después del 15 %.
  const booking = Math.min(bookingFeeCents, Math.max(0, servicio - comision));
  return {
    chargeCents:         fareCents + taxCents,
    applicationFeeCents: comision + taxCents + valetCents + booking + acceso,
    driverPayoutCents:   servicio - comision - booking,
    commissionRate:      rate,
  };
}

export function calculateRideMetrics(input: RideMetricsInput): RideMetricsResult {
  const { totalFareUSD } = input;

  if (totalFareUSD < 0) throw new RangeError('totalFareUSD cannot be negative');

  const rate = tasa(input.commissionRate);
  const totalCents = Math.round(totalFareUSD * 100);
  const applicationFeeCents = Math.round(totalCents * rate);
  const driverPayoutCents = totalCents - applicationFeeCents;

  return {
    totalCents,
    applicationFeeCents,
    driverPayoutCents,
    commissionRate: rate,
  };
}

export interface GananciaAjustada {
  /** Lo que le corresponde al chofer, en dólares. */
  ganancia: number;
  /** Impuesto que se quedó en la plataforma, en dólares. */
  impuesto: number;
  /** Comisión de Urbont más el impuesto y el valet, en dólares. */
  comisionPlataforma: number;
  /** true cuando `driver_earnings` se había calculado sobre la tarjeta entera. */
  corregida: boolean;
}

/**
 * Corrige una ganancia que se calculó sobre el cobro con impuesto.
 *
 * Pasa en los viajes cuyo `tax_amount` nunca se guardó: el 85 % se aplicó a
 * los $31.42 de la tarjeta y quedó $26.71, en vez del 85 % de los $29.50.
 * Solo se toca si el número guardado es exactamente ese reparto inflado y el
 * dinero todavía no salió (quien llama no transfiere si ya hay transferencia).
 */
export function gananciaSiRepartioElImpuesto(viaje: {
  driver_earnings?: unknown;
  fare?: unknown;
  locked_fare?: unknown;
  tax_amount?: unknown;
  total_price?: unknown;
  wait_fee?: unknown;
  valet_surcharge?: unknown;
}): GananciaAjustada {
  const stored = centavosDe(viaje.driver_earnings);
  const fareCents = centavosDe(viaje.locked_fare) || centavosDe(viaje.fare);
  const captured = centavosDe(viaje.total_price);
  const sinCambio: GananciaAjustada = {
    ganancia: stored / 100,
    impuesto: centavosDe(viaje.tax_amount) / 100,
    comisionPlataforma: 0,
    corregida: false,
  };
  if (stored === 0 || captured <= fareCents) return sinCambio;

  const tax = impuestoDelCobro({
    taxAmount: viaje.tax_amount,
    capturedCents: captured,
    fare: viaje.fare,
    lockedFare: viaje.locked_fare,
    waitFee: viaje.wait_fee,
  });
  if (tax <= 0 || captured <= tax) return sinCambio;

  const valet = Math.min(centavosDe(viaje.valet_surcharge), captured - tax);
  // Esos viajes se repartieron con el 15 % de entonces: es contra ese número
  // que se reconoce el error, aunque el panel tenga hoy otra comisión.
  const historica = PLATFORM_COMMISSION;
  const bien = calcularReparto({ fareCents: captured - tax, taxCents: tax, valetCents: valet, commissionRate: historica });
  const inflado = calcularReparto({ fareCents: captured, taxCents: 0, valetCents: valet, commissionRate: historica });
  if (stored !== inflado.driverPayoutCents || bien.driverPayoutCents >= stored) return sinCambio;

  return {
    ganancia: bien.driverPayoutCents / 100,
    impuesto: tax / 100,
    comisionPlataforma: bien.applicationFeeCents / 100,
    corregida: true,
  };
}
