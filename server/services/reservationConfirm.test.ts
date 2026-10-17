import { afterEach, describe, expect, it } from 'vitest';
import {
  MINUTOS_PARA_CONFIRMAR, admiteRelevo, debeAlarmar, debePedirConfirmacion,
  horaLegible, motivoDeCierre, textoDeAlarma, type ReservaParaConfirmar,
} from './reservationConfirm';

const AHORA = Date.parse('2026-10-17T12:00:00Z');
const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();
const dentroDe = (min: number) => new Date(AHORA + min * 60_000).toISOString();

const reserva = (p: Partial<ReservaParaConfirmar> = {}): ReservaParaConfirmar => ({
  id: 'r1',
  driverId: 'd1',
  rideStatus: 'scheduled',
  scheduledAt: dentroDe(50),
  confirmRequestedAt: hace(MINUTOS_PARA_CONFIRMAR),
  confirmedAt: null,
  alarmAt: null,
  ...p,
});

afterEach(() => { delete process.env.RESERVATION_CONFIRM; });

describe('debePedirConfirmacion', () => {
  it('se pide una sola vez, y sólo si la reserva tiene chofer', () => {
    expect(debePedirConfirmacion(reserva({ confirmRequestedAt: null }))).toBe(true);
    expect(debePedirConfirmacion(reserva())).toBe(false);                               // ya se pidió
    expect(debePedirConfirmacion(reserva({ confirmRequestedAt: null, driverId: null }))).toBe(false);
  });

  it('no se pide en un viaje que ya empezó o se canceló', () => {
    expect(debePedirConfirmacion(reserva({ confirmRequestedAt: null, rideStatus: 'in_progress' }))).toBe(false);
    expect(debePedirConfirmacion(reserva({ confirmRequestedAt: null, rideStatus: 'cancelled' }))).toBe(false);
  });
});

describe('debeAlarmar', () => {
  it('salta al cumplirse el plazo sin respuesta', () => {
    expect(debeAlarmar(reserva(), AHORA)).toBe(true);
    expect(debeAlarmar(reserva({ confirmRequestedAt: hace(MINUTOS_PARA_CONFIRMAR - 1) }), AHORA)).toBe(false);
  });

  it('no salta si confirmó, si ya hay alarma o si nunca se le pidió', () => {
    expect(debeAlarmar(reserva({ confirmedAt: hace(1) }), AHORA)).toBe(false);
    expect(debeAlarmar(reserva({ alarmAt: hace(1) }), AHORA)).toBe(false);
    expect(debeAlarmar(reserva({ confirmRequestedAt: null }), AHORA)).toBe(false);
  });

  it('no salta sin chofer: de esa reserva se encarga el despacho', () => {
    expect(debeAlarmar(reserva({ driverId: null }), AHORA)).toBe(false);
  });

  it('pasada la hora del viaje ya no alarma: lo cubre el no-show', () => {
    expect(debeAlarmar(reserva({ scheduledAt: hace(5) }), AHORA)).toBe(false);
  });

  it('RESERVATION_CONFIRM=off lo apaga entero', () => {
    process.env.RESERVATION_CONFIRM = 'off';
    expect(debeAlarmar(reserva(), AHORA)).toBe(false);
    expect(debePedirConfirmacion(reserva({ confirmRequestedAt: null }))).toBe(false);
    expect(admiteRelevo(reserva({ alarmAt: hace(1) }))).toBe(false);
  });
});

describe('motivoDeCierre', () => {
  it('cierra cuando confirma, cuando la toma otro o cuando deja de estar pendiente', () => {
    expect(motivoDeCierre(reserva({ confirmedAt: hace(1) }), 'd1')).toBe('confirmada');
    expect(motivoDeCierre(reserva({ driverId: 'd2' }), 'd1')).toBe('otro-chofer');
    expect(motivoDeCierre(reserva({ rideStatus: 'cancelled' }), 'd1')).toBe('ya-no-espera');
    expect(motivoDeCierre(reserva({ rideStatus: 'in_progress' }), 'd1')).toBe('ya-no-espera');
  });

  it('sigue abierta mientras el mismo chofer no responde', () => {
    expect(motivoDeCierre(reserva(), 'd1')).toBeNull();
  });
});

describe('admiteRelevo', () => {
  it('otro chofer sólo puede tomarla mientras la alarma está abierta', () => {
    expect(admiteRelevo(reserva({ alarmAt: hace(1) }))).toBe(true);
    expect(admiteRelevo(reserva())).toBe(false);                                   // sin alarma, es suya
    expect(admiteRelevo(reserva({ alarmAt: hace(1), confirmedAt: hace(2) }))).toBe(false);
    expect(admiteRelevo(reserva({ alarmAt: hace(1), rideStatus: 'in_progress' }))).toBe(false);
  });
});

describe('textoDeAlarma', () => {
  it('lleva el teléfono, que es para lo que el dispatcher la lee', () => {
    const t = textoDeAlarma({ driverName: 'Paulo Estrada', driverPhone: '+13055550100', pickupAddress: 'MIA' });
    expect(t).toContain('Paulo Estrada');
    expect(t).toContain('+13055550100');
    expect(t).toContain('MIA');
  });

  it('lo dice cuando no hay teléfono, en vez de callarlo', () => {
    expect(textoDeAlarma({ driverName: 'Ana' })).toContain('Sin teléfono');
  });
});

describe('horaLegible', () => {
  it('da la hora de la ciudad, no el ISO en UTC', () => {
    // 21:30 UTC del 17 de octubre son las 5:30 p. m. en Miami.
    const t = horaLegible('2026-10-17T21:30:00.000Z');
    expect(t).toMatch(/05:30/);
    expect(t).not.toContain('T');
    expect(t).not.toContain('Z');
  });

  it('respeta otra zona horaria y aguanta una fecha inválida', () => {
    expect(horaLegible('2026-10-17T21:30:00.000Z', 'America/Bogota')).toMatch(/04:30/);
    expect(horaLegible(null)).toBeNull();
    expect(horaLegible('no es una fecha')).toBeNull();
  });

  it('la alarma muestra esa hora, no el ISO', () => {
    const t = textoDeAlarma({ driverName: 'Ana', scheduledAt: '2026-10-17T21:30:00.000Z' });
    expect(t).not.toContain('2026-10-17T21:30:00.000Z');
    expect(t).toMatch(/05:30/);
  });
});
