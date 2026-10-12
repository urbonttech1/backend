import { describe, it, expect } from 'vitest';
import { ACUERDO_HASH, ACUERDO_VERSION, aceptacionValida, copiaFirmada, hashAcuerdo } from './valetAgreement';

describe('firma electrónica del acuerdo', () => {
  it('el hash corresponde al texto exacto de esta versión', () => {
    expect(ACUERDO_HASH).toBe(hashAcuerdo());
    expect(ACUERDO_HASH).toHaveLength(64);
  });

  it('rechaza aceptar sin la casilla, sin el botón o con otra versión', () => {
    expect(aceptacionValida({ version: ACUERDO_VERSION, checkbox: true, action: 'i_agree' })).toBe(true);
    expect(aceptacionValida({ version: ACUERDO_VERSION, checkbox: false, action: 'i_agree' })).toBe(false);
    expect(aceptacionValida({ version: ACUERDO_VERSION, checkbox: true, action: 'scroll' })).toBe(false);
    expect(aceptacionValida({ version: 'otra', checkbox: true, action: 'i_agree' })).toBe(false);
  });

  it('la copia incluye nombre, hora, versión y hash', () => {
    const texto = copiaFirmada({
      name: 'Ana Ruiz',
      email: 'ana@hotel.example',
      acceptedAt: '2026-10-12T16:00:00.000Z',
      version: ACUERDO_VERSION,
      sha256: ACUERDO_HASH,
    });
    expect(texto).toContain('Ana Ruiz');
    expect(texto).toContain('ana@hotel.example');
    expect(texto).toContain('2026-10-12T16:00:00.000Z');
    expect(texto).toContain(ACUERDO_VERSION);
    expect(texto).toContain(ACUERDO_HASH);
    expect(texto).toContain('I AGREE');
  });
});
