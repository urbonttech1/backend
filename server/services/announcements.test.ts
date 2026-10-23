import { describe, it, expect } from 'vitest';
import {
  estaVigente, alcanza, traducir, aAvisoDeLaApp, avisosPara,
  normalizarRol, normalizarIdioma, esAudiencia,
  type FilaAviso,
} from './announcements';

const AHORA = new Date('2026-10-23T12:00:00Z');

const fila = (extra: Partial<FilaAviso> = {}): FilaAviso => ({
  id: 'a1',
  contenido: { en: { title: 'New airport fare', description: 'Flat rate from MIA.' } },
  audiencia: 'all',
  tipo: 'news',
  icono: 'newspaper',
  etiqueta: null,
  enlace: null,
  publicado: true,
  desde: '2026-10-20T00:00:00Z',
  hasta: null,
  ...extra,
});

describe('estaVigente', () => {
  it('publicado, empezado y sin caducidad', () => {
    expect(estaVigente(fila(), AHORA)).toBe(true);
  });

  it('sin publicar no sale aunque este en fecha', () => {
    expect(estaVigente(fila({ publicado: false }), AHORA)).toBe(false);
  });

  it('programado a futuro todavia no sale', () => {
    expect(estaVigente(fila({ desde: '2026-11-01T00:00:00Z' }), AHORA)).toBe(false);
  });

  it('caducado deja de salir', () => {
    expect(estaVigente(fila({ hasta: '2026-10-22T00:00:00Z' }), AHORA)).toBe(false);
  });

  it('con caducidad futura sigue vigente', () => {
    expect(estaVigente(fila({ hasta: '2026-12-01T00:00:00Z' }), AHORA)).toBe(true);
  });

  it('una fecha ilegible no lo deja fuera para siempre', () => {
    // `hasta` roto se trata como sin caducidad; `desde` roto sí lo saca, porque
    // sin saber cuándo empieza no se puede decir que ya empezó.
    expect(estaVigente(fila({ hasta: 'no es fecha' }), AHORA)).toBe(true);
    expect(estaVigente(fila({ desde: 'no es fecha' }), AHORA)).toBe(false);
  });
});

describe('alcanza', () => {
  it('all llega a los tres roles', () => {
    for (const rol of ['passenger', 'driver', 'concierge']) {
      expect(alcanza(fila({ audiencia: 'all' }), rol)).toBe(true);
    }
  });

  it('uno dirigido solo llega al suyo', () => {
    expect(alcanza(fila({ audiencia: 'driver' }), 'driver')).toBe(true);
    expect(alcanza(fila({ audiencia: 'driver' }), 'passenger')).toBe(false);
  });
});

describe('traducir', () => {
  const dos = {
    en: { title: 'New fare', description: 'Flat rate.' },
    es: { title: 'Tarifa nueva', description: 'Precio fijo.' },
  };

  it('da el idioma pedido', () => {
    expect(traducir(dos, 'es')!.title).toBe('Tarifa nueva');
  });

  it('un idioma sin traducir cae en ingles, no desaparece', () => {
    expect(traducir(dos, 'fr')!.title).toBe('New fare');
  });

  it('sin ingles ni el pedido, no sale', () => {
    expect(traducir({ es: { title: 'Solo español' } }, 'fr')).toBeNull();
  });

  it('un titulo vacio no cuenta como traduccion y cae en el respaldo', () => {
    // Si no, saldría una tarjeta en blanco en la pantalla del pasajero.
    expect(traducir({ es: { title: '   ' }, en: { title: 'Hello' } }, 'es')!.title).toBe('Hello');
  });

  it('si el respaldo tambien esta vacio, no sale', () => {
    // Deliberado: la cadena es idioma pedido → ingles, y nada mas. Enseñar un
    // idioma cualquiera porque sí sería peor que no enseñarlo; el panel exige
    // el ingles justamente para que esto no ocurra.
    expect(traducir({ en: { title: '  ' }, es: { title: 'Hola' } }, 'en')).toBeNull();
  });

  it('acepta el JSONB como texto, que es como llega por pg', () => {
    expect(traducir(JSON.stringify(dos), 'es')!.title).toBe('Tarifa nueva');
  });

  it('con basura no revienta', () => {
    for (const v of [null, undefined, '{no es json', 42 as unknown]) {
      expect(traducir(v as FilaAviso['contenido'], 'en')).toBeNull();
    }
  });

  it('el cta solo va si lo hay', () => {
    expect(traducir({ en: { title: 'T', cta: 'Reservar' } }, 'en')!.cta).toBe('Reservar');
    expect(traducir({ en: { title: 'T' } }, 'en')!.cta).toBeUndefined();
  });
});

describe('aAvisoDeLaApp', () => {
  it('sale con la forma que la app ya pinta', () => {
    const a = aAvisoDeLaApp(fila({ etiqueta: 'Nuevo', enlace: 'booking' }), 'en')!;
    expect(a).toMatchObject({
      id: 'a1',
      type: 'news',
      title: 'New airport fare',
      iconType: 'newspaper',
      pinned: true,
      tag: 'Nuevo',
      link: 'booking',
    });
    expect(a.timeMs).toBe(Date.parse('2026-10-20T00:00:00Z'));
  });

  it('un tipo que no conocemos cae en news en vez de romper la vista', () => {
    expect(aAvisoDeLaApp(fila({ tipo: 'inventado' }), 'en')!.type).toBe('news');
  });

  it('sin texto utilizable devuelve null', () => {
    expect(aAvisoDeLaApp(fila({ contenido: {} }), 'en')).toBeNull();
  });
});

describe('avisosPara', () => {
  const lista: FilaAviso[] = [
    fila({ id: 'viejo', desde: '2026-10-01T00:00:00Z' }),
    fila({ id: 'nuevo', desde: '2026-10-22T00:00:00Z' }),
    fila({ id: 'caducado', hasta: '2026-10-21T00:00:00Z' }),
    fila({ id: 'borrador', publicado: false }),
    fila({ id: 'solo-chofer', audiencia: 'driver' }),
    fila({ id: 'sin-texto', contenido: {} }),
  ];

  it('filtra, traduce y ordena lo mas nuevo primero', () => {
    const r = avisosPara(lista, { rol: 'passenger', lang: 'en', ahora: AHORA });
    expect(r.map(a => a.id)).toEqual(['nuevo', 'viejo']);
  });

  it('el chofer ve ademas el suyo', () => {
    const ids = avisosPara(lista, { rol: 'driver', lang: 'en', ahora: AHORA }).map(a => a.id);
    expect(ids).toContain('solo-chofer');
  });

  it('respeta el limite', () => {
    expect(avisosPara(lista, { rol: 'passenger', lang: 'en', ahora: AHORA, limite: 1 })).toHaveLength(1);
  });

  it('sin filas, lista vacia', () => {
    expect(avisosPara([], { rol: 'passenger', lang: 'en' })).toEqual([]);
  });
});

describe('normalizar lo que manda la app', () => {
  it('el rol acepta los nombres internos y cae en passenger', () => {
    expect(normalizarRol('driver')).toBe('driver');
    expect(normalizarRol('chauffeur')).toBe('driver');
    expect(normalizarRol('valet')).toBe('concierge');
    expect(normalizarRol('concierge')).toBe('concierge');
    // Un parámetro mal escrito no debe dejar a nadie sin avisos.
    for (const v of ['', null, undefined, 'lo que sea']) expect(normalizarRol(v)).toBe('passenger');
  });

  it('el idioma admite es-ES y cae en ingles', () => {
    expect(normalizarIdioma('es')).toBe('es');
    expect(normalizarIdioma('es-ES')).toBe('es');
    expect(normalizarIdioma('PT')).toBe('pt');
    for (const v of ['', null, 'zz']) expect(normalizarIdioma(v)).toBe('en');
  });

  it('esAudiencia solo acepta las cuatro', () => {
    expect(esAudiencia('all')).toBe(true);
    expect(esAudiencia('driver')).toBe(true);
    expect(esAudiencia('todos')).toBe(false);
  });
});
