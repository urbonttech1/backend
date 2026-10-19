import { afterEach, describe, expect, it } from 'vitest';
import {
  EXENCION_TRAS_ACEPTAR_MINUTOS, PORCENTAJE, TRAMO_INMINENTE_MINUTOS,
  calcularPenalidad, descontarDeGanancia, penalizacionActiva, politicaDePenalidad, porcentajePenalidad,
  type CancelacionDeReserva,
} from './cancellationPenalty';

const AHORA = Date.parse('2026-10-18T12:00:00Z');
const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();
const dentroDe = (min: number) => new Date(AHORA + min * 60_000).toISOString();

/**
 * Una cancelación que ocurre `ahora`, aceptada hace `aceptadaHaceMin` y con el
 * servicio dentro de `faltanMin`. Por defecto, fuera del margen de exención.
 */
const cancelacion = (faltanMin: number, aceptadaHaceMin = 60): CancelacionDeReserva => ({
  aceptadaEn: hace(aceptadaHaceMin),
  canceladaEn: new Date(AHORA).toISOString(),
  servicioEn: dentroDe(faltanMin),
});

afterEach(() => { delete process.env.CANCELLATION_PENALTY; });

describe('los cinco ejemplos de la política, sobre una reserva de $100', () => {
  const sobre100 = (c: CancelacionDeReserva) => calcularPenalidad(c, 100).importe;

  it('dentro de los primeros 5 minutos: $0', () => {
    expect(sobre100(cancelacion(24 * 60, 2))).toBe(0);
  });

  it('pasados los 5 minutos y faltando más de 2 horas: $20', () => {
    expect(sobre100(cancelacion(3 * 60))).toBe(20);
  });

  it('faltando 2 horas: $40', () => {
    expect(sobre100(cancelacion(120))).toBe(40);
  });

  it('faltando 1 hora: $60', () => {
    expect(sobre100(cancelacion(60))).toBe(60);
  });

  it('faltando 30 minutos: $100', () => {
    expect(sobre100(cancelacion(30))).toBe(100);
  });
});

describe('los bordes exactos de cada tramo', () => {
  const pct = (faltanMin: number, aceptadaHaceMin?: number) =>
    porcentajePenalidad(cancelacion(faltanMin, aceptadaHaceMin)).porcentaje;

  it('2 h justas pagan el 40 %, y un minuto más el 20 %', () => {
    expect(pct(120)).toBe(PORCENTAJE.medio);
    expect(pct(121)).toBe(PORCENTAJE.holgado);
  });

  it('1 h justa paga el 60 %, y un minuto más el 40 %', () => {
    expect(pct(60)).toBe(PORCENTAJE.ajustado);
    expect(pct(61)).toBe(PORCENTAJE.medio);
  });

  // Las dos últimas filas de la tabla escrita se pisaban: este es el corte que
  // resuelve el solape, y el único sitio donde cambiarlo si se decide otro.
  it('30 min justos pagan el 100 %, y un minuto más el 60 %', () => {
    expect(pct(TRAMO_INMINENTE_MINUTOS)).toBe(PORCENTAJE.inminente);
    expect(pct(TRAMO_INMINENTE_MINUTOS + 1)).toBe(PORCENTAJE.ajustado);
  });

  it('el minuto 5 tras aceptar aún está exento; el 6 ya no', () => {
    expect(pct(24 * 60, EXENCION_TRAS_ACEPTAR_MINUTOS)).toBe(PORCENTAJE.exento);
    expect(pct(24 * 60, EXENCION_TRAS_ACEPTAR_MINUTOS + 1)).toBe(PORCENTAJE.holgado);
  });

  it('una reserva cuya hora ya pasó paga el 100 %', () => {
    expect(pct(-10)).toBe(PORCENTAJE.inminente);
  });
});

describe('la exención manda sobre el tiempo restante', () => {
  // Tal como pide la política. Deja fuera de cobro al que acepta una reserva
  // inminente y la suelta en seguida; está documentado en el módulo.
  it('soltar a los 2 minutos una reserva que empieza en 20 no cuesta nada', () => {
    const p = calcularPenalidad(cancelacion(20, 2), 100);
    expect(p.porcentaje).toBe(PORCENTAJE.exento);
    expect(p.importe).toBe(0);
    expect(p.motivo).toBe('exento_5_min');
  });
});

describe('el motivo que se guarda para el panel', () => {
  it('nombra el tramo que aplicó', () => {
    expect(porcentajePenalidad(cancelacion(24 * 60, 2)).motivo).toBe('exento_5_min');
    expect(porcentajePenalidad(cancelacion(180)).motivo).toBe('mas_de_2_h');
    expect(porcentajePenalidad(cancelacion(90)).motivo).toBe('entre_1_y_2_h');
    expect(porcentajePenalidad(cancelacion(45)).motivo).toBe('menos_de_1_h');
    expect(porcentajePenalidad(cancelacion(10)).motivo).toBe('menos_de_30_min');
  });

  it('informa del tiempo restante y del transcurrido, para el historial', () => {
    const p = porcentajePenalidad(cancelacion(45, 30));
    expect(p.minutosHastaServicio).toBe(45);
    expect(p.minutosDesdeAceptacion).toBe(30);
  });
});

describe('datos que no se pueden usar no cobran', () => {
  it('sin fecha de aceptación, de cancelación o de servicio', () => {
    const roto = [
      { ...cancelacion(45), aceptadaEn: null },
      { ...cancelacion(45), canceladaEn: null },
      { ...cancelacion(45), servicioEn: null },
      { ...cancelacion(45), aceptadaEn: 'no es una fecha' },
    ];
    for (const c of roto) {
      const p = calcularPenalidad(c, 100);
      expect(p.importe).toBe(0);
      expect(p.motivo).toBe('sin_datos');
      expect(p.minutosHastaServicio).toBeNull();
    }
  });

  it('una cancelación anterior a la aceptación es un dato roto, no una exención', () => {
    const p = porcentajePenalidad({
      aceptadaEn: new Date(AHORA).toISOString(),
      canceladaEn: hace(10),
      servicioEn: dentroDe(45),
    });
    expect(p.porcentaje).toBe(0);
    expect(p.motivo).toBe('sin_datos');
  });
});

describe('el importe sobre el valor de la reserva', () => {
  it('redondea a dos decimales', () => {
    expect(calcularPenalidad(cancelacion(90), 33.33).importe).toBe(13.33);
  });

  it('acepta el número en texto, como llega de la base', () => {
    expect(calcularPenalidad(cancelacion(90), '250.00').importe).toBe(100);
  });

  it('un valor ausente o absurdo deja el importe en cero pero conserva el tramo', () => {
    for (const v of [null, undefined, 0, -10, 'nada']) {
      const p = calcularPenalidad(cancelacion(90), v as never);
      expect(p.importe).toBe(0);
      expect(p.porcentaje).toBe(PORCENTAJE.medio);
    }
  });
});

describe('interruptor de despliegue', () => {
  it('viene encendida y sólo CANCELLATION_PENALTY=off la apaga', () => {
    expect(penalizacionActiva({})).toBe(true);
    expect(penalizacionActiva({ CANCELLATION_PENALTY: 'OFF' })).toBe(false);
    expect(penalizacionActiva({ CANCELLATION_PENALTY: 'on' })).toBe(true);
  });
});

describe('descuento de lo que el chofer gana', () => {
  const deuda = (id: string, amount: number) => ({ id, amount });

  it('salda las deudas que caben, de la más vieja a la más nueva', () => {
    const r = descontarDeGanancia(10_000, [deuda('a', 20), deuda('b', 40)]);
    expect(r.idsSaldados).toEqual(['a', 'b']);
    expect(r.descuentoCentavos).toBe(6_000);
    expect(r.gananciaFinalCentavos).toBe(4_000);
  });

  it('una deuda que no cabe se salta, pero las siguientes que quepan sí se cobran', () => {
    const r = descontarDeGanancia(5_000, [deuda('cara', 100), deuda('barata', 20)]);
    expect(r.idsSaldados).toEqual(['barata']);
    expect(r.gananciaFinalCentavos).toBe(3_000);
  });

  it('nunca deja la ganancia en negativo', () => {
    const r = descontarDeGanancia(1_000, [deuda('a', 60), deuda('b', 60)]);
    expect(r.gananciaFinalCentavos).toBeGreaterThanOrEqual(0);
    expect(r.idsSaldados).toEqual([]);
    expect(r.descuentoCentavos).toBe(0);
  });

  it('sin deudas no toca nada', () => {
    const r = descontarDeGanancia(7_500, []);
    expect(r).toEqual({ descuentoCentavos: 0, gananciaFinalCentavos: 7_500, idsSaldados: [] });
  });

  it('una ganancia nula o negativa no cobra nada', () => {
    for (const g of [0, -500, NaN]) {
      const r = descontarDeGanancia(g, [deuda('a', 20)]);
      expect(r.descuentoCentavos).toBe(0);
      expect(r.idsSaldados).toEqual([]);
    }
  });

  it('una deuda de importe cero o absurdo se ignora sin saldarse', () => {
    const r = descontarDeGanancia(5_000, [deuda('cero', 0), deuda('negativa', -10), deuda('buena', 10)]);
    expect(r.idsSaldados).toEqual(['buena']);
    expect(r.descuentoCentavos).toBe(1_000);
  });

  it('una deuda que cabe justa la deja a cero', () => {
    const r = descontarDeGanancia(2_000, [deuda('a', 20)]);
    expect(r.gananciaFinalCentavos).toBe(0);
    expect(r.idsSaldados).toEqual(['a']);
  });
});

describe('la política que se publica a la app', () => {
  it('va ordenada de más margen a menos, y termina en el 100 %', () => {
    const { tramos, exencionMinutos } = politicaDePenalidad();
    expect(exencionMinutos).toBe(EXENCION_TRAS_ACEPTAR_MINUTOS);
    expect(tramos.map(t => t.desdeMinutos)).toEqual([...tramos.map(t => t.desdeMinutos)].sort((a, b) => b - a));
    expect(tramos.at(-1)).toEqual({ desdeMinutos: 0, porcentaje: PORCENTAJE.inminente });
  });

  it('cada tramo coincide con lo que cobra el cálculo', () => {
    for (const t of politicaDePenalidad().tramos) {
      expect(porcentajePenalidad(cancelacion(t.desdeMinutos + 1)).porcentaje).toBe(t.porcentaje);
    }
  });
});
