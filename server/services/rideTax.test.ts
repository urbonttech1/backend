import { describe, it, expect } from 'vitest';
import { totalDeViaje, TASA_IMPUESTO_RESPALDO } from './rideTax';

describe('totalDeViaje', () => {
  it('usa el impuesto guardado del cobro', () => {
    // El viaje de la captura: $19,75 de tarifa + $1,98 de comisión = $21,73.
    expect(totalDeViaje({ fare: 21.73, tax_amount: 1.41, total_with_tax: 23.14 }))
      .toEqual({ subtotal: 21.73, impuesto: 1.41, total: 23.14, estimado: false });
  });

  it('si falta el total guardado, lo suma', () => {
    expect(totalDeViaje({ fare: 22, tax_amount: 1.43 }))
      .toEqual({ subtotal: 22, impuesto: 1.43, total: 23.43, estimado: false });
  });

  it('sin impuesto guardado lo estima con la tasa de respaldo', () => {
    // Viajes anteriores al cambio y cancelados, que nunca se cobraron.
    expect(totalDeViaje({ fare: 22 }))
      .toEqual({ subtotal: 22, impuesto: 1.43, total: 23.43, estimado: true });
    expect(TASA_IMPUESTO_RESPALDO).toBe(0.065);
  });

  it('acepta los otros nombres del precio y los números como texto', () => {
    expect(totalDeViaje({ total_price: '22.00' }).total).toBe(23.43);
    expect(totalDeViaje({ locked_fare: 22 }).total).toBe(23.43);
  });

  it('un viaje sin precio no inventa impuesto', () => {
    expect(totalDeViaje({})).toEqual({ total: 0, subtotal: 0, impuesto: 0, estimado: false });
    expect(totalDeViaje({ fare: 0, tax_amount: 5 }).total).toBe(0);
  });

  it('un impuesto de cero es válido y no se estima', () => {
    expect(totalDeViaje({ fare: 22, tax_amount: 0 }))
      .toEqual({ subtotal: 22, impuesto: 0, total: 22, estimado: false });
  });
});
