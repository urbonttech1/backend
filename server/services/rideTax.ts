/**
 * El impuesto de venta de un viaje.
 *
 * El precio del viaje (`fare`) se guarda SIN impuesto: es tarifa más la comisión
 * del 10 %. El impuesto se calcula aparte, con Stripe Tax, al crear el cobro, y
 * se suma encima. Por eso el pasajero veía $22,00 en su historial y $23,43 en la
 * tarjeta.
 *
 * Aquí se decide qué importe se le muestra en la lista de viajes: el total con
 * impuesto, que es lo que de verdad paga.
 *
 * Reglas puras, sin base de datos, para poder probarlas.
 */

/**
 * Tasa de respaldo, la misma que usa el cobro cuando Stripe Tax no responde
 * (ver `calculateStripeTax` en api/integrations.ts): el punto medio del 6–7 %
 * que se aplica en Florida.
 */
export const TASA_IMPUESTO_RESPALDO = 0.065;

const r2 = (n: number) => Math.round(n * 100) / 100;

const numero = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export interface TotalDeViaje {
  /** Lo que paga el pasajero: precio del viaje + impuesto. */
  total: number;
  /** El precio del viaje, sin impuesto. Es lo que se reparte con el chofer. */
  subtotal: number;
  impuesto: number;
  /**
   * true = el impuesto no está guardado y se calculó con la tasa de respaldo.
   * Pasa en los viajes anteriores a este cambio y en los que nunca se cobraron,
   * como los cancelados.
   */
  estimado: boolean;
}

/**
 * El total de un viaje, a partir de su fila. Usa el impuesto guardado si lo hay;
 * si no, lo estima. Sin precio, todo queda en cero.
 */
export function totalDeViaje(fila: Record<string, unknown>): TotalDeViaje {
  const subtotal = numero(fila.fare) ?? numero(fila.total_price) ?? numero(fila.locked_fare) ?? 0;
  if (subtotal <= 0) return { total: 0, subtotal: 0, impuesto: 0, estimado: false };

  const guardado = numero(fila.tax_amount);
  if (guardado !== null && guardado >= 0) {
    const total = numero(fila.total_with_tax);
    return {
      subtotal: r2(subtotal),
      impuesto: r2(guardado),
      total: r2(total !== null && total > 0 ? total : subtotal + guardado),
      estimado: false,
    };
  }

  const impuesto = r2(subtotal * TASA_IMPUESTO_RESPALDO);
  return { subtotal: r2(subtotal), impuesto, total: r2(subtotal + impuesto), estimado: true };
}
