import { describe, it, expect } from 'vitest';
import { calcularReparto, calculateRideMetrics } from './rideMetrics';

describe('calculateRideMetrics', () => {
  it('reparte 90/10 sobre el precio del viaje', () => {
    expect(calculateRideMetrics({ totalFareUSD: 45.5 })).toEqual({
      totalCents: 4550, applicationFeeCents: 455, driverPayoutCents: 4095, commissionRate: 0.1,
    });
  });

  it('rechaza un importe negativo', () => {
    expect(() => calculateRideMetrics({ totalFareUSD: -1 })).toThrow(RangeError);
  });
});
describe('calcularReparto — el cobro con Stripe Connect', () => {
  it('el viaje de $22 con $1,43 de impuesto', () => {
    expect(calcularReparto({ fareCents: 2200, taxCents: 143 })).toEqual({
      chargeCents: 2343,          // lo que se cobra a la tarjeta
      applicationFeeCents: 363,   // $2,20 de comisión + $1,43 de impuesto
      driverPayoutCents: 1980,    // el 90 % del precio, limpio
      commissionRate: 0.10,
    });
  });

  it('lo que retiene la plataforma y lo que cobra el chofer suman el cobro', () => {
    for (const [fare, tax] of [[2200, 143], [1975, 141], [5000, 0], [1, 1]]) {
      const r = calcularReparto({ fareCents: fare, taxCents: tax });
      expect(r.applicationFeeCents + r.driverPayoutCents).toBe(r.chargeCents);
    }
  });

  it('sin impuesto, el reparto es el 90/10 de siempre', () => {
    expect(calcularReparto({ fareCents: 4550 })).toMatchObject({
      chargeCents: 4550, applicationFeeCents: 455, driverPayoutCents: 4095,
    });
  });

  it('el impuesto nunca sale del chofer', () => {
    const sinImpuesto = calcularReparto({ fareCents: 2200 });
    const conImpuesto = calcularReparto({ fareCents: 2200, taxCents: 143 });
    expect(conImpuesto.driverPayoutCents).toBe(sinImpuesto.driverPayoutCents);
  });

  it('rechaza importes negativos', () => {
    expect(() => calcularReparto({ fareCents: -1 })).toThrow(RangeError);
    expect(() => calcularReparto({ fareCents: 100, taxCents: -5 })).toThrow(RangeError);
  });
});
