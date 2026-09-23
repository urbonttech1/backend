import { describe, it, expect } from 'vitest';
import { nombreDeConductor, nombreDelPerfil, urbontId } from './driverName';

const ID = 'b50d4430-d53e-4eaf-815e-435a63afffa2';

describe('nombreDeConductor', () => {
  it('manda el perfil, aunque el documento tenga otra cosa guardada', () => {
    // El conductor corrigió su nombre después de subir los documentos.
    expect(nombreDeConductor({
      perfil: { first_name: 'Felipe', last_name: 'Gonzalez' },
      copia: 'Felpe Gonzales',
      id: ID,
    })).toBe('Felipe Gonzalez');
  });

  it('con el perfil sin nombre, usa la copia del documento', () => {
    expect(nombreDeConductor({ perfil: { first_name: '', last_name: null }, copia: 'Ciro Vargas' }))
      .toBe('Ciro Vargas');
  });

  it('sin nombre en ningún sitio, el correo y luego el teléfono', () => {
    expect(nombreDeConductor({ perfil: { email: 'ciro@urbont.com' }, copia: '   ' }))
      .toBe('ciro@urbont.com');
    expect(nombreDeConductor({ perfil: { phone: '+573053001165' } }))
      .toBe('+573053001165');
  });

  it('sin nada, el Driver ID: es lo que el admin puede cruzar con Conductores', () => {
    expect(nombreDeConductor({ id: ID })).toBe('Conductor URB-B50D-4430');
  });

  it('nunca devuelve vacío ni «Unknown Driver»', () => {
    const sinNada = nombreDeConductor({});
    expect(sinNada).toBe('Conductor sin nombre');
    expect(sinNada).not.toMatch(/unknown/i);
  });

  it('un perfil a medias sigue sirviendo', () => {
    expect(nombreDeConductor({ perfil: { first_name: 'Tatiana' } })).toBe('Tatiana');
    expect(nombreDelPerfil({ last_name: 'Alzate' })).toBe('Alzate');
    expect(nombreDelPerfil(null)).toBe('');
  });
});

describe('urbontId', () => {
  it('el mismo formato que ve el conductor en su cuenta', () => {
    expect(urbontId(ID)).toBe('URB-B50D-4430');
  });

  it('vacío si no hay id con el que formarlo', () => {
    expect(urbontId('')).toBe('');
    expect(urbontId(null)).toBe('');
    expect(urbontId('abc')).toBe('');
  });
});
