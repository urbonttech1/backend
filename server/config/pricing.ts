/**
 * URBONT Pricing Configuration
 * All monetary values in USD.
 *
 * Tarifas acordadas con el cliente en `docs/relacion_tarifas.odt` y sus
 * respuestas (plan en `docs/PLAN_TARIFAS_CLIENTE.md`). Los importes por clase
 * son semilla y red: `fares_config` en la base manda sobre ellos, y se editan
 * desde el panel. Las POLÍTICAS —minutos gratis, topes, umbrales de
 * cancelación— son reglas de negocio y viven aquí.
 */

// ── Plataforma ───────────────────────────────────────────────────────────────
/**
 * Lo que se queda Urbont de cada viaje. Sale de DENTRO del precio: el pasajero
 * paga lo que dice la tabla de tarifas y de ahí se reparte.
 *
 * Antes era un 10 % que se SUMABA por encima —un viaje de $20 se cobraba a $22—
 * y el chofer recibía el 90 % de ese total, o sea casi la tarifa entera. El
 * cliente lo fijó en el 15 % contenido en el precio: el pasajero paga $20, el
 * chofer cobra $17 y Urbont $3.
 */
export const PLATFORM_COMMISSION = 0.15;

/**
 * La comisión vigente. Arranca en la de arriba y el panel la puede cambiar sin
 * desplegar (services/commissionConfig.ts la carga desde `app_config`), igual
 * que las tarifas por clase. Se lee con `getPlatformCommission()`: leer la
 * constante directamente se queda con el valor del código.
 */
let comisionVigente = PLATFORM_COMMISSION;

export function getPlatformCommission(): number {
  return comisionVigente;
}

/** La fija el cargador de configuración; fuera de rango se ignora. */
export function setPlatformCommission(tasa: number): void {
  if (!Number.isFinite(tasa) || tasa < 0 || tasa > 0.5) return;
  comisionVigente = tasa;
}

/**
 * Cargo fijo de reserva del sistema, en todos los viajes. Distinto del
 * `serviceFee` por clase, que sólo pagan los viajes programados.
 */
export const BOOKING_FEE_USD = 2.50;

// ── Espera ───────────────────────────────────────────────────────────────────
/** Minutos que el pasajero tiene para llegar al coche sin cargo. */
export const WAIT_TIME_FREE_MINUTES = 5;
/**
 * Minutos de espera cobrables, como máximo. Antes el tope era 60: un pasajero que
 * tardaba una hora pagaba 55 minutos. El cliente fija 10: pasado eso, el chofer
 * puede cancelar por no-show.
 */
export const WAIT_TIME_MAX_BILLABLE_MINUTES = 10;

// ── No-show ──────────────────────────────────────────────────────────────────
/** Espera adicional, tras la gratis, antes de poder marcar no-show en un viaje a demanda. */
export const NO_SHOW_EXTRA_WAIT_MINUTES = 10;
/** En una reserva, minutos tras la hora pactada antes de poder marcar no-show. */
export const SCHEDULED_NO_SHOW_AFTER_MINUTES = 30;

// ── Cancelación de reservas por el pasajero ──────────────────────────────────
/** Con al menos estas horas de antelación, cancelar una reserva es gratis. */
export const SCHEDULED_CANCEL_FREE_HOURS = 2;
/** Con al menos estas horas (y menos que las gratis), se cobra el 50 %. Por debajo, el 100 %. */
export const SCHEDULED_CANCEL_HALF_HOURS = 1;

// ── Otros cargos que se mantienen ────────────────────────────────────────────
export const LONG_PICKUP_FEE        = 5.00;  // Added when driver is >15 min away from pickup
export const LONG_PICKUP_THRESHOLD_MINS = 15; // Minutes threshold for long pickup fee
export const CONSECUTIVE_TRIP_BONUS: Record<number, number> = {
  5:  3.00,   // $3 bonus after 5 consecutive trips
  10: 7.00,   // $7 bonus after 10 consecutive trips
  20: 15.00,  // $15 bonus after 20 consecutive trips
};

// ── Tramos por milla ─────────────────────────────────────────────────────────
/** Un viaje de hasta estas millas usa el tramo 1. */
export const TIER1_MAX_MILES = 3;
/** Un viaje de más del tramo 1 y hasta estas millas usa el tramo 2; por encima, el 3. */
export const TIER2_MAX_MILES = 10;

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Surge ────────────────────────────────────────────────────────────────────
/**
 * Zona horaria de operación. El surge por franja horaria debe decidirse con la
 * hora de la ciudad, no con la del servidor ni con la del teléfono del pasajero.
 * Mismo valor que usa el reporte de ingresos por hora (admin.ts:835).
 */
export const OPERATING_TIMEZONE = 'America/New_York';

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Día de la semana y hora en la zona de operación, sin depender del TZ del proceso. */
function localParts(now: Date): { dow: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: OPERATING_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const hourRaw = parts.find((p) => p.type === 'hour')?.value ?? '0';
  // Algunas implementaciones devuelven "24" para medianoche.
  return { dow: DOW[weekday] ?? 0, hour: parseInt(hourRaw, 10) % 24 };
}

/**
 * Recargo por franja horaria.
 *
 * Portado de la app móvil (`src/screens/booking/utils.ts`, `getDynamicMultiplier`),
 * donde se calculaba con `new Date()` en el teléfono del pasajero: el recargo
 * dependía de la hora que tuviera configurada el dispositivo. Acá se decide con
 * la hora de la ciudad de operación.
 *
 * Las noches de viernes y sábado se extienden hasta las 02:00 del día siguiente,
 * así que la franja alta cubre también sábado y domingo de madrugada.
 */
export function getTimeSurge(now: Date = new Date()): number {
  const { dow, hour } = localParts(now);

  const fridayOrSaturdayNight =
    ((dow === 5 || dow === 6) && hour >= 22) ||  // vie/sáb 22:00–23:59
    ((dow === 6 || dow === 0) && hour < 2);      // la madrugada siguiente
  if (fridayOrSaturdayNight) return 1.35;

  const weekday = dow >= 1 && dow <= 5;
  if (weekday && hour >= 7  && hour < 10) return 1.25;  // pico de la mañana
  if (weekday && hour >= 16 && hour < 20) return 1.22;  // pico de la tarde
  if (hour >= 2 && hour < 4)              return 1.15;  // madrugada, poca oferta

  return 1.0;
}

// ── Clases de tarifa ─────────────────────────────────────────────────────────
/**
 * Una clase de vehículo con todo lo que se le puede cobrar.
 *
 * Hay un solo tipo, y `fares_config` en la base manda sobre estos valores, que
 * quedan como semilla y como red si la base no responde.
 *
 * Cambió con las tarifas del cliente: el precio por milla ya no es uno solo más
 * unas millas incluidas en la mínima, sino tres tramos según la distancia TOTAL
 * del viaje; la espera tiene tarifa propia por clase; y `serviceFee` pasa a ser
 * la reserva, que sólo pagan los viajes programados.
 */
export interface FareClass {
  name:            string;
  /** Lo mínimo que cuesta cualquier viaje. Es un piso, no se suma a la distancia. */
  minFare:         number;
  /** Por milla en un viaje de hasta TIER1_MAX_MILES. */
  perMileTier1:    number;
  /** Por milla en un viaje de más de TIER1_MAX_MILES y hasta TIER2_MAX_MILES. */
  perMileTier2:    number;
  /** Por milla en un viaje de más de TIER2_MAX_MILES. */
  perMileTier3:    number;
  /** Por minuto de trayecto (tráfico), aplicado al 25 % de la duración estimada. */
  perMin:          number;
  /** Por minuto de espera, pasados los gratis y hasta el tope. */
  waitPerMin:      number;
  /** Reserva. Sólo la pagan los viajes programados y nunca lleva recargo. */
  serviceFee:      number;
  /** Chofer a disposición: precio por hora y bloque mínimo. */
  perHour:         number;
  minHours:        number;
}

/** Valores por defecto. Los pisa `fares_config` cuando existe en la base. */
export const DEFAULT_FARE_CLASSES: Record<string, FareClass> = {
  sedan: { name: 'Standard (Sedan)', minFare: 17.00, perMileTier1: 2.90, perMileTier2: 3.00, perMileTier3: 2.50, perMin: 1.00, waitPerMin: 0.75, serviceFee: 10.00, perHour: 110.00, minHours: 2 },
  suv:   { name: 'Premier (SUV)',    minFare: 22.00, perMileTier1: 3.50, perMileTier2: 3.50, perMileTier3: 3.00, perMin: 1.25, waitPerMin: 1.00, serviceFee: 15.00, perHour: 145.00, minHours: 2 },
  van:   { name: 'Executive Van',    minFare: 27.00, perMileTier1: 3.75, perMileTier2: 4.00, perMileTier3: 3.50, perMin: 1.75, waitPerMin: 1.25, serviceFee: 20.00, perHour: 185.00, minHours: 2 },
};

/**
 * Tarifas vigentes. Arranca con los defaults y `setFareClasses()` la reemplaza
 * cuando se cargan las de la base.
 *
 * Es una variable de módulo a propósito: los ocho archivos que calculan precios
 * importan estas funciones de forma síncrona, y volverlas asíncronas obligaría a
 * refactorizar todo el camino del cobro. La carga desde la base ocurre una vez al
 * arrancar y cada vez que un admin guarda.
 */
let activeFareClasses: Record<string, FareClass> = { ...DEFAULT_FARE_CLASSES };

/** Reemplaza las tarifas vigentes. La llama el cargador, no el código de negocio. */
export function setFareClasses(classes: Record<string, FareClass>): void {
  activeFareClasses = { ...DEFAULT_FARE_CLASSES, ...classes };
}

/** Vuelve a los valores por defecto. Sólo para tests. */
export function resetFareClasses(): void {
  activeFareClasses = { ...DEFAULT_FARE_CLASSES };
}

/** Todas las clases vigentes — para el editor del panel y para la app. */
export function getFareClasses(): Record<string, FareClass> {
  return { ...activeFareClasses };
}

/** La clase que corresponde a un nombre de vehículo, resolviendo alias. */
export function getFareClass(vehicleType: string): FareClass | null {
  const key = VEHICLE_ALIAS[String(vehicleType ?? '').toLowerCase()];
  return key ? (activeFareClasses[key] ?? null) : null;
}

// Normalized alias map: vehicle names/IDs that the server may receive → canonical FARE_RULES key
export const VEHICLE_ALIAS: Record<string, string> = {
  'sedan':         'sedan',
  'business class':'sedan',
  'executive':     'sedan',
  'standard':      'sedan',
  'suv':           'suv',
  'premium suv':   'suv',
  'premier':       'suv',
  'luxury':        'suv',
  'van':           'van',
  'van & sprinter':'van',
  'sprinter':      'van',
  'max':           'van',
};

/** ¿Es un viaje programado? Es lo único que decide si se cobra la reserva. */
export function esProgramado(bookingType?: string | null): boolean {
  return bookingType === 'scheduled';
}

// ── Distancia por tramos ─────────────────────────────────────────────────────
export type MileTier = 1 | 2 | 3;

/** El tramo del viaje según su distancia total, y la tarifa por milla que le toca. */
export function tramoPorMilla(rule: FareClass, miles: number): { tier: MileTier; perMile: number } {
  const d = Math.max(0, miles);
  if (d <= TIER1_MAX_MILES) return { tier: 1, perMile: rule.perMileTier1 };
  if (d <= TIER2_MAX_MILES) return { tier: 2, perMile: rule.perMileTier2 };
  return { tier: 3, perMile: rule.perMileTier3 };
}

/**
 * Importe por distancia: millas × tarifa del tramo al que pertenece el viaje
 * COMPLETO (así lo definió el cliente).
 *
 * Cobrar todo el viaje al tramo final tiene una trampa: si el tramo siguiente es
 * más barato, un viaje un poco más largo sale más barato. Con las tarifas del
 * cliente, un sedan de 11 mi (11 × $2.50 = $27.50) costaría menos que uno de 10
 * (10 × $3.00 = $30). Por eso el importe nunca baja de lo que cuesta el viaje
 * más largo del tramo anterior: se toma el máximo entre el cálculo del tramo y
 * el importe en cada límite ya superado. El precio queda no decreciente con la
 * distancia sean cuales sean las tarifas que se carguen desde el panel.
 */
export function calcularImporteDistancia(rule: FareClass, miles: number): number {
  const d = Math.max(0, miles);
  const { perMile } = tramoPorMilla(rule, d);
  let importe = d * perMile;
  if (d > TIER1_MAX_MILES) importe = Math.max(importe, TIER1_MAX_MILES * rule.perMileTier1);
  if (d > TIER2_MAX_MILES) importe = Math.max(importe, TIER2_MAX_MILES * rule.perMileTier2);
  return importe;
}

export interface FareRulesBreakdown {
  /** Tarifa mínima de la clase, con recargo. */
  base_fare:        number;
  /** Lo que la distancia supera a la mínima, con recargo. base_fare + distance_charge = lo que cuesta el recorrido. */
  distance_charge:  number;
  time_charge:      number;
  /** Reserva de la clase. 0 salvo en viajes programados. */
  booking_fee:      number;
  /** Cargo fijo de reserva del sistema, en todos los viajes. */
  booking_fee_flat: number;
  ride_fare:        number;
  platform_fee:     number;
  total:            number;
  /** Recargo aplicado a base, distancia y tiempo. 1.0 = sin recargo. */
  surge_multiplier: number;
  distance_miles:   number;
  /** Tarifa por milla aplicada al viaje, según su tramo. */
  per_mile:         number;
  /** Tramo del viaje: 1 (≤ 3 mi), 2 (≤ 10 mi) o 3 (> 10 mi). */
  tier:             MileTier;
  /** Heredados: se mantienen para no romper la app. Ya no hay millas incluidas. */
  extra_miles:      number;
  included_miles:   number;
  duration_minutes: number;
  currency:         string;
}

/**
 * Precio de un viaje por distancia.
 *
 *   1. distancia = calcularImporteDistancia (tramo final, sin saltos a la baja)
 *   2. base      = máx(tarifa mínima, distancia) × recargo
 *   3. tiempo    = duración × perMin × 0.25 × recargo
 *   4. reserva   = serviceFee, sólo si es programado, sin recargo
 *   5. total     = (base + tiempo + reserva) × 1.10
 *
 * La forma de la respuesta es la de siempre, para no romper la app: `base_fare`
 * es la mínima y `distance_charge` lo que la distancia la supera, así que la
 * suma sigue dando el importe del recorrido.
 */
export function calculateFareFromRules(opts: {
  vehicleType:      string;
  distanceMiles:    number;
  durationMinutes:  number;
  bookingType?:     string;
  /** Recargo por demanda. Se ignora si es menor a 1: nunca abarata el viaje. */
  surgeMultiplier?: number;
}): FareRulesBreakdown | null {
  const rule = getFareClass(opts.vehicleType);
  if (!rule) return null;

  // El surge multiplica base, distancia y tiempo — NUNCA la reserva.
  const surge           = Math.max(1, opts.surgeMultiplier ?? 1);
  const miles           = Math.max(0, opts.distanceMiles);
  const { tier, perMile } = tramoPorMilla(rule, miles);
  const importeDistancia = calcularImporteDistancia(rule, miles);

  const base_fare       = r2(rule.minFare * surge);
  const distance_charge = r2(Math.max(0, importeDistancia - rule.minFare) * surge);
  // Tiempo de trayecto: duración × perMin × 0.25 (el mismo factor del 25 % de siempre)
  const time_charge     = opts.durationMinutes > 0 ? r2(opts.durationMinutes * rule.perMin * 0.25 * surge) : 0;
  const booking_fee     = esProgramado(opts.bookingType) ? r2(rule.serviceFee) : 0;
  // El recargo por demanda no toca ni la reserva ni el booking fijo.
  const booking_fee_flat = BOOKING_FEE_USD;
  const ride_fare       = r2(base_fare + distance_charge + time_charge + booking_fee + booking_fee_flat);
  // Contenida en el precio, no añadida: `total` es lo que paga el pasajero.
  const platform_fee    = r2(ride_fare * getPlatformCommission());
  const total           = ride_fare;

  return {
    base_fare, distance_charge, time_charge, booking_fee, booking_fee_flat,
    ride_fare, platform_fee, total,
    surge_multiplier: surge,
    distance_miles:   r2(miles),
    per_mile:         perMile,
    tier,
    extra_miles:      r2(miles),
    included_miles:   0,
    duration_minutes: r2(opts.durationMinutes),
    currency: 'USD',
  };
}

export interface HourlyFareBreakdown {
  hourly_charge:    number;
  booking_fee:      number;
  booking_fee_flat: number;
  ride_fare:        number;
  platform_fee:     number;
  total:            number;
  surge_multiplier: number;
  /** Horas efectivamente cobradas: nunca menos que el mínimo de la clase. */
  billed_hours:     number;
  requested_hours:  number;
  per_hour:         number;
  min_hours:        number;
  currency:         string;
}

/**
 * Tarifa por hora (chofer a disposición).
 *
 * Misma estructura que la tarifa por distancia: el surge multiplica el cargo
 * variable y nunca el fijo, la comisión se calcula sobre el subtotal, y la
 * reserva sólo se cobra si el servicio es programado.
 *
 * Se cobra siempre el mínimo de la clase, aunque se pidan menos horas: es un
 * bloque reservado, no un consumo medido.
 */
export function calculateHourlyFare(opts: {
  vehicleType:      string;
  hours:            number;
  bookingType?:     string;
  surgeMultiplier?: number;
}): HourlyFareBreakdown | null {
  const rule = getFareClass(opts.vehicleType);
  if (!rule) return null;
  if (!Number.isFinite(opts.hours) || opts.hours < 0) return null;

  const surge         = Math.max(1, opts.surgeMultiplier ?? 1);
  const billedHours   = Math.max(rule.minHours, opts.hours);
  const hourly_charge = r2(billedHours * rule.perHour * surge);
  const booking_fee   = esProgramado(opts.bookingType) ? r2(rule.serviceFee) : 0;
  const booking_fee_flat = BOOKING_FEE_USD;
  const ride_fare     = r2(hourly_charge + booking_fee + booking_fee_flat);
  const platform_fee  = r2(ride_fare * getPlatformCommission());
  const total         = ride_fare;

  return {
    hourly_charge, booking_fee, booking_fee_flat, ride_fare, platform_fee, total,
    surge_multiplier: surge,
    billed_hours:     billedHours,
    requested_hours:  opts.hours,
    per_hour:         rule.perHour,
    min_hours:        rule.minHours,
    currency: 'USD',
  };
}

// ── Espera, no-show y cancelación ────────────────────────────────────────────

/**
 * Cargo por espera en la recogida.
 *
 * Se cobran los minutos completos pasados los gratis, con tope. Se redondea hacia
 * abajo: el pasajero paga por minuto entero, no por fracción. Los viajes de
 * valet nunca pagan espera (lo marca quien llama, con `esValet`).
 */
export function calcularCargoEspera(
  vehicleType: string,
  waitMinutes: number,
  esValet = false,
): { billableMinutes: number; fee: number } {
  const rule = getFareClass(vehicleType);
  if (!rule || esValet || !Number.isFinite(waitMinutes)) return { billableMinutes: 0, fee: 0 };
  const billableMinutes = Math.min(
    WAIT_TIME_MAX_BILLABLE_MINUTES,
    Math.max(0, Math.floor(waitMinutes - WAIT_TIME_FREE_MINUTES)),
  );
  return { billableMinutes, fee: r2(billableMinutes * rule.waitPerMin) };
}

/** Minutos que tiene que haber esperado el chofer para marcar no-show en un viaje a demanda. */
export function minutosParaNoShowDemanda(): number {
  return WAIT_TIME_FREE_MINUTES + NO_SHOW_EXTRA_WAIT_MINUTES;
}

/**
 * Cargo por no-show en un viaje a demanda, según la regla del cliente:
 * los minutos de espera cobrables a la tarifa de la clase, el booking fijo y la
 * comisión sobre la tarifa inicial.
 *
 * Antes era la espera más el 10 % del total del viaje, así que un trayecto
 * largo que nunca se hizo cobraba más que uno corto por el mismo plantón.
 */
export function calcularNoShowDemanda(vehicleType: string, _totalViaje?: number, esValet = false): number {
  const rule = getFareClass(vehicleType);
  if (!rule || esValet) return 0;
  return r2(
    NO_SHOW_EXTRA_WAIT_MINUTES * rule.waitPerMin
    + BOOKING_FEE_USD
    + rule.minFare * getPlatformCommission(),
  );
}

/**
 * Cargo al pasajero por cancelar una reserva, según la antelación.
 *
 *   ≥ 2 h antes  → gratis
 *   ≥ 1 h antes  → 50 %
 *   < 1 h        → 100 %
 */
export function calcularCancelacionReserva(
  horasAntes: number,
  totalViaje: number,
  esValet = false,
): { porcentaje: 0 | 0.5 | 1; fee: number } {
  if (esValet || !Number.isFinite(horasAntes)) return { porcentaje: 0, fee: 0 };
  const total = Number.isFinite(totalViaje) && totalViaje > 0 ? totalViaje : 0;
  const porcentaje: 0 | 0.5 | 1 =
    horasAntes >= SCHEDULED_CANCEL_FREE_HOURS ? 0
    : horasAntes >= SCHEDULED_CANCEL_HALF_HOURS ? 0.5
    : 1;
  return { porcentaje, fee: r2(total * porcentaje) };
}

/** Las políticas en un solo objeto, para publicarlas a la app y al panel. */
export function getPricingPolicy() {
  return {
    currency: 'USD',
    /** Contenida en el precio, no añadida por encima. */
    platformCommission: getPlatformCommission(),
    bookingFee: BOOKING_FEE_USD,
    mileTiers: { tier1MaxMiles: TIER1_MAX_MILES, tier2MaxMiles: TIER2_MAX_MILES },
    wait: {
      freeMinutes: WAIT_TIME_FREE_MINUTES,
      maxBillableMinutes: WAIT_TIME_MAX_BILLABLE_MINUTES,
    },
    noShow: {
      onDemandAfterMinutes: minutosParaNoShowDemanda(),
      scheduledAfterMinutes: SCHEDULED_NO_SHOW_AFTER_MINUTES,
    },
    scheduledCancellation: {
      freeHoursBefore: SCHEDULED_CANCEL_FREE_HOURS,
      halfChargeHoursBefore: SCHEDULED_CANCEL_HALF_HOURS,
    },
    onDemandCancellationFee: 0,
    bookingFeeAppliesTo: 'scheduled',
    valetExempt: true,
    longPickupFee: LONG_PICKUP_FEE,
    longPickupThresholdMinutes: LONG_PICKUP_THRESHOLD_MINS,
  };
}

export interface ComisionResult {
  /** Porcentaje aplicado: siempre 0.10 (10%) */
  porcentaje: number;
  /** Monto de comisión en USD */
  montoUSD: number;
  /** Monto en centavos — usar directamente en application_fee_amount de Stripe */
  centavos: number;
}

/**
 * Calcula la comisión de URBONT sobre un viaje.
 * Comisión fija: 10% sobre el precio total.
 *
 * @param precioViaje - Precio total del viaje en USD (ej. 45.50)
 * @returns ComisionResult con el monto en centavos listo para Stripe
 *
 * @example
 *   const { centavos } = calcularComisionDinamica(45.50);
 *   // Stripe: application_fee_amount: centavos
 */
export function calcularComisionDinamica(precioViaje: number): ComisionResult {
  if (precioViaje < 0) throw new RangeError('precioViaje no puede ser negativo');

  const porcentaje = getPlatformCommission();
  const montoUSD = r2(precioViaje * porcentaje);
  const centavos = Math.round(montoUSD * 100);

  return { porcentaje, montoUSD, centavos };
}

/**
 * Normaliza el método de pago a los dos únicos valores que el sistema distingue.
 *
 * `rides.payment_method` lleva un CHECK que sólo admite 'card' o 'cash', pero el
 * cliente lo manda como string libre: validation.ts lo tipa `z.string()` y
 * create.ts lo pasa tal cual al insert. Sin normalizar, un 'apple_pay' o un
 * 'google_pay' de la app tumbaría la reserva entera con un error de constraint.
 *
 * La regla no es nueva: accept.ts:260 ya asume que todo lo que no es 'cash' se
 * cobra como tarjeta, porque Apple Pay y Google Pay son tarjetas vía Stripe.
 * Aquí sólo se hace explícita esa suposición.
 */
export function normalizePaymentMethod(value: unknown): 'card' | 'cash' {
  return String(value ?? '').trim().toLowerCase() === 'cash' ? 'cash' : 'card';
}
