import { describe, it, expect } from 'vitest';
import {
  normalizarMultiplicador,
  parseSurgeConfig,
  resolverSurge,
  decidirAuto,
  debeEscribir,
  type SurgeConfig,
} from './surgeConfig';

const cfg = (parcial: Partial<SurgeConfig> = {}): SurgeConfig => ({
  autoEnabled: true,
  autoMultiplier: 1.0,
  autoUpdatedAt: null,
  manualMultiplier: null,
  manualReason: null,
  manualSetBy: null,
  manualSetAt: null,
  ...parcial,
});

describe('normalizarMultiplicador', () => {
  it('acepta números dentro del rango', () => {
    expect(normalizarMultiplicador(1.5)).toBe(1.5);
    expect(normalizarMultiplicador(1)).toBe(1);
    expect(normalizarMultiplicador(5)).toBe(5); // límite inclusivo, como PUT /api/config/surge
  });

  it('acepta texto con coma decimal, que es lo que teclea media Latinoamérica', () => {
    expect(normalizarMultiplicador('1,8')).toBe(1.8);
    expect(normalizarMultiplicador('2.25')).toBe(2.25);
  });

  it('redondea a dos decimales', () => {
    expect(normalizarMultiplicador(1.234)).toBe(1.23);
  });

  it('rechaza lo que está fuera de rango o no es un número', () => {
    expect(normalizarMultiplicador(0.9)).toBeNull();
    expect(normalizarMultiplicador(5.01)).toBeNull();
    expect(normalizarMultiplicador('mucho')).toBeNull();
    expect(normalizarMultiplicador(undefined)).toBeNull();
    expect(normalizarMultiplicador(null)).toBeNull();
    expect(normalizarMultiplicador('')).toBeNull();
  });
});

describe('parseSurgeConfig', () => {
  // Este es el test que garantiza que una instalación existente no cambia de
  // comportamiento al desplegar: sin la clave nueva, todo sigue como estaba.
  it('sin clave guardada deja el automático encendido con el multiplicador que ya hubiera', () => {
    const c = parseSurgeConfig(null, 1.3);
    expect(c.autoEnabled).toBe(true);
    expect(c.autoMultiplier).toBe(1.3);
    expect(c.manualMultiplier).toBeNull();
  });

  it('con JSON corrupto cae al mismo comportamiento en vez de romper', () => {
    expect(parseSurgeConfig('{roto', 1.15).autoEnabled).toBe(true);
    expect(parseSurgeConfig('[]', 1.15).autoMultiplier).toBe(1.15);
    expect(parseSurgeConfig('"texto"', 1.15).autoEnabled).toBe(true);
  });

  it('entiende autoEnabled como cadena, que es lo que pudo dejar el editor de texto libre', () => {
    expect(parseSurgeConfig('{"autoEnabled":"false"}').autoEnabled).toBe(false);
    expect(parseSurgeConfig('{"autoEnabled":"true"}').autoEnabled).toBe(true);
  });

  it('descarta un candado manual fuera de rango en vez de honrarlo', () => {
    expect(parseSurgeConfig('{"manualMultiplier":0.5}').manualMultiplier).toBeNull();
    expect(parseSurgeConfig('{"manualMultiplier":9}').manualMultiplier).toBeNull();
    expect(parseSurgeConfig('{"manualMultiplier":1.8}').manualMultiplier).toBe(1.8);
  });
});

describe('resolverSurge', () => {
  it('el candado manual manda sobre el automático', () => {
    expect(resolverSurge(cfg({ manualMultiplier: 1.8, autoMultiplier: 1.3 }), 1.0))
      .toEqual({ value: 1.8, origin: 'manual' });
  });

  it('sin candado manda el automático', () => {
    expect(resolverSurge(cfg({ autoMultiplier: 1.3 }), 1.0))
      .toEqual({ value: 1.3, origin: 'auto' });
  });

  // El sentido del interruptor: apagado es apagado, también frente a la franja.
  it('apagado y sin candado da 1.0 aunque la franja horaria diga otra cosa', () => {
    expect(resolverSurge(cfg({ autoEnabled: false, autoMultiplier: 1.3 }), 1.25))
      .toEqual({ value: 1.0, origin: 'off' });
  });

  it('el candado sobrevive al interruptor: el OFF gobierna al cron, no al admin', () => {
    expect(resolverSurge(cfg({ autoEnabled: false, manualMultiplier: 1.8, autoMultiplier: 1.3 }), 1.0))
      .toEqual({ value: 1.8, origin: 'manual' });
  });

  // Antes era max(franja, manual), así que esto era imposible.
  it('el manual puede bajar por debajo de la franja horaria', () => {
    expect(resolverSurge(cfg({ manualMultiplier: 1.0, autoMultiplier: 1.3 }), 1.25))
      .toEqual({ value: 1.0, origin: 'manual' });
  });

  it('sin candado, la franja gana si es mayor que el automático', () => {
    expect(resolverSurge(cfg({ autoMultiplier: 1.15 }), 1.25))
      .toEqual({ value: 1.25, origin: 'time' });
  });

  // En empate gana la config: si no, la etiqueta del panel parpadearía sola al
  // cruzar una franja y el operador vería "cambió algo" sin que cambiara nada.
  it('en empate reporta el automático, no la franja', () => {
    expect(resolverSurge(cfg({ autoMultiplier: 1.35 }), 1.35))
      .toEqual({ value: 1.35, origin: 'auto' });
  });
});

describe('decidirAuto', () => {
  it('aplica la escalera en cada frontera', () => {
    expect(decidirAuto(10, 9)).toBe(1.0);
    expect(decidirAuto(10, 10)).toBe(1.15);
    expect(decidirAuto(10, 15)).toBe(1.3);
    expect(decidirAuto(10, 20)).toBe(1.5);
    expect(decidirAuto(10, 30)).toBe(2.0);
  });

  it('sin conductores el ratio pasa a ser el número de viajes', () => {
    // Se fija el comportamiento actual tal cual, para que cambiarlo sea una
    // decisión deliberada y no un efecto colateral.
    expect(decidirAuto(0, 0)).toBe(1.0);
    expect(decidirAuto(0, 1)).toBe(1.15);
    expect(decidirAuto(0, 3)).toBe(2.0);
  });
});

describe('debeEscribir', () => {
  it('ignora los cambios por debajo de la histéresis', () => {
    expect(debeEscribir(1.0, 1.04)).toBe(false);
    expect(debeEscribir(1.3, 1.3)).toBe(false);
  });

  it('acepta los cambios que llegan al umbral', () => {
    expect(debeEscribir(1.0, 1.15)).toBe(true);
    expect(debeEscribir(1.5, 1.0)).toBe(true);
    expect(debeEscribir(1.0, 1.05)).toBe(true);
  });
});
