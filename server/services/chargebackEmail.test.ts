import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/client', () => ({ supabaseAdmin: {} }));

import { correoContracargoHtml, avisosContracargoActivos, type DatosContracargo } from './chargebackEmail';

const base: DatosContracargo = {
  disputeId: 'dp_1',
  amountUsd: 40.47,
  motivo: 'fraudulent',
  estado: 'needs_response',
  rideId: '9f8c1a2b-0000-0000-0000-000000000000',
  abierto: true,
  dueBy: new Date('2026-11-04T00:00:00Z'),
};

describe('avisosContracargoActivos', () => {
  it('activo salvo CHARGEBACK_ALERTS=off', () => {
    expect(avisosContracargoActivos({} as NodeJS.ProcessEnv)).toBe(true);
    expect(avisosContracargoActivos({ CHARGEBACK_ALERTS: 'off' } as NodeJS.ProcessEnv)).toBe(false);
    expect(avisosContracargoActivos({ CHARGEBACK_ALERTS: 'OFF' } as NodeJS.ProcessEnv)).toBe(false);
    expect(avisosContracargoActivos({ CHARGEBACK_ALERTS: 'on' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('correoContracargoHtml', () => {
  it('una disputa abierta trae importe, motivo en castellano y plazo', () => {
    const html = correoContracargoHtml(base);
    expect(html).toContain('$40.47');
    expect(html).toContain('Fraude');
    expect(html).toContain('9F8C1A2B');
    expect(html).toContain('Requiere respuesta');
    expect(html).toMatch(/noviembre/);
  });

  it('dice que al chofer no se le ha tocado el dinero', () => {
    expect(correoContracargoHtml(base)).toContain('no se le ha descontado nada');
  });

  it('una disputa cerrada muestra el desenlace y no pide responder', () => {
    const html = correoContracargoHtml({ ...base, abierto: false, estado: 'lost', dueBy: null });
    expect(html).toContain('Perdida');
    expect(html).toContain('Disputa cerrada');
    expect(html).not.toContain('Responder antes de');
  });

  it('una disputa ganada se ve como ganada', () => {
    expect(correoContracargoHtml({ ...base, abierto: false, estado: 'won' })).toContain('Ganada');
  });

  it('sin viaje identificado lo dice en vez de callarlo', () => {
    const html = correoContracargoHtml({ ...base, rideId: null });
    expect(html).toContain('Sin identificar');
  });

  it('escapa lo que viene de fuera', () => {
    const html = correoContracargoHtml({ ...base, disputeId: '<script>x</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('un motivo que Stripe invente después se ve crudo, no desaparece', () => {
    expect(correoContracargoHtml({ ...base, motivo: 'motivo_nuevo' })).toContain('motivo_nuevo');
  });
});
