import { describe, it, expect } from 'vitest';
import { elegirPerfilPorTelefono, variantesTelefono } from './phoneProfiles';

const pasajero = { id: 'p1', phone: '+573053001165', role: 'passenger', created_at: '2026-03-01T10:00:00Z' };
const conductor = { id: 'c1', phone: '+573053001165', role: 'chauffeur', created_at: '2026-01-01T10:00:00Z' };

describe('variantesTelefono', () => {
  it('cubre el número con y sin el +, sin repetirlo', () => {
    expect(variantesTelefono('+573053001165')).toEqual(['+573053001165', '573053001165']);
    expect(variantesTelefono('573053001165')).toEqual(['573053001165', '+573053001165']);
  });
});

describe('elegirPerfilPorTelefono', () => {
  it('con un solo perfil, ése', () => {
    expect(elegirPerfilPorTelefono([conductor])?.id).toBe('c1');
  });

  it('el pasajero gana, aunque el de conductor sea más antiguo', () => {
    // El OTP es la vía del pasajero: el conductor entra con correo y contraseña.
    expect(elegirPerfilPorTelefono([conductor, pasajero])?.id).toBe('p1');
    expect(elegirPerfilPorTelefono([pasajero, conductor])?.id).toBe('p1');
  });

  it('entre dos del mismo rol, el más antiguo, siempre el mismo', () => {
    const viejo = { ...pasajero, id: 'p0', created_at: '2025-12-31T23:59:00Z' };
    expect(elegirPerfilPorTelefono([pasajero, viejo])?.id).toBe('p0');
    expect(elegirPerfilPorTelefono([viejo, pasajero])?.id).toBe('p0');
  });

  it('un perfil sin rol cuenta como pasajero, y sin fecha va al final', () => {
    const sinRol = { id: 'x', phone: '+573053001165', role: null };
    expect(elegirPerfilPorTelefono([conductor, sinRol])?.id).toBe('x');
    expect(elegirPerfilPorTelefono([sinRol, pasajero])?.id).toBe('p1');
  });

  it('sin perfiles, null', () => {
    expect(elegirPerfilPorTelefono([])).toBeNull();
  });
});
