import { describe, it, expect } from 'vitest';
import { companiaCompleta, faltantesCompania, type CompaniaValet } from './valetCompany';

const completa: CompaniaValet = {
  legalName: 'Palm Court Valet LLC',
  tradeName: 'Palm Court',
  entityType: 'llc',
  address: '100 Ocean Dr, Miami, FL',
  phone: '3055550100',
  email: 'desk@palmcourt.example',
  authorizedRep: 'Ana Ruiz',
};

describe('compañía del valet', () => {
  it('exige los datos de la compañía y deja opcional al representante', () => {
    expect(companiaCompleta(completa)).toBe(true);
    expect(companiaCompleta({ ...completa, authorizedRep: '' })).toBe(true);
  });

  it('rechaza un tipo de empresa desconocido y un correo inválido', () => {
    expect(faltantesCompania({ ...completa, entityType: 'hotel', email: 'no' })).toEqual(['entityType', 'email']);
  });
});
