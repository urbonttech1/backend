import { describe, expect, it } from 'vitest';
import { cambiaTelefonoSinCodigo, numeroEnOtraCuenta } from './profilePhone';

describe('cambiaTelefonoSinCodigo', () => {
  it('el pasajero necesita el código: entra por SMS con ese número', () => {
    expect(cambiaTelefonoSinCodigo('passenger')).toBe(false);
    expect(cambiaTelefonoSinCodigo(null)).toBe(false);
  });

  it('conductor y valet lo siguen editando como dato de contacto', () => {
    expect(cambiaTelefonoSinCodigo('chauffeur')).toBe(true);
    expect(cambiaTelefonoSinCodigo('valet')).toBe(true);
  });
});

describe('numeroEnOtraCuenta', () => {
  const YO = 'yo';

  it('choca con otra cuenta de pasajero', () => {
    expect(numeroEnOtraCuenta([{ id: 'otro', role: 'passenger' }], YO, 'passenger')).toBe(true);
    expect(numeroEnOtraCuenta([{ id: 'otro', role: null }], YO, 'passenger')).toBe(true);
  });

  it('no choca con la cuenta de conductor de la misma persona', () => {
    expect(numeroEnOtraCuenta([{ id: 'otro', role: 'chauffeur' }], YO, 'passenger')).toBe(false);
  });

  it('no choca consigo misma (volver a guardar el mismo número)', () => {
    expect(numeroEnOtraCuenta([{ id: YO, role: 'passenger' }], YO, 'passenger')).toBe(false);
  });

  it('sin coincidencias, libre', () => {
    expect(numeroEnOtraCuenta([], YO, 'passenger')).toBe(false);
  });
});
