import { describe, it, expect } from 'vitest';
import { calculateFareFromRules, calculateHourlyFare, getTimeSurge, DEFAULT_FARE_CLASSES } from './pricing';

/**
 * Estos tests fijan el contrato de precios contra el anexo A del documento de la
 * app móvil (`06-decision-logica-negocio-backend.md`), que transcribe la lógica
 * que rige hoy en producción. Cualquier divergencia acá significa que la app y el
 * servidor cobran distinto.
 */

/** Un día y hora concretos en Miami, expresados en UTC (EDT = UTC-4 en septiembre). */
const miami = (isoUtc: string) => new Date(isoUtc);

describe('calculateFareFromRules — sin surge', () => {
  it('cobra sólo la tarifa mínima cuando el viaje entra en las millas incluidas', () => {
    const f = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 2, durationMinutes: 0 })!;
    expect(f.base_fare).toBe(25.00);
    expect(f.distance_charge).toBe(0);
    expect(f.time_charge).toBe(0);
    expect(f.booking_fee).toBe(2.50);
    expect(f.ride_fare).toBe(27.50);
    expect(f.platform_fee).toBe(2.75);
    expect(f.total).toBe(30.25);
  });

  it('cobra las millas que exceden las incluidas', () => {
    // 8 millas − 3 incluidas = 5 extra × $4.00 = $20.00
    const f = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 8, durationMinutes: 0 })!;
    expect(f.extra_miles).toBe(5);
    expect(f.distance_charge).toBe(20.00);
    expect(f.ride_fare).toBe(47.50);
  });

  it('aplica el factor 0.25 sobre la duración estimada', () => {
    // 20 min × $1.00/min × 0.25 = $5.00
    const f = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 2, durationMinutes: 20 })!;
    expect(f.time_charge).toBe(5.00);
  });

  it('suma la tarifa de programación a los viajes agendados', () => {
    const now = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 2, durationMinutes: 0 })!;
    const sched = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 2, durationMinutes: 0, bookingType: 'scheduled' })!;
    expect(now.booking_fee).toBe(2.50);
    expect(sched.booking_fee).toBe(7.50); // 2.50 + 5.00
  });

  it('resuelve los alias de vehículo que manda la app', () => {
    const alias = calculateFareFromRules({ vehicleType: 'Business Class', distanceMiles: 5, durationMinutes: 0 })!;
    const canon = calculateFareFromRules({ vehicleType: 'sedan',          distanceMiles: 5, durationMinutes: 0 })!;
    expect(alias.total).toBe(canon.total);
  });

  it('devuelve null para un vehículo desconocido', () => {
    expect(calculateFareFromRules({ vehicleType: 'submarino', distanceMiles: 5, durationMinutes: 0 })).toBeNull();
  });
});

describe('calculateFareFromRules — surge', () => {
  it('escala base, distancia y espera, pero NUNCA los cargos fijos', () => {
    const base  = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 8, durationMinutes: 20 })!;
    const surge = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 8, durationMinutes: 20, surgeMultiplier: 1.35 })!;

    expect(surge.base_fare).toBe(33.75);       // 25.00 × 1.35
    expect(surge.distance_charge).toBe(27.00); // 20.00 × 1.35
    expect(surge.time_charge).toBe(6.75);      //  5.00 × 1.35

    // La regla que más importa: el booking fee no lleva recargo.
    expect(surge.booking_fee).toBe(base.booking_fee);
    expect(surge.booking_fee).toBe(2.50);
  });

  it('la comisión se calcula sobre el total ya recargado', () => {
    const f = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 8, durationMinutes: 20, surgeMultiplier: 1.35 })!;
    // 33.75 + 27.00 + 6.75 + 2.50 = 70.00
    expect(f.ride_fare).toBe(70.00);
    expect(f.platform_fee).toBe(7.00);
    expect(f.total).toBe(77.00);
  });

  it('ignora un surge menor a 1: nunca abarata el viaje', () => {
    const plano = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 8, durationMinutes: 0 })!;
    const barato = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 8, durationMinutes: 0, surgeMultiplier: 0.5 })!;
    expect(barato.total).toBe(plano.total);
    expect(barato.surge_multiplier).toBe(1);
  });

  it('sin surge explícito el resultado es idéntico al de antes del cambio', () => {
    // Garantía de no-regresión: los precios de hoy no se mueven.
    const f = calculateFareFromRules({ vehicleType: 'suv', distanceMiles: 10, durationMinutes: 30 })!;
    expect(f.surge_multiplier).toBe(1);
    expect(f.base_fare).toBe(DEFAULT_FARE_CLASSES.suv.minFare);
    expect(f.distance_charge).toBe(38.50); // 7 millas × 5.50
    expect(f.time_charge).toBe(9.38);      // 30 min × 1.25 × 0.25 = 9.375 → r2
  });
});

describe('calculateHourlyFare — anexo A.3', () => {
  it('cobra el bloque de horas pedido', () => {
    // 4 h × $110 = $440 + $2.50 = $442.50; comisión $44.25
    const f = calculateHourlyFare({ vehicleType: 'sedan', hours: 4 })!;
    expect(f.billed_hours).toBe(4);
    expect(f.hourly_charge).toBe(440.00);
    expect(f.booking_fee).toBe(2.50);
    expect(f.ride_fare).toBe(442.50);
    expect(f.platform_fee).toBe(44.25);
    expect(f.total).toBe(486.75);
  });

  it('nunca cobra menos que el mínimo de la clase', () => {
    const f = calculateHourlyFare({ vehicleType: 'sedan', hours: 1 })!;
    expect(f.requested_hours).toBe(1);
    expect(f.billed_hours).toBe(2);          // mínimo de la clase
    expect(f.hourly_charge).toBe(220.00);
  });

  it('usa la tarifa de cada clase', () => {
    expect(calculateHourlyFare({ vehicleType: 'suv', hours: 2 })!.hourly_charge).toBe(290.00);
    expect(calculateHourlyFare({ vehicleType: 'van', hours: 2 })!.hourly_charge).toBe(370.00);
  });

  it('el surge escala las horas pero no el cargo fijo', () => {
    const f = calculateHourlyFare({ vehicleType: 'sedan', hours: 4, surgeMultiplier: 1.35 })!;
    expect(f.hourly_charge).toBe(594.00);    // 440 × 1.35
    expect(f.booking_fee).toBe(2.50);        // intacto
  });

  it('resuelve alias igual que la tarifa por distancia', () => {
    const alias = calculateHourlyFare({ vehicleType: 'Premium SUV', hours: 3 })!;
    const canon = calculateHourlyFare({ vehicleType: 'suv',         hours: 3 })!;
    expect(alias.total).toBe(canon.total);
  });

  it('rechaza vehículos y horas inválidas', () => {
    expect(calculateHourlyFare({ vehicleType: 'submarino', hours: 3 })).toBeNull();
    expect(calculateHourlyFare({ vehicleType: 'sedan', hours: -1 })).toBeNull();
    expect(calculateHourlyFare({ vehicleType: 'sedan', hours: NaN })).toBeNull();
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
    // 2026-09-12T03:00Z es viernes 23:00 en Miami pero ya sábado en UTC.
    // Si la función leyera UTC, daría 1.0 en vez de 1.35.
    expect(getTimeSurge(miami('2026-09-12T03:00:00Z'))).toBe(1.35);
  });
});
