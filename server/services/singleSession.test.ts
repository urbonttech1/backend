import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

// La regla no toca la base; sólo hace falta que importar el módulo no la abra.
vi.mock('../db/client', () => ({ issueToken: vi.fn() }));
vi.mock('../db/pool', () => ({ pool: { query: vi.fn() } }));

import { decide, sessionFromSupabaseToken } from './singleSession';

const T0 = Date.parse('2026-10-10T12:00:00Z');   // la columna se creó (despliegue)
const ANTES = T0 - 86_400_000;
const DESPUES = T0 + 60_000;

describe('decide', () => {
  describe('cuenta sin sesión registrada (todas las cuentas al desplegar)', () => {
    const sinSesion = { sid: null, loginAt: T0 };

    it('deja pasar los tokens anteriores, que no traen sid', () => {
      expect(decide(sinSesion, { sid: null, loginAt: null })).toEqual({ ok: true, register: false });
    });

    it('no registra un inicio con Google anterior al despliegue', () => {
      expect(decide(sinSesion, { sid: 'sb:a', loginAt: ANTES })).toEqual({ ok: true, register: false });
    });

    it('registra un inicio con Google posterior al despliegue', () => {
      expect(decide(sinSesion, { sid: 'sb:a', loginAt: DESPUES })).toEqual({ ok: true, register: true });
    });

    it('registra el primer inicio de una cuenta nueva', () => {
      expect(decide({ sid: null, loginAt: 0 }, { sid: 'sb:a', loginAt: ANTES })).toEqual({ ok: true, register: true });
    });
  });

  describe('cuenta con sesión registrada', () => {
    const vigente = { sid: 'b', loginAt: DESPUES };

    it('deja pasar la sesión vigente', () => {
      expect(decide(vigente, { sid: 'b', loginAt: DESPUES })).toEqual({ ok: true, register: false });
    });

    it('rechaza un token anterior sin sid', () => {
      expect(decide(vigente, { sid: null, loginAt: null })).toEqual({ ok: false, register: false });
    });

    it('rechaza una sesión iniciada antes que la vigente', () => {
      expect(decide(vigente, { sid: 'a', loginAt: DESPUES - 1 })).toEqual({ ok: false, register: false });
    });

    it('una sesión iniciada después reemplaza a la vigente', () => {
      expect(decide(vigente, { sid: 'c', loginAt: DESPUES + 1 })).toEqual({ ok: true, register: true });
    });

    it('rechaza un sid desconocido que no dice cuándo se inició', () => {
      expect(decide(vigente, { sid: 'c', loginAt: null })).toEqual({ ok: false, register: false });
    });
  });
});

describe('sessionFromSupabaseToken', () => {
  it('toma el session_id y la hora de autenticación', () => {
    const token = jwt.sign({ sub: 'u', session_id: 'abc', amr: [{ method: 'oauth', timestamp: 1_760_000_000 }] }, 'x');
    expect(sessionFromSupabaseToken(token)).toEqual({ sid: 'sb:abc', loginAt: 1_760_000_000_000 });
  });

  it('sin esos datos no identifica sesión', () => {
    expect(sessionFromSupabaseToken(jwt.sign({ sub: 'u' }, 'x'))).toEqual({ sid: null, loginAt: null });
    expect(sessionFromSupabaseToken('no-es-un-jwt')).toEqual({ sid: null, loginAt: null });
  });
});
