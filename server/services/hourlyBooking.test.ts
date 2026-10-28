import { describe, it, expect } from 'vitest';
import { DEFAULT_FARE_CLASSES, type FareClass } from '../config/pricing';
import {
  calcularExtras, evaluarPunto, haversineMetros, inicioDelReloj, leerTerminos,
  terminosDeReserva, usoEnVivo, validarHoras, vistaPorHora, METROS_POR_MILLA,
  type FilaPorHora, type TerminosPorHora,
} from './hourlyBooking';

// El ejemplo del cliente: sedan a $30/h, 25 mi por hora y $2 la milla extra.
const sedan: FareClass = { ...DEFAULT_FARE_CLASSES.sedan, perHour: 30, milesPerHour: 25, extraMileFee: 2, minHours: 2, maxHours: 12 };
const tresHoras: TerminosPorHora = terminosDeReserva(sedan, 3);
const MIN = 60_000;
const millas = (n: number) => n * METROS_POR_MILLA;

describe('calcularExtras', () => {
  it('el caso del cliente: 3 h, 82 mi → 7 millas extra, $14', () => {
    const e = calcularExtras(tresHoras, { elapsedMs: 3 * 60 * MIN, meters: millas(82) });
    expect(e).toMatchObject({
      included_miles: 75, miles_used: 82, extra_miles: 7, extra_miles_charge: 14,
      overtime_minutes: 0, overtime_charge: 0, extras_subtotal: 14,
    });
  });

  it('las millas se cobran completas y hacia abajo', () => {
    const e = calcularExtras(tresHoras, { elapsedMs: 3 * 60 * MIN, meters: millas(82.9) });
    expect(e.miles_measured).toBe(82.9);
    expect(e.miles_used).toBe(82);
    expect(e.extra_miles).toBe(7);
  });

  it('sin pasar de las incluidas no hay cargo por millas', () => {
    expect(calcularExtras(tresHoras, { elapsedMs: 60 * MIN, meters: millas(40) }).extra_miles_charge).toBe(0);
  });

  it('hasta 5 minutos de exceso son de cortesía', () => {
    const e = calcularExtras(tresHoras, { elapsedMs: (180 + 5) * MIN, meters: 0 });
    expect(e.overtime_minutes).toBe(5);
    expect(e.overtime_increments).toBe(0);
    expect(e.overtime_charge).toBe(0);
  });

  it('desde el minuto 6 cuenta cada bloque de 15 empezado', () => {
    // 5 min y 1 s de exceso son 6 minutos empezados.
    const e = calcularExtras(tresHoras, { elapsedMs: (185 * MIN) + 1000, meters: 0 });
    expect(e.overtime_minutes).toBe(6);
    expect(e.overtime_increments).toBe(1);
    expect(e.overtime_charge).toBe(7.5);
  });

  it('3 h 10 min con 82 mi: $7.50 de tiempo y $14 de millas', () => {
    const e = calcularExtras(tresHoras, { elapsedMs: 190 * MIN, meters: millas(82.6) });
    expect(e).toMatchObject({ overtime_increments: 1, overtime_charge: 7.5, extra_miles_charge: 14, extras_subtotal: 21.5 });
  });

  it('16 minutos de exceso son dos bloques', () => {
    expect(calcularExtras(tresHoras, { elapsedMs: 196 * MIN, meters: 0 }).overtime_increments).toBe(2);
  });

  it('el recargo de la reserva sube la hora extra, no la milla', () => {
    const conRecargo = terminosDeReserva(sedan, 3, 1.5);
    const e = calcularExtras(conRecargo, { elapsedMs: 190 * MIN, meters: millas(80) });
    expect(e.overtime_charge).toBe(11.25);
    expect(e.extra_miles_charge).toBe(10);
  });

  it('el tiempo extra no agranda las millas incluidas', () => {
    expect(calcularExtras(tresHoras, { elapsedMs: 240 * MIN, meters: 0 }).included_miles).toBe(75);
  });
});

describe('validarHoras', () => {
  it('acepta horas enteras dentro del rango de la clase', () => {
    expect(validarHoras(sedan, 3)).toEqual({ ok: true, hours: 3 });
    expect(validarHoras(sedan, '12')).toEqual({ ok: true, hours: 12 });
  });

  it('rechaza fuera de rango o con decimales, y dice el rango', () => {
    for (const h of [1, 13, 2.5, 'tres', null]) {
      expect(validarHoras(sedan, h)).toEqual({ ok: false, errorCode: 'HOURS_OUT_OF_RANGE', minHours: 2, maxHours: 12 });
    }
  });

  it('una clase sin reserva por hora no se puede reservar', () => {
    expect(validarHoras({ ...sedan, hourlyEnabled: false }, 3)).toMatchObject({ ok: false, errorCode: 'HOURLY_DISABLED' });
  });
});

describe('inicioDelReloj', () => {
  const reserva = '2026-11-02T14:00:00.000Z';
  const t = (hhmm: string) => `2026-11-02T${hhmm}:00.000Z`;

  it('empieza a la hora reservada aunque el pasajero tarde en subir', () => {
    expect(inicioDelReloj({ scheduledAt: reserva, arrivedAt: t('13:50'), startedAt: t('14:20') })).toBe(Date.parse(reserva));
  });

  it('si el chofer llegó tarde, empieza cuando llegó', () => {
    expect(inicioDelReloj({ scheduledAt: reserva, arrivedAt: t('14:15'), startedAt: t('14:18') })).toBe(Date.parse(t('14:15')));
  });

  it('si el pasajero sube antes de la hora, empieza al subir', () => {
    expect(inicioDelReloj({ scheduledAt: reserva, arrivedAt: t('13:40'), startedAt: t('13:45') })).toBe(Date.parse(t('13:45')));
  });

  it('sin subir no hay reloj', () => {
    expect(inicioDelReloj({ scheduledAt: reserva, arrivedAt: t('13:50'), startedAt: null })).toBeNull();
  });
});

describe('evaluarPunto', () => {
  const base = { lat: 25.7617, lng: -80.1918, at: 1_000_000 };
  // ~0.001° de latitud son ~111 m.
  const norte = (grados: number, segundos: number, accuracy?: number) =>
    ({ lat: base.lat + grados, lng: base.lng, at: base.at + segundos * 1000, accuracy });

  it('el primero sólo fija la posición', () => {
    expect(evaluarPunto(null, norte(0, 0))).toEqual({ accion: 'primero' });
  });

  it('suma la distancia entre dos puntos buenos', () => {
    const d = evaluarPunto(base, norte(0.001, 10));
    expect(d.accion).toBe('sumar');
    if (d.accion === 'sumar') expect(d.metros).toBeCloseTo(111, 0);
  });

  it('descarta un punto impreciso', () => {
    expect(evaluarPunto(base, norte(0.001, 10, 80))).toEqual({ accion: 'descartar', motivo: 'precision' });
  });

  it('el ruido de un coche parado no suma', () => {
    expect(evaluarPunto(base, norte(0.00005, 3))).toEqual({ accion: 'esperar' });
  });

  it('un salto imposible se descarta', () => {
    // 11 km en 3 s.
    expect(evaluarPunto(base, norte(0.1, 3))).toEqual({ accion: 'descartar', motivo: 'salto' });
  });

  it('un punto anterior al último no cuenta', () => {
    expect(evaluarPunto(base, norte(0.001, -5))).toEqual({ accion: 'descartar', motivo: 'viejo' });
  });

  it('tras un hueco largo suma en línea recta y marca la medición', () => {
    const d = evaluarPunto(base, norte(0.05, 15 * 60));
    expect(d).toMatchObject({ accion: 'sumar', degradado: true });
  });
});

describe('leerTerminos', () => {
  it('lee lo congelado, venga como objeto o como texto', () => {
    expect(leerTerminos(tresHoras)).toEqual(tresHoras);
    expect(leerTerminos(JSON.stringify(tresHoras))).toEqual(tresHoras);
  });
  it('descarta lo que no sirve para cobrar', () => {
    expect(leerTerminos(null)).toBeNull();
    expect(leerTerminos({ booked_hours: 0, per_hour: 30 })).toBeNull();
    expect(leerTerminos('{roto')).toBeNull();
  });
});

describe('vistaPorHora y usoEnVivo', () => {
  const fila = (cambios: Partial<FilaPorHora>): FilaPorHora => ({
    ride_status: 'in_progress', scheduled_at: '2026-11-02T14:00:00.000Z', wait_started_at: '2026-11-02T13:55:00.000Z',
    started_at: '2026-11-02T14:02:00.000Z', completed_at: null, meters: millas(61.4), degraded: false,
    hourly_extras: null, hourly_extras_status: null, ...cambios,
  });
  const ahora = Date.parse('2026-11-02T16:12:00.000Z');

  it('en curso mide hasta ahora', () => {
    const u = usoEnVivo('r1', tresHoras, fila({}), ahora);
    expect(u).toMatchObject({
      starts_at: '2026-11-02T14:00:00.000Z', ends_at: '2026-11-02T17:00:00.000Z',
      elapsed_minutes: 132, remaining_minutes: 48, miles_used: 61.4, remaining_miles: 13.6,
      estimated_extras: 0, gps_quality: 'good',
    });
  });

  it('antes de empezar sólo trae las condiciones', () => {
    const v = vistaPorHora(tresHoras, fila({ ride_status: 'scheduled', started_at: null, meters: null }), ahora);
    expect(v).toMatchObject({ included_miles: 75, overtime_increment_price: 7.5, starts_at: null, miles_used: null });
  });

  it('terminado, sale de lo que se cobró', () => {
    const resumen = { ...calcularExtras(tresHoras, { elapsedMs: 190 * MIN, meters: millas(82) }),
      starts_at: '2026-11-02T14:00:00.000Z', ended_at: '2026-11-02T17:10:00.000Z',
      extras_tax: 1.31, extras_total: 22.81, gps_quality: 'good', driver_share: 18.28 };
    const v = vistaPorHora(tresHoras, fila({ ride_status: 'completed', hourly_extras: resumen, hourly_extras_status: 'charged' }), ahora);
    expect(v).toMatchObject({ extras_total: 22.81, extras_status: 'charged', extra_miles: 7, ends_at: '2026-11-02T17:00:00.000Z' });
  });
});

describe('haversineMetros', () => {
  it('una milla al norte mide una milla', () => {
    const a = { lat: 25.7617, lng: -80.1918 };
    const b = { lat: a.lat + METROS_POR_MILLA / 111_195, lng: a.lng };
    expect(haversineMetros(a, b)).toBeCloseTo(METROS_POR_MILLA, -1);
  });
});
