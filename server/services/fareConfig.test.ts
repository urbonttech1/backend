import { describe, it, expect, afterEach } from 'vitest';
import { parseStoredFares } from './fareConfig';
import {
  setFareClasses, resetFareClasses, getFareClass,
  calculateFareFromRules, DEFAULT_FARE_CLASSES,
} from '../config/pricing';

/**
 * Lo que se guarda en `app_config.fares_config` decide lo que se le cobra al
 * pasajero. Estos tests cubren el camino entre esa fila y el precio final.
 */

afterEach(() => resetFareClasses());

describe('parseStoredFares', () => {
  it('traduce la clave heredada businessClass a sedan', () => {
    const parsed = parseStoredFares({ businessClass: { minFare: 30 } });
    expect(parsed.sedan).toBeDefined();
    expect(parsed.sedan.minFare).toBe(30);
    expect(parsed).not.toHaveProperty('businessClass');
  });

  it('acepta el esquema viejo del editor: baseFare por minFare', () => {
    const parsed = parseStoredFares({ sedan: { baseFare: 33 } });
    expect(parsed.sedan.minFare).toBe(33);
  });

  it('rellena con el default lo que la config no traiga', () => {
    const parsed = parseStoredFares({ sedan: { minFare: 30 } });
    // Sin esto, un campo ausente daría undefined y el precio saldría NaN.
    expect(parsed.sedan.perMileTier1).toBe(DEFAULT_FARE_CLASSES.sedan.perMileTier1);
    expect(parsed.sedan.perMileTier3).toBe(DEFAULT_FARE_CLASSES.sedan.perMileTier3);
    expect(parsed.sedan.waitPerMin).toBe(DEFAULT_FARE_CLASSES.sedan.waitPerMin);
    expect(parsed.sedan.perHour).toBe(DEFAULT_FARE_CLASSES.sedan.perHour);
    expect(parsed.sedan.name).toBe(DEFAULT_FARE_CLASSES.sedan.name);
  });

  it('ignora valores basura y se queda con el default', () => {
    const parsed = parseStoredFares({ sedan: { minFare: 'gratis', perMileTier2: -5 } });
    expect(parsed.sedan.minFare).toBe(DEFAULT_FARE_CLASSES.sedan.minFare);
    expect(parsed.sedan.perMileTier2).toBe(DEFAULT_FARE_CLASSES.sedan.perMileTier2);
  });

  it('una config anterior a los tramos usa su perMile en los tres', () => {
    const parsed = parseStoredFares({ sedan: { perMile: 4 } });
    expect(parsed.sedan.perMileTier1).toBe(4);
    expect(parsed.sedan.perMileTier2).toBe(4);
    expect(parsed.sedan.perMileTier3).toBe(4);
  });

  it('un tramo explícito gana al perMile viejo', () => {
    const parsed = parseStoredFares({ sedan: { perMile: 4, perMileTier3: 2 } });
    expect(parsed.sedan.perMileTier1).toBe(4);
    expect(parsed.sedan.perMileTier3).toBe(2);
  });

  it('waitPerMin es la tarifa de espera, no el tiempo de trayecto', () => {
    // En el esquema viejo del editor era alias de perMin. Ya no.
    const parsed = parseStoredFares({ sedan: { waitPerMin: 0.9 } });
    expect(parsed.sedan.waitPerMin).toBe(0.9);
    expect(parsed.sedan.perMin).toBe(DEFAULT_FARE_CLASSES.sedan.perMin);
  });

  it('descarta clases que no son vehículos', () => {
    const parsed = parseStoredFares({
      sedan:     { minFare: 30 },
      concierge: { baseFare: 10 },
      valet:     { baseFare: 35 },
    });
    expect(Object.keys(parsed)).toEqual(['sedan']);
  });

  it('tolera entradas rotas sin lanzar', () => {
    expect(parseStoredFares(null)).toEqual({});
    expect(parseStoredFares('nope')).toEqual({});
    expect(parseStoredFares({ sedan: null })).toEqual({});
  });
});

describe('las tarifas guardadas cambian lo que se cobra', () => {
  it('un cambio de tramo se refleja en el precio', () => {
    const antes = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 8, durationMinutes: 0 })!;
    expect(antes.distance_charge).toBe(7);    // 8 × $3.00 = 24 − mínima 17

    setFareClasses(parseStoredFares({ sedan: { ...DEFAULT_FARE_CLASSES.sedan, perMileTier2: 6.00 } }));

    const despues = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 8, durationMinutes: 0 })!;
    expect(despues.distance_charge).toBe(31); // 8 × $6.00 = 48 − 17
    expect(despues.total).toBeGreaterThan(antes.total);
  });

  it('la reserva guardada reemplaza a la de por defecto, sólo en programados', () => {
    setFareClasses(parseStoredFares({ sedan: { ...DEFAULT_FARE_CLASSES.sedan, serviceFee: 4.00 } }));
    const programado = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 2, durationMinutes: 0, bookingType: 'scheduled' })!;
    const aDemanda   = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 2, durationMinutes: 0 })!;
    expect(programado.booking_fee).toBe(4.00);
    expect(aDemanda.booking_fee).toBe(0);
  });

  it('una clase sin guardar conserva su default', () => {
    setFareClasses(parseStoredFares({ sedan: { minFare: 99 } }));
    expect(getFareClass('sedan')!.minFare).toBe(99);
    expect(getFareClass('suv')!.minFare).toBe(DEFAULT_FARE_CLASSES.suv.minFare);
  });

  it('los alias siguen resolviendo tras cargar de la base', () => {
    setFareClasses(parseStoredFares({ sedan: { ...DEFAULT_FARE_CLASSES.sedan, minFare: 40 } }));
    expect(getFareClass('Business Class')!.minFare).toBe(40);
  });

  it('resetFareClasses vuelve a los valores del código', () => {
    setFareClasses(parseStoredFares({ sedan: { minFare: 99 } }));
    resetFareClasses();
    expect(getFareClass('sedan')!.minFare).toBe(DEFAULT_FARE_CLASSES.sedan.minFare);
  });
});
