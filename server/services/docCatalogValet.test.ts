import { describe, it, expect } from 'vitest';
import { VALET_DOC_KEYS, esRolValet, ESQUEMA_GLOBAL } from './docCatalog';

describe('esRolValet', () => {
  it('reconoce los dos roles que atienden desde un local', () => {
    expect(esRolValet('valet')).toBe(true);
    expect(esRolValet('concierge')).toBe(true);
  });

  it('no confunde al conductor ni al pasajero', () => {
    expect(esRolValet('chauffeur')).toBe(false);
    expect(esRolValet('driver')).toBe(false);
    expect(esRolValet('passenger')).toBe(false);
    expect(esRolValet(null)).toBe(false);
    expect(esRolValet(undefined)).toBe(false);
  });
});

describe('VALET_DOC_KEYS', () => {
  it('pide solo identidad: un documento oficial y una foto', () => {
    expect([...VALET_DOC_KEYS]).toEqual(['license', 'photo']);
  });

  // Si alguna clave no estuviera en el catálogo, el valet no podria subirla:
  // `POST /api/driver/documents` valida contra esa lista.
  it('usa claves que ya existen en el esquema global', () => {
    for (const k of VALET_DOC_KEYS) {
      expect(ESQUEMA_GLOBAL).toContain(k);
    }
  });

  it('deja fuera lo que es del vehículo, que el valet no tiene', () => {
    for (const k of ['registration', 'insurance', 'inspection', 'limoPermit', 'airportPermit']) {
      expect(VALET_DOC_KEYS as readonly string[]).not.toContain(k);
    }
  });
});
