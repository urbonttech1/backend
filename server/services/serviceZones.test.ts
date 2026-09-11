import { describe, it, expect, afterEach } from 'vitest';
import { resolveZone, setZones, resetZones, getZones, getSearchBias, type ServiceZone } from './serviceZones';

/**
 * La geocerca decide quién puede pedir un viaje. Estos tests fijan dos cosas:
 * que el área actual no cambie al mover la definición del código a la base, y
 * que el prefiltro de caja nunca descarte un punto que el círculo aceptaría.
 */

afterEach(() => resetZones());

/** Coordenadas reales, con su distancia al centro de Miami. */
const PUNTOS = {
  miami:          { lat: 25.7617, lng: -80.1918, km:   0 },
  fortLauderdale: { lat: 26.1224, lng: -80.1373, km:  40 },
  westPalmBeach:  { lat: 26.7153, lng: -80.0534, km: 107 },
  naples:         { lat: 26.1420, lng: -81.7948, km: 166 },
  keyWest:        { lat: 24.5551, lng: -81.7800, km: 209 },
  orlando:        { lat: 28.5383, lng: -81.3792, km: 330 },
  tampa:          { lat: 27.9506, lng: -82.4572, km: 331 },
  atlanta:        { lat: 33.7490, lng: -84.3880, km: 976 },
};

const zona = (over: Partial<ServiceZone> = {}): ServiceZone => ({
  id: 'miami',
  name: 'Miami / Sur de Florida',
  active: true,
  timezone: 'America/New_York',
  centerLat: 25.7617,
  centerLng: -80.1918,
  radiusKm: 125,
  hasBoundary: false,
  bbox: null,
  ...over,
});

describe('resolveZone — el área de hoy no cambia', () => {
  it('acepta lo que hoy está dentro del radio de 125 km', () => {
    for (const nombre of ['miami', 'fortLauderdale', 'westPalmBeach'] as const) {
      const p = PUNTOS[nombre];
      expect(resolveZone(p.lat, p.lng)?.id, `${nombre} (${p.km} km) debería entrar`).toBe('miami');
    }
  });

  it('rechaza lo que hoy queda fuera', () => {
    for (const nombre of ['naples', 'keyWest', 'orlando', 'tampa', 'atlanta'] as const) {
      const p = PUNTOS[nombre];
      expect(resolveZone(p.lat, p.lng), `${nombre} (${p.km} km) debería quedar fuera`).toBeNull();
    }
  });

  it('devuelve la zona, no un booleano — es lo que permitirá tarifas y permisos por ciudad', () => {
    const z = resolveZone(PUNTOS.miami.lat, PUNTOS.miami.lng)!;
    expect(z.id).toBe('miami');
    expect(z.timezone).toBe('America/New_York');
  });

  it('rechaza coordenadas inválidas sin lanzar', () => {
    expect(resolveZone(NaN, -80.19)).toBeNull();
    expect(resolveZone(25.76, Infinity)).toBeNull();
  });
});

describe('resolveZone — el prefiltro de caja no puede producir falsos negativos', () => {
  it('acepta puntos en el borde exacto del círculo, en las cuatro direcciones', () => {
    // ~124 km del centro: dentro por poco. Si la caja recortara de más, estos
    // fallarían y serían viajes rechazados sin motivo.
    const grado = 124 / 111;
    const casos = [
      { lat: 25.7617 + grado, lng: -80.1918, dir: 'norte' },
      { lat: 25.7617 - grado, lng: -80.1918, dir: 'sur' },
      { lat: 25.7617, lng: -80.1918 + grado / Math.cos((25.7617 * Math.PI) / 180), dir: 'este' },
      { lat: 25.7617, lng: -80.1918 - grado / Math.cos((25.7617 * Math.PI) / 180), dir: 'oeste' },
    ];
    for (const c of casos) {
      expect(resolveZone(c.lat, c.lng)?.id, `borde ${c.dir}`).toBe('miami');
    }
  });

  it('descarta un punto justo fuera del radio', () => {
    // ~130 km al norte: fuera del círculo aunque dentro de la caja.
    expect(resolveZone(25.7617 + 130 / 111, -80.1918)).toBeNull();
  });
});

describe('varias zonas', () => {
  const orlando = zona({ id: 'orlando', name: 'Orlando', centerLat: 28.5383, centerLng: -81.3792, radiusKm: 80 });

  it('resuelve cada punto a su zona', () => {
    setZones([zona(), orlando]);
    expect(resolveZone(PUNTOS.miami.lat, PUNTOS.miami.lng)?.id).toBe('miami');
    expect(resolveZone(PUNTOS.orlando.lat, PUNTOS.orlando.lng)?.id).toBe('orlando');
  });

  it('un punto entre ambas no pertenece a ninguna', () => {
    setZones([zona(), orlando]);
    expect(resolveZone(PUNTOS.tampa.lat, PUNTOS.tampa.lng)).toBeNull();
  });

  it('ampliar el radio abre una ciudad sin tocar código', () => {
    expect(resolveZone(PUNTOS.naples.lat, PUNTOS.naples.lng)).toBeNull();
    setZones([zona({ radiusKm: 250 })]);
    expect(resolveZone(PUNTOS.naples.lat, PUNTOS.naples.lng)?.id).toBe('miami');
    expect(resolveZone(PUNTOS.keyWest.lat, PUNTOS.keyWest.lng)?.id).toBe('miami');
  });

  it('las zonas con polígono no las resuelve el camino síncrono', () => {
    // Su prueba exacta necesitaría PostGIS. Hoy ninguna fila las tiene.
    setZones([zona({ hasBoundary: true })]);
    expect(resolveZone(PUNTOS.miami.lat, PUNTOS.miami.lng)).toBeNull();
  });
});

describe('getSearchBias — el sesgo de búsqueda de direcciones sale de las zonas', () => {
  const orlando = zona({ id: 'orlando', name: 'Orlando', centerLat: 28.5383, centerLng: -81.3792, radiusKm: 80 });

  it('con una zona, centra en ella y anuncia que basta un círculo', () => {
    const b = getSearchBias();
    expect(b.lat).toBe(25.7617);
    expect(b.lng).toBe(-80.1918);
    expect(b.radiusM).toBe(125_000);
    expect(b.zonasActivas).toBe(1); // geocode.ts usa esto para aplicar strictbounds
  });

  it('con varias, centra en la más grande y la caja cubre a todas', () => {
    setZones([orlando, zona()]); // Miami va segunda a propósito: manda el radio, no el orden
    const b = getSearchBias();
    expect(b.lat).toBe(25.7617);
    expect(b.zonasActivas).toBe(2);

    // La caja tiene que contener ambos centros, o Orlando quedaría fuera del encuadre.
    const [swLat, swLng] = b.boundsSw.split(',').map(Number);
    const [neLat, neLng] = b.boundsNe.split(',').map(Number);
    for (const [nombre, lat, lng] of [['miami', 25.7617, -80.1918], ['orlando', 28.5383, -81.3792]] as const) {
      expect(lat >= swLat && lat <= neLat && lng >= swLng && lng <= neLng, `${nombre} dentro de la caja`).toBe(true);
    }
  });

  it('ampliar el radio desde el panel también amplía el sesgo', () => {
    expect(getSearchBias().radiusM).toBe(125_000);
    setZones([zona({ radiusKm: 250 })]);
    expect(getSearchBias().radiusM).toBe(250_000);
  });
});

describe('estado por defecto', () => {
  it('arranca con Miami aunque la base no haya respondido nunca', () => {
    const z = getZones();
    expect(z).toHaveLength(1);
    expect(z[0].id).toBe('miami');
    expect(z[0].radiusKm).toBe(125);
  });

  it('resetZones vuelve al círculo original', () => {
    setZones([zona({ radiusKm: 999 })]);
    expect(resolveZone(PUNTOS.atlanta.lat, PUNTOS.atlanta.lng)?.id).toBe('miami');
    resetZones();
    expect(resolveZone(PUNTOS.atlanta.lat, PUNTOS.atlanta.lng)).toBeNull();
  });
});
