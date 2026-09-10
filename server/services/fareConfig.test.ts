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
    expect(parsed.sedan.perMile).toBe(DEFAULT_FARE_CLASSES.sedan.perMile);
    expect(parsed.sedan.perHour).toBe(DEFAULT_FARE_CLASSES.sedan.perHour);
    expect(parsed.sedan.name).toBe(DEFAULT_FARE_CLASSES.sedan.name);
  });

  it('ignora valores basura y se queda con el default', () => {
    const parsed = parseStoredFares({ sedan: { minFare: 'gratis', perMile: -5 } });
    expect(parsed.sedan.minFare).toBe(DEFAULT_FARE_CLASSES.sedan.minFare);
    expect(parsed.sedan.perMile).toBe(DEFAULT_FARE_CLASSES.sedan.perMile);
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
  it('un cambio de perMile se refleja en el precio', () => {
    const antes = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 8, durationMinutes: 0 })!;
    expect(antes.distance_charge).toBe(20.00);   // 5 millas × $4.00

    setFareClasses(parseStoredFares({ sedan: { ...DEFAULT_FARE_CLASSES.sedan, perMile: 6.00 } }));

    const despues = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 8, durationMinutes: 0 })!;
    expect(despues.distance_charge).toBe(30.00); // 5 millas × $6.00
    expect(despues.total).toBeGreaterThan(antes.total);
  });

  it('el cargo de servicio guardado reemplaza al de por defecto', () => {
    setFareClasses(parseStoredFares({ sedan: { ...DEFAULT_FARE_CLASSES.sedan, serviceFee: 4.00 } }));
    const f = calculateFareFromRules({ vehicleType: 'sedan', distanceMiles: 2, durationMinutes: 0 })!;
    expect(f.booking_fee).toBe(4.00);
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
