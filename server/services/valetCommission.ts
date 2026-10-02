/**
 * La comisión del valet.
 *
 * Era una constante fija de $10 por viaje, sin importar cuánto costara el
 * servicio. El cliente la definió por tramos: $10 hasta $100 de servicio y el
 * 10 % por encima. Así un traslado largo deja de pagar lo mismo que uno corto.
 *
 * El «valor del servicio» es la tarifa oficial del viaje —la misma que pagaría
 * un pasajero por ese trayecto—, calculada ANTES de sumar esta comisión y sin
 * impuesto. La comisión se le suma al huésped y se le transfiere al valet.
 *
 * Reglas puras, sin base de datos, para poder probarlas.
 */

/** Lo que cobra el valet mientras el servicio no pase de $100. */
export const VALET_MINIMO_USD = 10;
/** Por encima de ese umbral manda el porcentaje. */
export const VALET_UMBRAL_USD = 100;
export const VALET_PORCENTAJE = 0.10;

/**
 * Las tres cifras de la regla. Son las del acuerdo con el cliente, pero ya no
 * están fijas: el panel las edita (ver `valetCommissionConfig.ts`) y quedan aquí
 * como las reglas vigentes.
 */
export interface ReglasValet {
  /** USD que cobra el valet hasta el umbral. */
  minimo: number;
  /** Valor del servicio hasta el que rige el mínimo. */
  umbral: number;
  /** Fracción (0.10 = 10 %) que rige por encima del umbral. */
  porcentaje: number;
}

export const REGLAS_VALET_POR_DEFECTO: ReglasValet = {
  minimo: VALET_MINIMO_USD, umbral: VALET_UMBRAL_USD, porcentaje: VALET_PORCENTAJE,
};

let vigentes: ReglasValet = { ...REGLAS_VALET_POR_DEFECTO };

export const getReglasValet = (): ReglasValet => vigentes;
export function setReglasValet(r: ReglasValet): void { vigentes = { ...r }; }

/** Cotas de lo que acepta el panel: más allá es casi seguro un error de tecleo. */
export const LIMITES_VALET = { minimoMax: 50, umbralMax: 1000, porcentajeMax: 30 } as const;

export interface ErrorReglas { errorCode: string; field: string; error: string }

function numero(v: unknown): number {
  return typeof v === 'number' ? v
    : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.'))
    : NaN;
}

/** Lo que manda el panel (mínimo en USD, umbral en USD y porcentaje en %). */
export function normalizarReglasValet(body: Record<string, unknown>): { reglas: ReglasValet } | ErrorReglas {
  const minimo = numero(body.minimumUsd);
  if (!Number.isFinite(minimo) || minimo < 0 || minimo > LIMITES_VALET.minimoMax) {
    return { errorCode: 'INVALID_MINIMUM', field: 'minimumUsd', error: `El mínimo debe ser un número entre 0 y ${LIMITES_VALET.minimoMax}.` };
  }
  const umbral = numero(body.thresholdUsd);
  if (!Number.isFinite(umbral) || umbral <= 0 || umbral > LIMITES_VALET.umbralMax) {
    return { errorCode: 'INVALID_THRESHOLD', field: 'thresholdUsd', error: `El tope del mínimo debe ser un número entre 1 y ${LIMITES_VALET.umbralMax}.` };
  }
  const pct = numero(body.percent);
  if (!Number.isFinite(pct) || pct < 0 || pct > LIMITES_VALET.porcentajeMax) {
    return { errorCode: 'INVALID_PERCENT', field: 'percent', error: `El porcentaje debe ser un número entre 0 y ${LIMITES_VALET.porcentajeMax}.` };
  }
  return { reglas: { minimo: Math.round(minimo * 100) / 100, umbral: Math.round(umbral * 100) / 100, porcentaje: Math.round(pct * 1e4) / 1e6 } };
}

/**
 * La comisión que le corresponde al valet por un servicio de ese valor.
 * Un servicio sin precio no genera comisión.
 */
export function comisionValet(valorServicio: unknown, reglas: ReglasValet = vigentes): number {
  const valor = typeof valorServicio === 'number'
    ? valorServicio
    : typeof valorServicio === 'string' && valorServicio.trim() !== ''
      ? Number(valorServicio)
      : NaN;

  if (!Number.isFinite(valor) || valor <= 0) return 0;
  if (valor <= reglas.umbral) return reglas.minimo;
  return Math.round(valor * reglas.porcentaje * 100) / 100;
}
