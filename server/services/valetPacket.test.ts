import { describe, it, expect } from 'vitest';
import { estadoW9, expediente, faltantesActivacion } from './valetPacket';

describe('expediente del valet', () => {
  it('distingue recibido, en revisión y aprobado', () => {
    expect(estadoW9(null)).toBe('missing');
    expect(estadoW9('rejected')).toBe('missing');
    expect(estadoW9('received')).toBe('received');
    expect(estadoW9('pending_review')).toBe('pending_review');
    expect(estadoW9('approved')).toBe('approved');
  });

  it('no deja el expediente listo sin compañía, acuerdo o W-9', () => {
    expect(expediente({ company: true, agreement: 'accepted', w9: 'received' })).toBe('ready');
    expect(expediente({ company: false, agreement: 'accepted', w9: 'approved' })).toBe('pending_documentation');
    expect(expediente({ company: true, agreement: 'pending', w9: 'received' })).toBe('pending_documentation');
    expect(expediente({ company: true, agreement: 'accepted', w9: 'missing' })).toBe('pending_documentation');
  });

  it('activar exige el paquete aunque el W-9 todavía no esté aprobado', () => {
    expect(faltantesActivacion({ company: true, agreement: 'accepted', w9: 'received' })).toEqual([]);
    expect(faltantesActivacion({ company: false, agreement: 'pending', w9: 'missing' })).toEqual([
      'Company information',
      'Independent Valet Participation Agreement',
      'IRS Form W-9',
    ]);
  });
});
