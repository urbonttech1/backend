import { describe, it, expect } from 'vitest';
import { claveDeNavegador, claveDeServidor, mapIdPublicado } from './mapsKeys';

const NAVEGADOR = 'AIza-navegador-por-referente';
const SERVIDOR  = 'AIza-servidor-por-ip';
const VIEJA     = 'AIza-la-de-siempre';

describe('las dos claves de Maps no se mezclan', () => {
  it('cada lado toma la suya cuando ambas están definidas', () => {
    const env = { GOOGLE_MAPS_BROWSER_KEY: NAVEGADOR, GOOGLE_MAPS_SERVER_KEY: SERVIDOR };
    expect(claveDeNavegador(env)).toBe(NAVEGADOR);
    expect(claveDeServidor(env)).toBe(SERVIDOR);
  });

  it('el servidor nunca usa la clave de navegador', () => {
    // El fallo que esto evita: Geocoding y Directions rechazan por diseño una
    // clave restringida por referente, con REQUEST_DENIED.
    expect(claveDeServidor({ GOOGLE_MAPS_BROWSER_KEY: NAVEGADOR })).toBe('');
  });

  it('sin variables nuevas, todo sigue como antes', () => {
    const env = { VITE_GOOGLE_MAPS_API_KEY: VIEJA };
    expect(claveDeNavegador(env)).toBe(VIEJA);
    expect(claveDeServidor(env)).toBe(VIEJA);
  });

  it('el servidor prefiere la sin prefijo sobre la VITE', () => {
    const env = { VITE_GOOGLE_MAPS_API_KEY: NAVEGADOR, GOOGLE_MAPS_API_KEY: SERVIDOR };
    expect(claveDeServidor(env)).toBe(SERVIDOR);
    expect(claveDeNavegador(env)).toBe(NAVEGADOR);
  });

  it('los valores vacíos o en blanco no cuentan', () => {
    expect(claveDeNavegador({ GOOGLE_MAPS_BROWSER_KEY: '   ', VITE_GOOGLE_MAPS_API_KEY: VIEJA })).toBe(VIEJA);
    expect(claveDeServidor({})).toBe('');
  });

  it('recorta los espacios que deja un copiar y pegar', () => {
    expect(claveDeNavegador({ GOOGLE_MAPS_BROWSER_KEY: ` ${NAVEGADOR} ` })).toBe(NAVEGADOR);
  });
});

describe('mapIdPublicado', () => {
  it('manda la VITE y cae a la sin prefijo', () => {
    expect(mapIdPublicado({ VITE_GOOGLE_MAPS_MAP_ID: 'fec8d029a85fa788bca001e0' })).toBe('fec8d029a85fa788bca001e0');
    expect(mapIdPublicado({ GOOGLE_MAPS_MAP_ID: 'otro' })).toBe('otro');
    expect(mapIdPublicado({})).toBe('');
  });
});
