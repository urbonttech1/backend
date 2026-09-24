import { describe, it, expect } from 'vitest';
import { estadoDeCuenta, puedeCobrar, hayQueConsultarAStripe } from './connectStatus';

describe('estadoDeCuenta — qué cuenta de Stripe puede recibir una transferencia', () => {
  it('es «active» con la capacidad transfers habilitada', () => {
    // El caso real de los dos choferes de producción.
    expect(estadoDeCuenta({
      charges_enabled: true, payouts_enabled: true, details_submitted: true,
      capabilities: { transfers: 'active' },
    })).toBe('active');
  });

  it('es «pending» mientras transfers no esté activa, aunque el alta esté enviada', () => {
    expect(estadoDeCuenta({
      details_submitted: true, payouts_enabled: true,
      capabilities: { transfers: 'pending' },
    })).toBe('pending');
    expect(estadoDeCuenta({ details_submitted: true, capabilities: { transfers: 'inactive' } })).toBe('pending');
    expect(estadoDeCuenta({ details_submitted: true })).toBe('pending');
  });

  it('sin cuenta, «not_connected»', () => {
    expect(estadoDeCuenta(null)).toBe('not_connected');
    expect(estadoDeCuenta(undefined)).toBe('not_connected');
  });
});

describe('puedeCobrar', () => {
  it('sólo con «active»', () => {
    expect(puedeCobrar('active')).toBe(true);
    expect(puedeCobrar('pending')).toBe(false);
    expect(puedeCobrar('not_connected')).toBe(false);
    expect(puedeCobrar(null)).toBe(false);
    expect(puedeCobrar(undefined)).toBe(false);
  });
});

describe('hayQueConsultarAStripe', () => {
  it('se consulta cuando hay cuenta y la columna no la da por activa', () => {
    // El fallo que dejó sin pagar a los choferes: cuenta buena, columna vieja.
    expect(hayQueConsultarAStripe('acct_123', 'pending')).toBe(true);
    expect(hayQueConsultarAStripe('acct_123', 'not_connected')).toBe(true);
    expect(hayQueConsultarAStripe('acct_123', null)).toBe(true);
  });

  it('no se consulta si la columna ya está al día', () => {
    expect(hayQueConsultarAStripe('acct_123', 'active')).toBe(false);
  });

  it('no se consulta si el chofer no tiene cuenta', () => {
    expect(hayQueConsultarAStripe(null, 'pending')).toBe(false);
    expect(hayQueConsultarAStripe('', 'pending')).toBe(false);
  });
});
