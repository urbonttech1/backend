import { describe, it, expect } from 'vitest';
import { calcularReparto, calculateRideMetrics } from './rideMetrics';

describe('calculateRideMetrics', () => {
  it('reparte 85/15 sobre el precio del viaje', () => {
    expect(calculateRideMetrics({ totalFareUSD: 45.5 })).toEqual({
      totalCents: 4550, applicationFeeCents: 683, driverPayoutCents: 3867, commissionRate: 0.15,
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
      applicationFeeCents: 473,   // $3,30 de comisión + $1,43 de impuesto
      driverPayoutCents: 1870,    // el 85 % del precio, limpio
      commissionRate: 0.15,
    });
  });

  it('lo que retiene la plataforma y lo que cobra el chofer suman el cobro', () => {
    for (const [fare, tax] of [[2200, 143], [1975, 141], [5000, 0], [1, 1]]) {
      const r = calcularReparto({ fareCents: fare, taxCents: tax });
      expect(r.applicationFeeCents + r.driverPayoutCents).toBe(r.chargeCents);
    }
  });

  it('sin impuesto, el reparto es el 85/15', () => {
    expect(calcularReparto({ fareCents: 4550 })).toMatchObject({
      chargeCents: 4550, applicationFeeCents: 683, driverPayoutCents: 3867,
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

describe('calcularReparto — viajes despachados por un valet', () => {
  it('la comisión del valet no sale del chofer', () => {
    // Servicio de $300 + $30 de comisión: al huésped se le cobran $330.
    const r = calcularReparto({ fareCents: 33000, valetCents: 3000 });
    expect(r).toEqual({
      chargeCents: 33000,
      applicationFeeCents: 7500,  // $45 de la plataforma + $30 del valet
      driverPayoutCents: 25500,   // el 85 % de los $300 del servicio
      commissionRate: 0.15,
    });
  });

  it('con impuesto, todo sigue cuadrando', () => {
    const r = calcularReparto({ fareCents: 3200, taxCents: 208, valetCents: 1000 });
    expect(r.driverPayoutCents).toBe(1870);            // 85 % de $22
    expect(r.applicationFeeCents + r.driverPayoutCents).toBe(r.chargeCents);
  });

  it('un viaje sin valet reparte como siempre', () => {
    expect(calcularReparto({ fareCents: 2200, valetCents: 0 }))
      .toMatchObject({ applicationFeeCents: 330, driverPayoutCents: 1870 });
  });

  it('la comisión no puede superar el precio', () => {
    expect(() => calcularReparto({ fareCents: 1000, valetCents: 1500 })).toThrow(RangeError);
  });
});
