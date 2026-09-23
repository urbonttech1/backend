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
 * La comisión que le corresponde al valet por un servicio de ese valor.
 * Un servicio sin precio no genera comisión.
 */
export function comisionValet(valorServicio: unknown): number {
  const valor = typeof valorServicio === 'number'
    ? valorServicio
    : typeof valorServicio === 'string' && valorServicio.trim() !== ''
      ? Number(valorServicio)
      : NaN;

  if (!Number.isFinite(valor) || valor <= 0) return 0;
  if (valor <= VALET_UMBRAL_USD) return VALET_MINIMO_USD;
  return Math.round(valor * VALET_PORCENTAJE * 100) / 100;
}
