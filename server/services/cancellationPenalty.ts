/**
 * Penalidad al chofer que suelta una reserva que ya había aceptado.
 *
 * Hasta ahora soltar una reserva salía gratis: `rides/cancel.ts` la devolvía al
 * pool, se la ofrecía a otros choferes y nadie pagaba nada. Un chofer podía
 * tomar una reserva para asegurarla y soltarla media hora antes del servicio
 * sin coste, dejando al pasajero sin coche y al dispatcher buscando a mano.
 *
 * Al aceptar, el chofer asume el servicio. Si lo suelta, paga un porcentaje del
 * valor de la reserva que crece según se acerca la hora: cuanto menos margen
 * queda para encontrar reemplazo, más caro.
 *
 * Reglas puras, sin base de datos ni Stripe, para poder probarlas. Quien las
 * usa y guarda el resultado es `rides/cancel.ts`.
 */

/**
 * Margen para arrepentirse: un chofer que acepta y se da cuenta en seguida de
 * que choca con otra reserva no paga nada.
 */
export const EXENCION_TRAS_ACEPTAR_MINUTOS = 5;

/** Por encima de estas horas hasta el servicio, la penalidad es la mínima. */
export const TRAMO_HOLGADO_HORAS = 2;
/** Por encima de esta hora (y hasta `TRAMO_HOLGADO_HORAS`), tramo intermedio. */
export const TRAMO_MEDIO_HORAS = 1;
/**
 * Por debajo de estos minutos ya no da tiempo a reemplazar al chofer: 100 %.
 *
 * El documento de la política no lo dice en la tabla —sus dos últimas filas se
 * pisan— pero sí en sus ejemplos: a 1 h cobra el 60 % y a 30 min el 100 %. Este
 * es el único número que hay que tocar si se decide otra frontera.
 */
export const TRAMO_INMINENTE_MINUTOS = 30;

/** Qué porcentaje se cobra en cada tramo. */
export const PORCENTAJE = {
  /** Dentro del margen para arrepentirse. */
  exento: 0,
  /** Falta más de `TRAMO_HOLGADO_HORAS`. */
  holgado: 0.2,
  /** Falta más de `TRAMO_MEDIO_HORAS` y hasta `TRAMO_HOLGADO_HORAS`. */
  medio: 0.4,
  /** Falta más de `TRAMO_INMINENTE_MINUTOS` y hasta `TRAMO_MEDIO_HORAS`. */
  ajustado: 0.6,
  /** Falta `TRAMO_INMINENTE_MINUTOS` o menos, o la hora ya pasó. */
  inminente: 1,
} as const;

/** Por qué se cobró lo que se cobró. Se guarda con la penalidad, para el panel. */
export type MotivoPenalidad =
  | 'exento_5_min'
  | 'mas_de_2_h'
  | 'entre_1_y_2_h'
  | 'menos_de_1_h'
  | 'menos_de_30_min'
  | 'sin_datos';

export interface CancelacionDeReserva {
  /** Cuándo aceptó el chofer. `rides.accepted_at`. */
  aceptadaEn: string | Date | null | undefined;
  /** Cuándo la suelta. Hora del servidor, nunca del teléfono. */
  canceladaEn: string | Date | null | undefined;
  /** Hora programada del servicio. `rides.scheduled_at`. */
  servicioEn: string | Date | null | undefined;
}

export interface Penalidad {
  porcentaje: number;
  /** Importe en la moneda de la reserva, redondeado a dos decimales. */
  importe: number;
  motivo: MotivoPenalidad;
  /** Lo que el panel muestra como «tiempo restante al cancelar». */
  minutosHastaServicio: number | null;
  minutosDesdeAceptacion: number | null;
}

/**
 * Permite desplegar la penalidad apagada y encenderla cuando el panel ya
 * muestre las incidencias, igual que `RESERVATION_CONFIRM`.
 */
export function penalizacionActiva(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.CANCELLATION_PENALTY ?? '').trim().toLowerCase() !== 'off';
}

const ms = (v: string | Date | null | undefined): number => (v ? new Date(v).getTime() : NaN);
const r2 = (n: number) => Math.round(n * 100) / 100;
const enMinutos = (desde: number, hasta: number) => (hasta - desde) / 60_000;

/**
 * El porcentaje y el porqué, sin tocar dinero.
 *
 * Orden deliberado: la exención de los cinco minutos se mira primero, tal como
 * manda la política. Tiene un efecto que conviene conocer — aceptar una reserva
 * que empieza en veinte minutos y soltarla a los dos sale gratis — y se corrige
 * aquí el día que se decida acotarla.
 *
 * Sin fechas válidas no se inventa nada: no se cobra. Cobrar de más por un dato
 * corrupto es peor que no cobrar.
 */
export function porcentajePenalidad(c: CancelacionDeReserva): {
  porcentaje: number;
  motivo: MotivoPenalidad;
  minutosHastaServicio: number | null;
  minutosDesdeAceptacion: number | null;
} {
  const aceptada = ms(c.aceptadaEn);
  const cancelada = ms(c.canceladaEn);
  const servicio = ms(c.servicioEn);

  if (!Number.isFinite(aceptada) || !Number.isFinite(cancelada) || !Number.isFinite(servicio)) {
    return { porcentaje: 0, motivo: 'sin_datos', minutosHastaServicio: null, minutosDesdeAceptacion: null };
  }

  const minutosDesdeAceptacion = enMinutos(aceptada, cancelada);
  const minutosHastaServicio = enMinutos(cancelada, servicio);
  const comun = { minutosHastaServicio, minutosDesdeAceptacion };

  // Un reloj que va al revés (cancelada antes que aceptada) es un dato roto,
  // no un chofer rapidísimo: no se cobra, pero tampoco se exime en silencio.
  if (minutosDesdeAceptacion < 0) {
    return { porcentaje: 0, motivo: 'sin_datos', ...comun };
  }

  if (minutosDesdeAceptacion <= EXENCION_TRAS_ACEPTAR_MINUTOS) {
    return { porcentaje: PORCENTAJE.exento, motivo: 'exento_5_min', ...comun };
  }
  if (minutosHastaServicio > TRAMO_HOLGADO_HORAS * 60) {
    return { porcentaje: PORCENTAJE.holgado, motivo: 'mas_de_2_h', ...comun };
  }
  if (minutosHastaServicio > TRAMO_MEDIO_HORAS * 60) {
    return { porcentaje: PORCENTAJE.medio, motivo: 'entre_1_y_2_h', ...comun };
  }
  if (minutosHastaServicio > TRAMO_INMINENTE_MINUTOS) {
    return { porcentaje: PORCENTAJE.ajustado, motivo: 'menos_de_1_h', ...comun };
  }
  return { porcentaje: PORCENTAJE.inminente, motivo: 'menos_de_30_min', ...comun };
}

/**
 * La penalidad completa, lista para guardar.
 *
 * `valorReserva` es el total de la reserva (`locked_fare ?? fare`). Un valor
 * que no sea un número positivo deja el importe en cero: el porcentaje se
 * calcula igual, para que el panel vea qué tramo aplicó.
 */
export function calcularPenalidad(c: CancelacionDeReserva, valorReserva: number | string | null | undefined): Penalidad {
  const { porcentaje, motivo, minutosHastaServicio, minutosDesdeAceptacion } = porcentajePenalidad(c);
  const total = Number(valorReserva);
  const base = Number.isFinite(total) && total > 0 ? total : 0;
  return {
    porcentaje,
    importe: r2(base * porcentaje),
    motivo,
    minutosHastaServicio,
    minutosDesdeAceptacion,
  };
}

/** Una penalidad pendiente de cobro, tal como sale de la tabla. */
export interface DeudaPendiente {
  id: string;
  /** En la moneda de la reserva, no en centavos. */
  amount: number;
}

/**
 * Cuánto se le descuenta a un chofer de lo que acaba de ganar.
 *
 * Se saldan las deudas más viejas primero y **sólo las que caben enteras**. Una
 * penalidad no se parte: cobrar media deja la fila a medio pagar y obliga a
 * llevar la cuenta de lo ya descontado, que es justo donde se cuelan los
 * errores de dinero.
 *
 * El efecto conocido: una penalidad mayor que lo que el chofer gana en un solo
 * viaje no se cobra sola y se queda esperando a que un viaje la cubra o a que
 * el admin la gestione. Está documentado y es deliberado.
 *
 * Nunca deja la ganancia en negativo.
 */
export function descontarDeGanancia(
  gananciaCentavos: number,
  pendientes: DeudaPendiente[],
): { descuentoCentavos: number; gananciaFinalCentavos: number; idsSaldados: string[] } {
  const disponibleInicial = Number.isFinite(gananciaCentavos) && gananciaCentavos > 0 ? Math.floor(gananciaCentavos) : 0;
  let disponible = disponibleInicial;
  const idsSaldados: string[] = [];

  for (const deuda of pendientes) {
    const centavos = Math.round((Number(deuda.amount) || 0) * 100);
    if (centavos <= 0 || centavos > disponible) continue;
    disponible -= centavos;
    idsSaldados.push(deuda.id);
  }

  return {
    descuentoCentavos: disponibleInicial - disponible,
    gananciaFinalCentavos: disponible,
    idsSaldados,
  };
}

/**
 * La escalera tal como se le enseña al chofer y al panel.
 *
 * Viaja a la app dentro de `getPricingPolicy()`, para que el aviso de «esto te
 * costará» no tenga los porcentajes escritos a mano en el teléfono.
 */
export function politicaDePenalidad() {
  return {
    exencionMinutos: EXENCION_TRAS_ACEPTAR_MINUTOS,
    tramos: [
      { desdeMinutos: TRAMO_HOLGADO_HORAS * 60, porcentaje: PORCENTAJE.holgado },
      { desdeMinutos: TRAMO_MEDIO_HORAS * 60, porcentaje: PORCENTAJE.medio },
      { desdeMinutos: TRAMO_INMINENTE_MINUTOS, porcentaje: PORCENTAJE.ajustado },
      { desdeMinutos: 0, porcentaje: PORCENTAJE.inminente },
    ],
  };
}
