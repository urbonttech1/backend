import { describe, expect, it, vi } from 'vitest';

// La regla no toca la base; sólo hace falta que importar el módulo no la abra.
vi.mock('./client', () => ({ supabaseAdmin: {} }));

import { perfilPasajeroAlEntrar } from './helpers';

const UID = 'a1b2c3d4-0000-0000-0000-000000000000';
const NOW = '2026-10-13T12:00:00.000Z';
const GOOGLE = { first_name: 'Pepe', last_name: 'Google', email: 'pepe@gmail.com' };

describe('perfilPasajeroAlEntrar', () => {
  it('crea el perfil nuevo con lo que trae el inicio de sesión', () => {
    const p = perfilPasajeroAlEntrar(UID, null, GOOGLE, NOW);
    expect(p).toMatchObject({
      id: UID, role: 'passenger', membership_type: 'standard', avatar_url: '/default-avatar.svg',
      total_rides: 0, first_name: 'Pepe', last_name: 'Google', email: 'pepe@gmail.com', phone: null,
    });
  });

  it('no pisa el nombre, el correo ni la foto que la persona ya guardó', () => {
    const guardado = {
      first_name: 'Pepe Pistolas', last_name: 'Cargadas', email: 'cvc@gmail.com',
      avatar_url: 'https://cdn/foto.jpg', membership_type: 'vip', phone: '+13055550100',
    };
    const p = perfilPasajeroAlEntrar(UID, guardado, { ...GOOGLE, phone: '+13055550199' }, NOW);
    expect(p).not.toHaveProperty('first_name');
    expect(p).not.toHaveProperty('last_name');
    expect(p).not.toHaveProperty('email');
    expect(p).not.toHaveProperty('phone');
    expect(p).not.toHaveProperty('avatar_url');
    expect(p).not.toHaveProperty('membership_type');
    expect(p).not.toHaveProperty('total_rides');
  });

  it('completa lo que falta en un perfil existente (el que crea el trigger solo trae correo)', () => {
    const p = perfilPasajeroAlEntrar(UID, { email: 'pepe@gmail.com' }, GOOGLE, NOW);
    expect(p).toMatchObject({ first_name: 'Pepe', last_name: 'Google', avatar_url: '/default-avatar.svg' });
    expect(p).not.toHaveProperty('email');
  });

  it('no borra nada de un perfil existente cuando el inicio de sesión no trae el dato', () => {
    const p = perfilPasajeroAlEntrar(UID, { first_name: 'Ana' }, { phone: '+13055550100' }, NOW);
    expect(p).toMatchObject({ phone: '+13055550100' });
    expect(p).not.toHaveProperty('first_name');
    expect(p).not.toHaveProperty('email');
  });
});
