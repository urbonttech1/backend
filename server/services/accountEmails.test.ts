import { describe, it, expect } from 'vitest';
import { vencimientoDocumentoHtml } from './accountEmails';

const chofer = { email: 'chofer@example.com', name: 'Ana Pérez' };

describe('vencimientoDocumentoHtml', () => {
  it('nombra el documento y la fecha sin correrla un día por la zona horaria', () => {
    const html = vencimientoDocumentoHtml(chofer, "Driver's License", '2026-11-05', '30d');
    expect(html).toContain("Driver's License");
    expect(html).toContain('5 de noviembre de 2026');
    expect(html).toContain('Hola Ana Pérez,');
  });

  it('a 7 y 15 días advierte de la suspensión', () => {
    expect(vencimientoDocumentoHtml(chofer, 'Auto Insurance', '2026-10-13', '7d')).toContain('se suspenderá');
    expect(vencimientoDocumentoHtml(chofer, 'Auto Insurance', '2026-10-21', '15d')).toContain('se suspenderá');
  });

  it('vencido dice que la cuenta quedó suspendida', () => {
    expect(vencimientoDocumentoHtml(chofer, 'Auto Insurance', '2026-10-06', 'vencido')).toContain('suspendida temporalmente');
  });
});
