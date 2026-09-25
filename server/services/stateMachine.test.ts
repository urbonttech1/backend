import { describe, it, expect } from 'vitest';
import { validateTransition, isActiveStatus, ACTIVE_STATUSES, ESTADOS_CON_VIAJE_ACTIVO, tieneViajeActivo, viajeTerminado } from './stateMachine';

describe('validateTransition', () => {
  it('allows a driver to accept a searching ride', () => {
    const result = validateTransition('searching', 'confirmed', 'driver');
    expect(result.allowed).toBe(true);
  });

  it('allows an admin to dispatch a scheduled ride into searching', () => {
    const result = validateTransition('scheduled', 'searching', 'admin');
    expect(result.allowed).toBe(true);
  });

  it('rejects skipping straight from scheduled to confirmed', () => {
    const result = validateTransition('scheduled', 'confirmed', 'driver');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/must be in/i);
  });

  it('rejects a role that is not permitted to make the transition', () => {
    const result = validateTransition('searching', 'confirmed', 'passenger');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not permitted/i);
  });

  it('is idempotent when from === to', () => {
    const result = validateTransition('in_progress', 'in_progress', 'driver');
    expect(result.allowed).toBe(true);
  });

  it('rejects any transition out of a terminal "completed" state', () => {
    const result = validateTransition('completed', 'in_progress', 'admin');
    expect(result.allowed).toBe(false);
  });

  it('rejects any transition out of a terminal "cancelled" state', () => {
    const result = validateTransition('cancelled', 'searching', 'admin');
    expect(result.allowed).toBe(false);
  });

  it('blocks passengers from cancelling a trip already in progress', () => {
    const result = validateTransition('in_progress', 'cancelled', 'passenger');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/cannot be cancelled by the passenger/i);
  });

  it('still allows a driver to cancel a trip in progress (safety override)', () => {
    const result = validateTransition('in_progress', 'cancelled', 'driver');
    expect(result.allowed).toBe(true);
  });

  it('allows cancellation from every active (non-terminal) status for admin', () => {
    for (const status of ACTIVE_STATUSES) {
      const result = validateTransition(status, 'cancelled', 'admin');
      expect(result.allowed).toBe(true);
    }
  });
});

describe('isActiveStatus', () => {
  it('treats scheduled through in_progress as active', () => {
    expect(isActiveStatus('scheduled')).toBe(true);
    expect(isActiveStatus('searching')).toBe(true);
    expect(isActiveStatus('confirmed')).toBe(true);
    expect(isActiveStatus('driver_arrived')).toBe(true);
    expect(isActiveStatus('in_progress')).toBe(true);
  });

  it('treats completed and cancelled as inactive', () => {
    expect(isActiveStatus('completed')).toBe(false);
    expect(isActiveStatus('cancelled')).toBe(false);
  });
});
describe('ESTADOS_CON_VIAJE_ACTIVO — lo que la app recupera al volver', () => {
  it('incluye driver_arrived, que es el estado que se perdía', () => {
    // El bug: el chofer marcaba «llegué», se iba a WhatsApp y al volver la app
    // le decía que no tenía viaje, porque el servidor solo miraba confirmed
    // e in_progress.
    expect(tieneViajeActivo('driver_arrived')).toBe(true);
    expect(tieneViajeActivo('confirmed')).toBe(true);
    expect(tieneViajeActivo('in_progress')).toBe(true);
  });

  it('deja fuera los estados sin viaje entre manos', () => {
    expect(tieneViajeActivo('searching')).toBe(false);
    expect(tieneViajeActivo('scheduled')).toBe(false);
    expect(tieneViajeActivo('completed')).toBe(false);
    expect(tieneViajeActivo('cancelled')).toBe(false);
    expect(tieneViajeActivo(null)).toBe(false);
    expect(tieneViajeActivo(undefined)).toBe(false);
  });

  it('cubre todos los estados intermedios de la máquina', () => {
    // Si se añade un estado entre aceptar y completar, este test lo delata.
    expect(ESTADOS_CON_VIAJE_ACTIVO).toEqual(['confirmed', 'driver_arrived', 'in_progress']);
  });

  it('viajeTerminado distingue lo que ya no se recupera', () => {
    expect(viajeTerminado('completed')).toBe(true);
    expect(viajeTerminado('cancelled')).toBe(true);
    expect(viajeTerminado('driver_arrived')).toBe(false);
    expect(viajeTerminado(null)).toBe(false);
  });
});
