import { describe, it, expect } from 'vitest';
import {
  segundosRestantes,
  ventanaAbierta,
  venceRecibo,
  estadoAlEnviar,
  normalizarSitio,
  nombreEmpresaValido,
  puedeAdjuntarRecibo,
  VENTANA_MS,
  RECIBO_MS,
  MOTIVOS,
} from './cleaningCharge';

const CIERRE = new Date('2026-10-09T15:00:00.000Z');

describe('cargo de limpieza — plazos e importes', () => {
  it('los importes quedan fijos en dólares', () => {
    expect(MOTIVOS.beach_sand.amountUsd).toBe(30);
    expect(MOTIVOS.vomit.amountUsd).toBe(200);
    expect(MOTIVOS.vomit.needsReceipt).toBe(true);
  });

  it('la ventana de fotos dura 2 horas desde el cierre del viaje', () => {
    const enCasa = new Date(CIERRE.getTime() + 30 * 60 * 1000);
    const dentro = new Date(CIERRE.getTime() + VENTANA_MS - 60 * 1000);
    expect(ventanaAbierta(CIERRE, enCasa)).toBe(true);
    const justo = new Date(CIERRE.getTime() + VENTANA_MS);
    const fuera = new Date(CIERRE.getTime() + VENTANA_MS + 1);
    expect(ventanaAbierta(CIERRE, dentro)).toBe(true);
    expect(segundosRestantes(CIERRE, dentro)).toBe(60);
    expect(ventanaAbierta(CIERRE, justo)).toBe(false);
    expect(ventanaAbierta(CIERRE, fuera)).toBe(false);
    expect(segundosRestantes(CIERRE, fuera)).toBe(0);
  });

  it('el vómito espera recibo; la arena pasa directo a revisión', () => {
    expect(estadoAlEnviar('vomit')).toBe('awaiting_receipt');
    expect(estadoAlEnviar('beach_sand')).toBe('pending_review');
  });

  it('el recibo vence 72 horas después del cierre', () => {
    expect(venceRecibo(CIERRE).toISOString()).toBe(new Date(CIERRE.getTime() + RECIBO_MS).toISOString());
  });

  it('acepta un sitio web con o sin esquema y rechaza texto suelto', () => {
    expect(normalizarSitio('cleanmiami.com')).toBe('https://cleanmiami.com/');
    expect(normalizarSitio('https://clean.example/prices')).toBe('https://clean.example/prices');
    expect(normalizarSitio('no es una url')).toBeNull();
    expect(normalizarSitio('localhost')).toBeNull();
    expect(normalizarSitio('')).toBeNull();
  });

  it('el nombre de la empresa no puede ir vacío ni ser un párrafo', () => {
    expect(nombreEmpresaValido('  Clean   Miami ')).toBe('Clean Miami');
    expect(nombreEmpresaValido('a')).toBeNull();
    expect(nombreEmpresaValido('')).toBeNull();
  });

  it('el recibo sólo entra mientras el caso lo espera y no venció', () => {
    const vence = venceRecibo(CIERRE);
    expect(puedeAdjuntarRecibo('awaiting_receipt', vence, new Date(vence.getTime() - 1000))).toBe(true);
    expect(puedeAdjuntarRecibo('awaiting_receipt', vence, new Date(vence.getTime() + 1000))).toBe(false);
    expect(puedeAdjuntarRecibo('pending_review', vence, CIERRE)).toBe(false);
  });
});
