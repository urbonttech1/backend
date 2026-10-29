import { describe, it, expect } from 'vitest';
import { enIdioma, idiomaPorTelefono, normalizarIdioma, resolverIdioma } from './pushLanguage';

describe('normalizarIdioma', () => {
  it('reduce la etiqueta a su idioma base', () => {
    expect(normalizarIdioma('es-CO')).toBe('es');
    expect(normalizarIdioma('ES_us')).toBe('es');
    expect(normalizarIdioma('en')).toBe('en');
  });

  it('manda en inglés los idiomas que la app tiene y las notificaciones no', () => {
    expect(normalizarIdioma('fr')).toBe('en');
    expect(normalizarIdioma('pt-BR')).toBe('en');
  });

  it('devuelve null sólo cuando no hay dato', () => {
    expect(normalizarIdioma(null)).toBeNull();
    expect(normalizarIdioma('  ')).toBeNull();
    expect(normalizarIdioma(42)).toBeNull();
  });
});

describe('idiomaPorTelefono', () => {
  it('reconoce países de habla hispana', () => {
    expect(idiomaPorTelefono('+57 300 123 4567')).toBe('es');
    expect(idiomaPorTelefono('+52 55 1234 5678')).toBe('es');
    expect(idiomaPorTelefono('+1 787 555 0100')).toBe('es');
  });

  it('no adivina con Estados Unidos ni sin prefijo', () => {
    expect(idiomaPorTelefono('+1 305 555 0100')).toBeNull();
    expect(idiomaPorTelefono('3001234567')).toBeNull();
    expect(idiomaPorTelefono(null)).toBeNull();
  });
});

describe('resolverIdioma', () => {
  it('manda el idioma del token sobre todo lo demás', () => {
    expect(resolverIdioma({ token: 'en', preferencia: 'es', telefono: '+57300' })).toBe('en');
  });

  it('sin token usa la preferencia, luego el teléfono, luego inglés', () => {
    expect(resolverIdioma({ preferencia: 'es', telefono: '+1305' })).toBe('es');
    expect(resolverIdioma({ telefono: '+573001234567' })).toBe('es');
    expect(resolverIdioma({ telefono: '+13055550100' })).toBe('en');
    expect(resolverIdioma({})).toBe('en');
  });

  it('una preferencia en francés gana al teléfono colombiano y sale en inglés', () => {
    expect(resolverIdioma({ preferencia: 'fr', telefono: '+573001234567' })).toBe('en');
  });
});

describe('enIdioma', () => {
  const aviso = {
    title: 'Your ride is here!',
    body: 'Your chauffeur is waiting.',
    es: { title: '¡Tu chofer llegó!', body: 'Tu chofer te espera.' },
    data: { type: 'driver_arrived', title: 'Your ride is here!', body: 'Your chauffeur is waiting.' },
  };

  it('pone el texto en español, también en data, y no deja `es` en lo que se envía', () => {
    const m = enIdioma(aviso, 'es');
    expect(m.title).toBe('¡Tu chofer llegó!');
    expect(m.body).toBe('Tu chofer te espera.');
    expect(m.data).toEqual({ type: 'driver_arrived', title: '¡Tu chofer llegó!', body: 'Tu chofer te espera.' });
    expect(m).not.toHaveProperty('es');
  });

  it('en inglés deja el texto como estaba', () => {
    const m = enIdioma(aviso, 'en');
    expect(m.title).toBe('Your ride is here!');
    expect(m.data?.title).toBe('Your ride is here!');
  });

  it('sin versión en español, el usuario en español recibe el inglés', () => {
    const m = enIdioma({ title: 'Hi', body: 'There' }, 'es');
    expect(m).toEqual({ title: 'Hi', body: 'There' });
  });

  it('no toca un data.title que no repite el título', () => {
    const m = enIdioma({ ...aviso, data: { title: 'Otro' } }, 'es');
    expect(m.data?.title).toBe('Otro');
  });
});
