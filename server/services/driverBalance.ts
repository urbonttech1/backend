/**
 * Cuánto dinero tiene un chofer y cuánto puede sacar hoy.
 *
 * La app le mostraba «$128.71» sumando `rides.fare` de sus viajes: la tarifa
 * completa que pagó el pasajero, no lo que le toca a él. Y ese número no tenía
 * nada que ver con lo que de verdad podía retirar, que era $0.
 *
 * El dinero de un chofer vive en tres sitios distintos y conviene no mezclarlos,
 * porque solo uno se puede retirar:
 *
 *   1. En Urbont  — viajes completados cuyo `driver_earnings` aún no se le ha
 *                   transferido. Es una deuda, no un saldo: para retirarlo hay
 *                   que transferirlo antes a su cuenta de Stripe.
 *   2. En camino  — ya transferido, pero Stripe todavía no lo ha liberado.
 *   3. Disponible — en su cuenta de Stripe y libre. Esto es lo único retirable.
 *
 * Reglas puras, sin base de datos ni Stripe, para poder probarlas.
 */

export interface SaldoStripe {
  /** Libre en su cuenta conectada, en centavos. */
  disponibleCents: number;
  /** Cobrado pero aún no liberado por Stripe, en centavos. */
  enCaminoCents: number;
  /** Lo que admite un payout instantáneo, si tiene tarjeta de débito. */
  instantaneoCents?: number;
}

export interface ResumenSaldo {
  /** Deuda de Urbont con el chofer: aún no ha salido de nuestra cuenta. */
  enUrbontCents: number;
  enCaminoCents: number;
  disponibleCents: number;
  /** Todo junto, que es lo que el chofer entiende por «lo que tengo». */
  totalCents: number;
  /** Lo que se puede mandar a su banco ahora mismo. */
  retirableCents: number;
  instantaneoCents: number;
}

/** Centavos de un importe en dólares que viene de la base. Nunca negativo. */
export function aCentavos(usd: unknown): number {
  const n = typeof usd === 'number' ? usd : Number(usd);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

/**
 * El desglose completo.
 *
 * `retirable` es solo lo disponible en Stripe: ni la deuda de Urbont ni lo que
 * está en camino se pueden mandar al banco todavía, y prometérselo al chofer es
 * justo el error que tenía la pantalla anterior.
 */
export function resumenDeSaldo(opts: {
  /** `driver_earnings` de los viajes completados sin transferir. */
  pendientesUSD: Array<number | string | null>;
  saldoStripe: SaldoStripe;
}): ResumenSaldo {
  const enUrbontCents = opts.pendientesUSD.reduce<number>((s, v) => s + aCentavos(v), 0);
  const disponibleCents = Math.max(0, Math.trunc(opts.saldoStripe.disponibleCents || 0));
  const enCaminoCents = Math.max(0, Math.trunc(opts.saldoStripe.enCaminoCents || 0));
  const instantaneoCents = Math.max(0, Math.trunc(opts.saldoStripe.instantaneoCents ?? 0));

  return {
    enUrbontCents,
    enCaminoCents,
    disponibleCents,
    totalCents: enUrbontCents + enCaminoCents + disponibleCents,
    retirableCents: disponibleCents,
    instantaneoCents: Math.min(instantaneoCents, disponibleCents),
  };
}

/** Para mostrar: centavos a dólares con dos decimales. */
export function enDolares(cents: number): number {
  return Math.round(cents) / 100;
}

export type MetodoRetiro = 'standard' | 'instant';

export interface PuedeRetirar {
  puede: boolean;
  /** Qué decirle al chofer cuando no puede. Null si sí puede. */
  motivo: string | null;
  /** Lo que se le mandaría, en centavos. */
  montoCents: number;
}

/**
 * Si el chofer puede retirar ahora y cuánto.
 *
 * Se comprueba aquí y no en la ruta para que el mensaje que ve el chofer sea
 * uno concreto —«tienes $123 pendientes de que Urbont te los transfiera»— en
 * vez del «no pasa nada» que daba el botón antiguo.
 */
export function puedeRetirar(resumen: ResumenSaldo, metodo: MetodoRetiro): PuedeRetirar {
  const monto = metodo === 'instant' ? resumen.instantaneoCents : resumen.retirableCents;

  if (monto > 0) return { puede: true, motivo: null, montoCents: monto };

  if (metodo === 'instant' && resumen.retirableCents > 0) {
    return {
      puede: false,
      montoCents: 0,
      motivo: 'El retiro instantáneo necesita una tarjeta de débito registrada en Stripe. Puedes usar el retiro estándar.',
    };
  }
  if (resumen.enCaminoCents > 0) {
    return {
      puede: false,
      montoCents: 0,
      motivo: `Tienes $${enDolares(resumen.enCaminoCents).toFixed(2)} en camino. Estará disponible en un par de días.`,
    };
  }
  if (resumen.enUrbontCents > 0) {
    return {
      puede: false,
      montoCents: 0,
      motivo: `Tienes $${enDolares(resumen.enUrbontCents).toFixed(2)} por cobrar de tus viajes. Urbont los está transfiriendo a tu cuenta.`,
    };
  }
  return { puede: false, montoCents: 0, motivo: 'No tienes saldo para retirar.' };
}

/**
 * La parte del chofer en un viaje.
 *
 * La pantalla de ganancias sumaba `rides.fare`, el precio que pagó el pasajero,
 * y se lo enseñaba al chofer como si fuera suyo. De ahí salían dos números que
 * no cuadraban: arriba lo facturado y abajo, en el botón de retirar, lo que de
 * verdad le corresponde.
 *
 * Manda `driver_earnings`, que es lo que se le apuntó al repartir. Cuando falta
 * —viajes viejos, anteriores a que se escribiera esa columna— se calcula con la
 * misma proporción, para que la cifra no se desplome y parezca que la app perdió
 * datos.
 */
export const PARTE_DEL_CHOFER = 0.85;

export function gananciaDelChofer(viaje: {
  driver_earnings?: number | string | null;
  fare?: number | string | null;
}): number {
  const apuntado = Number(viaje.driver_earnings);
  if (Number.isFinite(apuntado) && apuntado > 0) return apuntado;

  const tarifa = Number(viaje.fare);
  if (Number.isFinite(tarifa) && tarifa > 0) return Math.round(tarifa * PARTE_DEL_CHOFER * 100) / 100;

  return 0;
}

/**
 * Lo que gana el chofer por un viaje, propina incluida.
 *
 * Las propinas no entraban en ninguna cifra de la pantalla de ganancias: ni en
 * los totales, ni en la gráfica, ni en el importe de cada viaje. La fila
 * enseñaba «· $10.00 tip» como texto suelto mientras el importe de al lado lo
 * ignoraba, así que un chofer con $10 de propina veía las mismas ganancias que
 * sin ella.
 *
 * La propina va entera al chofer -Urbont no cobra comisión sobre ella-, así que
 * se suma tal cual, sin aplicarle el 85 %.
 */
export function gananciaConPropina(viaje: {
  driver_earnings?: number | string | null;
  fare?: number | string | null;
  tip_amount?: number | string | null;
}): number {
  const propina = Number(viaje.tip_amount);
  const conPropina = Number.isFinite(propina) && propina > 0 ? propina : 0;
  return Math.round((gananciaDelChofer(viaje) + conPropina) * 100) / 100;
}
