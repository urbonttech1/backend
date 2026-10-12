import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/client', () => ({ supabaseAdmin: {} }));

import { correoLimpiezaHtml, correosLimpiezaActivos } from './cleaningEmails';

const datos = { amountUsd: 30, label: 'Beach sand', rideId: '27113c83-e238-48b5-8607-654779b58a05' };

describe('correoLimpiezaHtml', () => {
  it('reportado: dice que no se ha cobrado y queda en revisión', () => {
    const html = correoLimpiezaHtml('Ana', 'submitted', datos);
    expect(html).toContain('$30.00 beach sand');
    expect(html).toContain('Nothing has been charged');
    expect(html).toContain('27113C83');
  });

  it('reportado con limpieza profesional: menciona el recibo', () => {
    expect(correoLimpiezaHtml(null, 'submitted', { ...datos, awaitingReceipt: true })).toContain('cleaning receipt');
  });

  it('cobrado y rechazado', () => {
    expect(correoLimpiezaHtml('Ana', 'charged', datos)).toContain('Charged');
    expect(correoLimpiezaHtml('Ana', 'rejected', datos)).toContain('did not apply it');
  });

  it('escapa el nombre del pasajero', () => {
    expect(correoLimpiezaHtml('<b>x</b>', 'charged', datos)).not.toContain('<b>x</b>');
  });
});

describe('correosLimpiezaActivos', () => {
  it('encendidos por defecto y apagables con CLEANING_EMAILS=off', () => {
    expect(correosLimpiezaActivos({} as NodeJS.ProcessEnv)).toBe(true);
    expect(correosLimpiezaActivos({ CLEANING_EMAILS: 'off' } as NodeJS.ProcessEnv)).toBe(false);
  });
});
