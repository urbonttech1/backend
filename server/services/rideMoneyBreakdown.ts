import { calcularReparto } from './rideMetrics';
import { gananciaDelChofer } from './driverBalance';

/**
 * Cómo se reparte el dinero de un viaje, para el panel admin.
 *
 * El panel de /rides no mostraba ningún desglose: la fila solo traía `fare`, el
 * precio del servicio sin impuesto, y no había forma de ver cuánto se llevó el
 * chofer, cuánto Urbont, ni si la transferencia salió. Esta es la regla que
 * arma esa vista, reutilizando el mismo cálculo que se usa para cobrar
 * (`calcularReparto`) y para pagar (`gananciaDelChofer`), en vez de inventar un
 * tercero: si el panel dijera un número distinto al que de verdad se cobró o se
 * transfirió, sería peor que no mostrar nada.
 *
 * Dos fuentes conviven a propósito:
 *   - `driver_earnings` es lo que de verdad se calculó al pagar al chofer
 *     (`pagarChoferPorViaje`, en `ridePayout.ts`). Si está, manda: es un hecho.
 *   - Si no está —el pago aún no corrió, o es un viaje viejo—, se estima con
 *     `calcularReparto` sobre la tarifa y el impuesto guardados. Es una
 *     proyección, y se marca como tal (`fuente: 'estimado'`) para que el panel
 *     no la confunda con dinero que ya se movió.
 */

export interface FilaDeViaje {
  fare?: number | string | null;
  tax_amount?: number | string | null;
  total_with_tax?: number | string | null;
  valet_surcharge?: number | string | null;
  tip_amount?: number | string | null;
  wait_fee?: number | string | null;
  no_show_fee?: number | string | null;
  promo_discount?: number | string | null;
  cancellation_fee?: number | string | null;
  driver_earnings?: number | string | null;
  stripe_transfer_id?: string | null;
  /**
   * El desglose de `fare` en sus partes (base, distancia, tiempo, booking fee),
   * guardado al crear el viaje. Llega como texto JSON desde Supabase. Es `null`
   * cuando el precio vino ya calculado del cliente, o en viajes anteriores a
   * que existiera esta columna — no todos los viajes lo tienen.
   */
  base_fare_breakdown?: string | Record<string, unknown> | null;
}

export interface DesgloseDeDinero {
  /** Lo que pagó el pasajero: tarifa + impuesto (los cargos aparte no están incluidos). */
  cobradoAlPasajero: number;
  tarifaBase: number;
  /**
   * El cargo de reserva incluido en `tarifaBase`: el fijo ($2.50, en todo
   * viaje) más el de clase (sólo en programados). `null`, no `0`, cuando
   * `base_fare_breakdown` no está disponible — un viaje sin booking fee real
   * no existe, así que un 0 se leería como un dato, no como su ausencia.
   */
  bookingFee: number | null;
  /** `tarifaBase` sin el booking fee, o `null` cuando `bookingFee` también lo es. */
  tarifaSinBooking: number | null;
  impuesto: number;
  comisionValet: number;
  propina: number;
  cargoEspera: number;
  cargoNoShow: number;
  descuentoPromo: number;
  /** Lo que retiene Urbont: su 15 %, el impuesto y la comisión del valet. */
  comisionUrbont: number;
  /**
   * Lo que le corresponde al chofer POR EL VIAJE, sin la propina. Junto con
   * `comisionUrbont` suma exactamente `cobradoAlPasajero` — es el par a usar
   * para cualquier proporción o barra del reparto. `gananciaChofer` no sirve
   * para eso: incluye la propina, que es un cobro aparte y no del viaje.
   */
  gananciaChoferViaje: number;
  /** Lo que le queda al chofer en total: el viaje más la propina, si hubo. */
  gananciaChofer: number;
  /** Si `gananciaChofer` es un hecho ya calculado o una proyección. */
  fuente: 'registrado' | 'estimado';
  /** Si la transferencia al chofer ya salió. */
  transferido: boolean;
  transferId: string | null;
}

const numero = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * El booking fee de un viaje, sacado del desglose guardado.
 *
 * Suma `booking_fee` (el de clase, sólo en programados) y `booking_fee_flat`
 * (el fijo de $2.50, en todo viaje) — son las dos claves que escriben
 * `calculateFareFromRules` y `calculateHourlyFareFromRules` en
 * `config/pricing.ts`. El número ya está calculado; esto sólo lo lee.
 */
function bookingFeeDelBreakdown(raw: FilaDeViaje['base_fare_breakdown']): number | null {
  if (!raw) return null;
  let obj: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else {
    obj = raw;
  }
  const variable = Number(obj.booking_fee);
  const fijo = Number(obj.booking_fee_flat);
  const total = (Number.isFinite(variable) ? variable : 0) + (Number.isFinite(fijo) ? fijo : 0);
  return total > 0 ? Math.round(total * 100) / 100 : null;
}

export function desgloseDeDinero(viaje: FilaDeViaje): DesgloseDeDinero {
  const tarifaBase = numero(viaje.fare);
  const bookingFee = bookingFeeDelBreakdown(viaje.base_fare_breakdown);
  const impuesto = numero(viaje.tax_amount);
  const comisionValet = numero(viaje.valet_surcharge);
  const propina = numero(viaje.tip_amount);

  // Antes de cargarlo a Stripe Tax, total_with_tax puede no estar escrito
  // todavía: se completa tarifa + impuesto para que el número no salga en cero.
  const cobradoAlPasajero = numero(viaje.total_with_tax) || tarifaBase + impuesto;

  const reparto = calcularReparto({
    fareCents: Math.round(tarifaBase * 100),
    taxCents: Math.round(impuesto * 100),
    valetCents: Math.min(Math.round(comisionValet * 100), Math.round(tarifaBase * 100)),
  });

  const registrado = numero(viaje.driver_earnings) > 0;

  // Lo que corresponde al chofer POR EL VIAJE, sin propina — la propina es un
  // cobro aparte (otro PaymentIntent, ver `rideTip.ts`) y no forma parte de lo
  // que se reparte del cobro del viaje. Mezclarla aquí fue el segundo error:
  // hacía ver, en la barra Urbont/Chofer, que el chofer se llevaba el 93 % de
  // un viaje del que en realidad se llevó el 90,5 %, porque la propina inflaba
  // el lado del chofer sin que el total de la barra creciera con ella.
  const gananciaChoferViaje = registrado
    ? gananciaDelChofer(viaje)
    : Math.round(reparto.driverPayoutCents) / 100;

  // La comisión de Urbont, cuando el pago es un hecho, no se calcula aparte: se
  // deriva de lo que queda del total del viaje.
  //
  // `driver_earnings` se calculó en el momento del pago (`pagarChoferPorViaje`,
  // en `ridePayout.ts`) sobre la tarifa que el viaje tenía ENTONCES. Si `fare`
  // cambió después en la fila —pasa; no siempre se sabe por qué—, aplicar el
  // 15 % a la tarifa ACTUAL da una comisión sobre una base distinta de la que
  // usó el pago real, y las dos cifras dejan de sumar el total de arriba: se ve
  // como un error de cálculo aunque cada número, por separado, sea correcto.
  //
  // Restando en vez de calcular en paralelo, la tarjeta cuadra siempre con el
  // único dato 100 % real que hay: lo que de verdad se transfirió por el viaje.
  const comisionUrbont = registrado
    ? Math.max(0, Math.round((cobradoAlPasajero - gananciaChoferViaje) * 100) / 100)
    : Math.round(reparto.applicationFeeCents) / 100;

  const gananciaChofer = Math.round((gananciaChoferViaje + propina) * 100) / 100;

  return {
    cobradoAlPasajero,
    tarifaBase,
    bookingFee,
    tarifaSinBooking: bookingFee != null ? Math.round((tarifaBase - bookingFee) * 100) / 100 : null,
    impuesto,
    comisionValet,
    propina,
    cargoEspera: numero(viaje.wait_fee),
    cargoNoShow: numero(viaje.no_show_fee),
    descuentoPromo: numero(viaje.promo_discount),
    comisionUrbont,
    gananciaChoferViaje,
    gananciaChofer,
    fuente: registrado ? 'registrado' : 'estimado',
    transferido: !!viaje.stripe_transfer_id,
    transferId: viaje.stripe_transfer_id ?? null,
  };
}
