import { describe, it, expect } from 'vitest';
import { esEmailDuplicado, esFalloDeServicio } from './authErrors';

/**
 * El caso que originó esto: un conductor intentó darse de alta con un correo
 * que ya tenía cuenta y recibió «Registration failed. Please try again.» —
 * un 500 genérico— porque la detección del duplicado comparaba textos y el
 * mensaje real de Supabase no casaba. Reintentó a los 7 segundos, en vano.
 */

describe('esEmailDuplicado', () => {
  it('reconoce el mensaje EXACTO que devolvió producción el 2026-09-11', () => {
    // Éste es el que fallaba: `includes('already registered')` da false porque
    // el mensaje dice «already **been** registered».
    expect(esEmailDuplicado({
      message: 'A user with this email address has already been registered',
    })).toBe(true);
  });

  it('reconoce el duplicado por código, sin mirar el mensaje', () => {
    expect(esEmailDuplicado({ code: 'email_exists', message: 'cualquier cosa' })).toBe(true);
    expect(esEmailDuplicado({ code: 'user_already_exists' })).toBe(true);
  });

  it('reconoce el duplicado por status 422', () => {
    expect(esEmailDuplicado({ status: 422, message: 'texto que nadie previó' })).toBe(true);
  });

  it('sigue reconociendo las variantes de texto que ya se contemplaban', () => {
    for (const message of [
      'User already registered',
      'Email already exists',
      'That address is already taken',
      'A user with this email address has already been registered',
    ]) {
      expect(esEmailDuplicado({ message }), message).toBe(true);
    }
  });

  it('no confunde otros fallos con un duplicado', () => {
    for (const err of [
      { message: 'Password should be at least 6 characters', status: 400 },
      { message: 'Invalid email format', status: 400 },
      { message: 'fetch failed' },
      { message: 'Database error creating new user', status: 500 },
    ]) {
      expect(esEmailDuplicado(err), err.message).toBe(false);
    }
  });

  it('tolera null y undefined', () => {
    expect(esEmailDuplicado(null)).toBe(false);
    expect(esEmailDuplicado(undefined)).toBe(false);
    expect(esEmailDuplicado({})).toBe(false);
  });
});

describe('esFalloDeServicio', () => {
  it('reconoce los fallos de red y de configuración', () => {
    for (const message of [
      'fetch failed',
      'connect ECONNREFUSED 127.0.0.1:54321',
      'getaddrinfo ENOTFOUND db.supabase.co',
      'Invalid API key',
      'request timeout',
    ]) {
      expect(esFalloDeServicio({ message }), message).toBe(true);
    }
  });

  it('reconoce cualquier 5xx del proveedor', () => {
    expect(esFalloDeServicio({ status: 500 })).toBe(true);
    expect(esFalloDeServicio({ status: 503 })).toBe(true);
  });

  it('no marca como fallo de servicio lo que es culpa del formulario', () => {
    expect(esFalloDeServicio({ status: 400, message: 'Invalid email format' })).toBe(false);
    expect(esFalloDeServicio({ status: 422, message: 'already been registered' })).toBe(false);
  });

  it('un duplicado no es un fallo de servicio, y al revés tampoco', () => {
    const duplicado = { code: 'email_exists', status: 422, message: 'already been registered' };
    expect(esEmailDuplicado(duplicado)).toBe(true);
    expect(esFalloDeServicio(duplicado)).toBe(false);

    const caido = { message: 'fetch failed' };
    expect(esFalloDeServicio(caido)).toBe(true);
    expect(esEmailDuplicado(caido)).toBe(false);
  });
});
