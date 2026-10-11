import { describe, it, expect } from 'vitest';
import { cuentaEliminadaHtml, enviarAvisoCuentaEliminada, vencimientoDocumentoHtml } from './accountEmails';

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

describe('cuentaEliminadaHtml', () => {
  it('avisa de la eliminación y de que el correo queda libre', () => {
    const html = cuentaEliminadaHtml(chofer, false);
    expect(html).toContain('Hola Ana Pérez,');
    expect(html).toContain('<strong>eliminada</strong>');
    expect(html).toContain('Borramos tus datos personales');
    expect(html).toContain('puedes crear una cuenta nueva');
  });

  it('el definitivo dice que la cuenta deja de existir', () => {
    expect(cuentaEliminadaHtml(chofer, true)).toContain('Eliminamos tu cuenta y los datos asociados');
  });

  it('sin nombre saluda sin nombre', () => {
    expect(cuentaEliminadaHtml({ email: 'x@example.com', name: '' }, true)).toContain('Hola,');
  });

  it('sin correo no envía y lo dice', async () => {
    const r = await enviarAvisoCuentaEliminada({ email: null, name: 'Ana' }, true);
    expect(r).toMatchObject({ sent: false, reason: 'NO_EMAIL' });
  });
});
