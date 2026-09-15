import { describe, it, expect, afterEach } from 'vitest';
import {
  calculateFareFromRules,
  calculateHourlyFare,
  calcularImporteDistancia,
  calcularCargoEspera,
  calcularNoShowDemanda,
  calcularCancelacionReserva,
  minutosParaNoShowDemanda,
  getTimeSurge,
  getPricingPolicy,
  setFareClasses,
  resetFareClasses,
  DEFAULT_FARE_CLASSES,
} from './pricing';

/**
 * Estos tests fijan las tarifas acordadas con el cliente
 * (`docs/relacion_tarifas.odt` y `docs/PLAN_TARIFAS_CLIENTE.md`). Cualquier
 * divergencia acá significa que se cobra distinto de lo pactado.
 */

afterEach(() => resetFareClasses());

/** Un día y hora concretos en Miami, expresados en UTC (EDT = UTC-4 en septiembre). */
const miami = (isoUtc: string) => new Date(isoUtc);

const fare = (vehicleType: string, distanceMiles: number, durationMinutes = 0, bookingType?: string, surgeMultiplier?: number) =>
  calculateFareFromRules({ vehicleType, distanceMiles, durationMinutes, bookingType, surgeMultiplier })!;

describe('tarifas acordadas — valores por clase', () => {
  it('fija las tarifas del documento del cliente', () => {
    expect(DEFAULT_FARE_CLASSES.sedan).toMatchObject({ minFare: 17, perMileTier1: 2.90, perMileTier2: 3.00, perMileTier3: 2.50, waitPerMin: 0.75, serviceFee: 10 });
    expect(DEFAULT_FARE_CLASSES.suv).toMatchObject({   minFare: 22, perMileTier1: 3.50, perMileTier2: 3.50, perMileTier3: 3.00, waitPerMin: 1.00, serviceFee: 15 });
    expect(DEFAULT_FARE_CLASSES.van).toMatchObject({   minFare: 27, perMileTier1: 3.75, perMileTier2: 4.00, perMileTier3: 3.50, waitPerMin: 1.25, serviceFee: 20 });
  });

  it('mantiene el tiempo de trayecto y la tarifa por hora de antes', () => {
    expect(DEFAULT_FARE_CLASSES.sedan).toMatchObject({ perMin: 1.00, perHour: 110, minHours: 2 });
    expect(DEFAULT_FARE_CLASSES.suv).toMatchObject({   perMin: 1.25, perHour: 145, minHours: 2 });
    expect(DEFAULT_FARE_CLASSES.van).toMatchObject({   perMin: 1.75, perHour: 185, minHours: 2 });
  });
});

describe('calculateFareFromRules — casos del plan', () => {
  it('sedan 2 mi, 8 min, a demanda → $20.90 (aplica la mínima)', () => {
    const f = fare('sedan', 2, 8);
    expect(f.base_fare).toBe(17);
    expect(f.distance_charge).toBe(0);     // 2 × 2.90 = 5.80 < mínima
    expect(f.time_charge).toBe(2);         // 8 × 1.00 × 0.25
    expect(f.booking_fee).toBe(0);         // a demanda: sin reserva
    expect(f.ride_fare).toBe(19);
    expect(f.platform_fee).toBe(1.90);
    expect(f.total).toBe(20.90);
    expect(f.tier).toBe(1);
    expect(f.per_mile).toBe(2.90);
  });

  it('sedan 8 mi, 20 min, a demanda → $31.90', () => {
    const f = fare('sedan', 8, 20);
    expect(f.tier).toBe(2);
    expect(f.per_mile).toBe(3.00);
    expect(f.base_fare + f.distance_charge).toBe(24); // 8 × 3.00
    expect(f.time_charge).toBe(5);
    expect(f.total).toBe(31.90);
  });

  it('van 20 mi, 40 min, a demanda → $96.25', () => {
    const f = fare('van', 20, 40);
    expect(f.tier).toBe(3);
    expect(f.base_fare + f.distance_charge).toBe(70); // 20 × 3.50
    expect(f.time_charge).toBe(17.5);                // 40 × 1.75 × 0.25
    expect(f.total).toBe(96.25);
  });

  it('un viaje de 10,5 mi cuenta como tramo de más de 10 mi', () => {
    expect(fare('sedan', 10.5).tier).toBe(3);
    expect(fare('sedan', 10).tier).toBe(2);
    expect(fare('sedan', 3).tier).toBe(1);
    expect(fare('sedan', 3.01).tier).toBe(2);
  });
});

describe('calculateFareFromRules — el salto de 10 a 11 millas', () => {
  it('sedan de 11 mi cuesta lo mismo que uno de 10, no menos', () => {
    // Sin la corrección: 11 × 2.50 = $27.50 < 10 × 3.00 = $30.00.
    expect(fare('sedan', 11, 25).total).toBe(fare('sedan', 10, 25).total);
    expect(calcularImporteDistancia(DEFAULT_FARE_CLASSES.sedan, 11)).toBe(30);
  });

  it('pasado el punto de equilibrio, vuelve a crecer con el tramo 3', () => {
    // 13 × 2.50 = 32.50 > 30
    expect(calcularImporteDistancia(DEFAULT_FARE_CLASSES.sedan, 13)).toBe(32.5);
  });

  it('el precio nunca baja al aumentar la distancia, en ninguna clase (0–30 mi)', () => {
    for (const clase of ['sedan', 'suv', 'van']) {
      let anterior = -1;
      for (let d = 0; d <= 30.0001; d += 0.1) {
        const total = fare(clase, d, 0).total;
        expect(total, `${clase} a ${d.toFixed(1)} mi`).toBeGreaterThanOrEqual(anterior);
        anterior = total;
      }
    }
  });

  it('tampoco baja si desde el panel se cargan tramos decrecientes', () => {
    // Tarifas absurdas a propósito: cada tramo más barato que el anterior.
    setFareClasses({ sedan: { ...DEFAULT_FARE_CLASSES.sedan, minFare: 0, perMileTier1: 9, perMileTier2: 4, perMileTier3: 1 } });
    let anterior = -1;
    for (let d = 0; d <= 30.0001; d += 0.1) {
      const total = fare('sedan', d, 0).total;
      expect(total, `sedan a ${d.toFixed(1)} mi`).toBeGreaterThanOrEqual(anterior);
      anterior = total;
    }
  });
});

describe('calculateFareFromRules — reserva', () => {
  it('sólo la pagan los viajes programados, con el importe de su clase', () => {
    expect(fare('sedan', 8, 20).booking_fee).toBe(0);
    expect(fare('sedan', 8, 20, 'scheduled').booking_fee).toBe(10);
    expect(fare('suv',   8, 20, 'scheduled').booking_fee).toBe(15);
    expect(fare('van',   8, 20, 'scheduled').booking_fee).toBe(20);
  });

  it('un programado suma la reserva al total, con su 10 %', () => {
    // 31.90 a demanda; programado: (29 + 10) × 1.10 = 42.90
    expect(fare('sedan', 8, 20, 'scheduled').total).toBe(42.90);
  });

  it('el recargo nunca multiplica la reserva', () => {
    const f = fare('sedan', 8, 20, 'scheduled', 1.35);
    expect(f.booking_fee).toBe(10);
  });
});

describe('calculateFareFromRules — recargo por demanda', () => {
  it('escala base, distancia y tiempo', () => {
    const f = fare('sedan', 8, 20, undefined, 1.35);
    expect(f.base_fare).toBe(22.95);        // 17 × 1.35
    expect(f.distance_charge).toBe(9.45);   // (24 − 17) × 1.35
    expect(f.time_charge).toBe(6.75);       // 5 × 1.35
    expect(f.surge_multiplier).toBe(1.35);
  });

  it('ignora un recargo menor a 1: nunca abarata el viaje', () => {
    expect(fare('sedan', 8, 0, undefined, 0.5).total).toBe(fare('sedan', 8, 0).total);
  });
});

describe('calculateFareFromRules — contrato con la app', () => {
  it('mantiene los campos de la respuesta y añade per_mile y tier', () => {
    const f = fare('suv', 8, 20);
    for (const campo of ['base_fare', 'distance_charge', 'time_charge', 'booking_fee', 'ride_fare',
      'platform_fee', 'total', 'surge_multiplier', 'distance_miles', 'extra_miles',
      'included_miles', 'duration_minutes', 'currency', 'per_mile', 'tier']) {
      expect(f, campo).toHaveProperty(campo);
    }
  });

  it('resuelve los alias de vehículo que manda la app', () => {
    expect(fare('Business Class', 5).total).toBe(fare('sedan', 5).total);
    expect(fare('SUV', 5).total).toBe(fare('suv', 5).total);
  });

  it('devuelve null para un vehículo desconocido', () => {
    expect(calculateFareFromRules({ vehicleType: 'submarino', distanceMiles: 5, durationMinutes: 0 })).toBeNull();
  });
});

describe('calcularCargoEspera', () => {
  it('3 y 5 min son gratis', () => {
    expect(calcularCargoEspera('sedan', 3).fee).toBe(0);
    expect(calcularCargoEspera('sedan', 5).fee).toBe(0);
  });

  it('12 min cobran 7, a la tarifa de la clase', () => {
    expect(calcularCargoEspera('sedan', 12)).toEqual({ billableMinutes: 7, fee: 5.25 });  // 7 × 0.75
    expect(calcularCargoEspera('van',   12)).toEqual({ billableMinutes: 7, fee: 8.75 });  // 7 × 1.25
  });

  it('tiene tope de 10 minutos cobrables', () => {
    expect(calcularCargoEspera('suv', 30)).toEqual({ billableMinutes: 10, fee: 10 });     // 10 × 1.00
  });

  it('cobra minutos enteros, no fracciones', () => {
    expect(calcularCargoEspera('sedan', 5.9).billableMinutes).toBe(0);
    expect(calcularCargoEspera('sedan', 6.9).billableMinutes).toBe(1);
  });

  it('un viaje de valet no paga espera', () => {
    expect(calcularCargoEspera('sedan', 30, true)).toEqual({ billableMinutes: 0, fee: 0 });
  });
});

describe('no-show', () => {
  it('a demanda se puede marcar tras 5 + 10 min', () => {
    expect(minutosParaNoShowDemanda()).toBe(15);
  });

  it('sedan con viaje de $31.90 → $10.69', () => {
    // 10 × 0.75 + 10 % × 31.90 = 7.50 + 3.19
    expect(calcularNoShowDemanda('sedan', 31.90)).toBe(10.69);
  });

  it('usa la tarifa de espera de cada clase', () => {
    expect(calcularNoShowDemanda('van', 100)).toBe(22.5);  // 12.50 + 10
  });

  it('un viaje de valet no paga no-show', () => {
    expect(calcularNoShowDemanda('sedan', 31.90, true)).toBe(0);
  });
});

describe('calcularCancelacionReserva', () => {
  const h = (horas: number, minutos: number) => horas + minutos / 60;

  it('2 h 01 antes → gratis', () => {
    expect(calcularCancelacionReserva(h(2, 1), 100)).toEqual({ porcentaje: 0, fee: 0 });
  });

  it('1 h 59 antes → 50 %', () => {
    expect(calcularCancelacionReserva(h(1, 59), 100)).toEqual({ porcentaje: 0.5, fee: 50 });
  });

  it('1 h 00 antes → 50 %', () => {
    expect(calcularCancelacionReserva(h(1, 0), 100)).toEqual({ porcentaje: 0.5, fee: 50 });
  });

  it('0 h 59 antes → 100 %', () => {
    expect(calcularCancelacionReserva(h(0, 59), 100)).toEqual({ porcentaje: 1, fee: 100 });
  });

  it('ya pasada la hora → 100 %', () => {
    expect(calcularCancelacionReserva(-0.5, 42.9).fee).toBe(42.9);
  });

  it('un viaje de valet no paga cancelación', () => {
    expect(calcularCancelacionReserva(0, 100, true).fee).toBe(0);
  });
});

describe('calculateHourlyFare', () => {
  it('cobra el bloque de horas pedido, sin reserva si no es programado', () => {
    // 4 h × $110 = $440; comisión $44
    const f = calculateHourlyFare({ vehicleType: 'sedan', hours: 4 })!;
    expect(f.billed_hours).toBe(4);
    expect(f.hourly_charge).toBe(440);
    expect(f.booking_fee).toBe(0);
    expect(f.total).toBe(484);
  });

  it('suma la reserva cuando es programado', () => {
    const f = calculateHourlyFare({ vehicleType: 'sedan', hours: 4, bookingType: 'scheduled' })!;
    expect(f.booking_fee).toBe(10);
    expect(f.total).toBe(495);   // (440 + 10) × 1.10
  });

  it('nunca cobra menos que el mínimo de la clase', () => {
    const f = calculateHourlyFare({ vehicleType: 'sedan', hours: 1 })!;
    expect(f.billed_hours).toBe(2);
    expect(f.hourly_charge).toBe(220);
  });

  it('el recargo escala las horas pero no la reserva', () => {
    const f = calculateHourlyFare({ vehicleType: 'sedan', hours: 4, bookingType: 'scheduled', surgeMultiplier: 1.35 })!;
    expect(f.hourly_charge).toBe(594);
    expect(f.booking_fee).toBe(10);
  });

  it('rechaza vehículos y horas inválidas', () => {
    expect(calculateHourlyFare({ vehicleType: 'submarino', hours: 3 })).toBeNull();
    expect(calculateHourlyFare({ vehicleType: 'sedan', hours: -1 })).toBeNull();
    expect(calculateHourlyFare({ vehicleType: 'sedan', hours: NaN })).toBeNull();
  });
});

describe('getPricingPolicy', () => {
  it('publica las reglas acordadas', () => {
    const p = getPricingPolicy();
    expect(p.wait).toEqual({ freeMinutes: 5, maxBillableMinutes: 10 });
    expect(p.noShow).toEqual({ onDemandAfterMinutes: 15, scheduledAfterMinutes: 30 });
    expect(p.scheduledCancellation).toEqual({ freeHoursBefore: 2, halfChargeHoursBefore: 1 });
    expect(p.onDemandCancellationFee).toBe(0);
    expect(p.mileTiers).toEqual({ tier1MaxMiles: 3, tier2MaxMiles: 10 });
  });
});

describe('getTimeSurge — franjas horarias en la zona de operación', () => {
  it('recarga 1.35 la noche del viernes', () => {
    expect(getTimeSurge(miami('2026-09-12T03:00:00Z'))).toBe(1.35); // vie 23:00 Miami
  });

  it('sigue en 1.35 en la madrugada del sábado, que es la misma noche', () => {
    expect(getTimeSurge(miami('2026-09-12T05:00:00Z'))).toBe(1.35); // sáb 01:00 Miami
  });

  it('recarga 1.25 en el pico de la mañana entre semana', () => {
    expect(getTimeSurge(miami('2026-09-09T12:00:00Z'))).toBe(1.25); // mié 08:00 Miami
  });

  it('recarga 1.22 en el pico de la tarde entre semana', () => {
    expect(getTimeSurge(miami('2026-09-09T21:00:00Z'))).toBe(1.22); // mié 17:00 Miami
  });

  it('recarga 1.15 de madrugada cualquier día', () => {
    expect(getTimeSurge(miami('2026-09-09T07:00:00Z'))).toBe(1.15); // mié 03:00 Miami
  });

  it('no recarga en una tarde tranquila entre semana', () => {
    expect(getTimeSurge(miami('2026-09-09T18:00:00Z'))).toBe(1.0); // mié 14:00 Miami
  });

  it('no recarga el domingo por la noche: no es viernes ni sábado', () => {
    expect(getTimeSurge(miami('2026-09-14T03:00:00Z'))).toBe(1.0); // dom 23:00 Miami
  });

  it('usa la hora de Miami, no la del proceso', () => {
    expect(getTimeSurge(miami('2026-09-12T03:00:00Z'))).toBe(1.35);
  });
});
