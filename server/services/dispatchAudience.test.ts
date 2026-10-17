import { afterEach, describe, expect, it } from 'vitest';
import { audienciaDelViaje, decidirAviso, zonaPorCiudad, type ConductorCandidato } from './dispatchAudience';

const MIAMI = { lat: 25.7617, lng: -80.1918 };
const FORT_LAUDERDALE = { lat: 26.1224, lng: -80.1373 };   // ~40 km de Miami
const BARRANQUILLA = { lat: 10.96854, lng: -74.78132 };

const ZONAS = [{ id: 'miami', name: 'Miami / Sur de Florida' }, { id: 'barranquilla', name: 'Barranquilla' }];

/** Las zonas reales son círculos: Miami 200 km, Barranquilla 50 km. */
const resolverZona = (lat: number, lng: number): string | null => {
  const km = (a: { lat: number; lng: number }) => {
    const R = 6371, rad = (d: number) => (d * Math.PI) / 180;
    const dLat = rad(lat - a.lat), dLng = rad(lng - a.lng);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };
  if (km(MIAMI) <= 200) return 'miami';
  if (km(BARRANQUILLA) <= 50) return 'barranquilla';
  return null;
};

const AHORA = Date.parse('2026-10-17T12:00:00Z');
const base = { zonaDelViaje: 'miami', pickupLat: MIAMI.lat, pickupLng: MIAMI.lng, resolverZona, zonas: ZONAS, ahora: AHORA };
const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();

const conductor = (p: Partial<ConductorCandidato> = {}): ConductorCandidato => ({
  driverId: 'd1', lat: MIAMI.lat, lng: MIAMI.lng, updatedAt: hace(1), operatingCity: null, ...p,
});

afterEach(() => { delete process.env.DISPATCH_AUDIENCE; });

describe('zona: el filtro grueso', () => {
  it('no avisa a un conductor de otra ciudad', () => {
    const r = decidirAviso(conductor({ ...BARRANQUILLA }), base);
    expect(r).toEqual({ avisar: false, motivo: 'zona-distinta' });
  });

  it('vale una posición vieja: la ciudad no cambia entre viajes', () => {
    expect(decidirAviso(conductor({ ...BARRANQUILLA, updatedAt: hace(600) }), base).avisar).toBe(false);
  });

  it('sin posición, usa la ciudad del perfil', () => {
    expect(decidirAviso(conductor({ lat: null, lng: null, operatingCity: 'Barranquilla, CO' }), base).avisar).toBe(false);
    expect(decidirAviso(conductor({ lat: null, lng: null, operatingCity: 'Miami, FL' }), base).avisar).toBe(true);
  });

  it('si no se sabe dónde está, avisa', () => {
    const sinNada = conductor({ lat: null, lng: null, operatingCity: null });
    expect(decidirAviso(sinNada, base)).toEqual({ avisar: true, motivo: 'zona-desconocida' });
    // 'Fort Lauderdale' no se parece al nombre de ninguna zona: no se adivina.
    expect(decidirAviso(conductor({ lat: null, lng: null, operatingCity: 'Fort Lauderdale' }), base).avisar).toBe(true);
  });

  it('sin zona del viaje, se avisa como antes', () => {
    expect(decidirAviso(conductor({ ...BARRANQUILLA }), { ...base, zonaDelViaje: null }))
      .toEqual({ avisar: true, motivo: 'sin-zona-del-viaje' });
  });
});

describe('distancia: el filtro fino', () => {
  it('avisa dentro del radio y no fuera', () => {
    expect(decidirAviso(conductor({ lat: 25.78, lng: -80.2 }), base).motivo).toBe('dentro-del-radio');
    expect(decidirAviso(conductor({ ...FORT_LAUDERDALE }), base)).toEqual({ avisar: false, motivo: 'fuera-del-radio' });
  });

  it('con la app en segundo plano (GPS viejo) sigue avisando dentro de su zona', () => {
    // Fort Lauderdale está en la zona de Miami pero a 40 km del punto de
    // recogida: con GPS fresco no se le avisa, y con GPS viejo sí. Ese es
    // justo el caso que el push existe para cubrir.
    expect(decidirAviso(conductor({ ...FORT_LAUDERDALE }), base).avisar).toBe(false);
    expect(decidirAviso(conductor({ ...FORT_LAUDERDALE, updatedAt: hace(45) }), base))
      .toEqual({ avisar: true, motivo: 'sin-gps-reciente' });
  });

  it('sin coordenadas de recogida no se mide distancia', () => {
    expect(decidirAviso(conductor({ ...FORT_LAUDERDALE }), { ...base, pickupLat: null, pickupLng: null }))
      .toEqual({ avisar: true, motivo: 'sin-coordenadas-de-recogida' });
  });
});

describe('zonaPorCiudad', () => {
  it('reconoce la ciudad sólo cuando no hay duda', () => {
    expect(zonaPorCiudad('Miami, FL', ZONAS)).toBe('miami');
    expect(zonaPorCiudad('  BARRANQUILLA ', ZONAS)).toBe('barranquilla');
    expect(zonaPorCiudad('Fort Lauderdale', ZONAS)).toBeNull();
    expect(zonaPorCiudad(null, ZONAS)).toBeNull();
    expect(zonaPorCiudad('Miami', [])).toBeNull();
  });
});

describe('audienciaDelViaje', () => {
  it('reparte y cuenta los motivos', () => {
    const r = audienciaDelViaje([
      conductor({ driverId: 'cerca', lat: 25.78, lng: -80.2 }),
      conductor({ driverId: 'lejos', ...FORT_LAUDERDALE }),
      conductor({ driverId: 'otra-ciudad', ...BARRANQUILLA }),
      conductor({ driverId: 'fondo', ...FORT_LAUDERDALE, updatedAt: hace(60) }),
    ], base);
    expect(r.avisar).toEqual(['cerca', 'fondo']);
    expect(r.motivos).toEqual({ 'dentro-del-radio': 1, 'fuera-del-radio': 1, 'zona-distinta': 1, 'sin-gps-reciente': 1 });
  });

  it('DISPATCH_AUDIENCE=off deja pasar a todos', () => {
    process.env.DISPATCH_AUDIENCE = 'off';
    const r = audienciaDelViaje([conductor({ driverId: 'otra-ciudad', ...BARRANQUILLA })], base);
    expect(r.avisar).toEqual(['otra-ciudad']);
  });
});
