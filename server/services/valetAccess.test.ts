import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/client', () => ({ supabaseAdmin: {} }));

import { estadoAcceso } from './valetAccess';

describe('estadoAcceso', () => {
  it('un valet activo y aprobado entra', () => {
    expect(estadoAcceso({ accountStatus: 'active', applicationStatus: 'approved' })).toBe('ok');
  });

  it('un valet antiguo, sin solicitud, entra', () => {
    expect(estadoAcceso({ accountStatus: 'active', applicationStatus: null })).toBe('ok');
    expect(estadoAcceso({})).toBe('ok');
  });

  it('la solicitud web pendiente bloquea aunque el perfil diga active', () => {
    expect(estadoAcceso({ accountStatus: 'active', applicationStatus: 'pending' })).toBe('pending');
  });

  it('el perfil pendiente bloquea', () => {
    expect(estadoAcceso({ accountStatus: 'pending', applicationStatus: null })).toBe('pending');
  });

  it('suspendido y rechazado mandan sobre pendiente', () => {
    expect(estadoAcceso({ accountStatus: 'suspended', applicationStatus: 'pending' })).toBe('suspended');
    expect(estadoAcceso({ accountStatus: 'pending', applicationStatus: 'rejected' })).toBe('rejected');
  });
});
