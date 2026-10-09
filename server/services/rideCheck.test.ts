import { describe, it, expect } from 'vitest';
import {
  evaluarChequeo,
  estadoVacio,
  paradaVencidaEnSilencio,
  distanciaMetros,
  mensaje,
  PARADA_MS,
  type EstadoChequeo,
  type PingChequeo,
} from './rideSafety';

const PICKUP = { lat: 25.7617, lng: -80.1918 };
const DROPOFF = { lat: 25.7907, lng: -80.1300 };
const AHORA = Date.parse('2026-10-09T18:00:00Z');

function ping(parcial: Partial<PingChequeo> & Pick<PingChequeo, 'at' | 'lat' | 'lng'>): PingChequeo {
  return {
    speedMps: 0,
    pickup: PICKUP,
    dropoff: DROPOFF,
    bloqueado: false,
    ...parcial,
  };
}

describe('RideCheck', () => {
  it('cinco minutos quieto en la ruta abre la parada larga', () => {
    const medio = { lat: 25.775, lng: -80.16 };
    let estado = estadoVacio();
    ({ estado } = evaluarChequeo(estado, ping({ at: AHORA, ...medio, speedMps: 0 })));
    const segundo = evaluarChequeo(estado, ping({ at: AHORA + PARADA_MS, ...medio, speedMps: 0 }));
    expect(segundo.anomalia).toBe('long_stop');
    expect(mensaje('long_stop').body).toContain('parada larga');
  });

  it('pararse junto al destino no es una parada inesperada', () => {
    let estado = estadoVacio();
    ({ estado } = evaluarChequeo(estado, ping({ at: AHORA, ...DROPOFF, speedMps: 0 })));
    const segundo = evaluarChequeo(estado, ping({ at: AHORA + PARADA_MS, ...DROPOFF, speedMps: 0 }));
    expect(segundo.anomalia).toBeNull();
  });

  it('si el GPS dice 0 pero el auto avanzó, no hay parada', () => {
    let estado: EstadoChequeo = estadoVacio();
    ({ estado } = evaluarChequeo(estado, ping({ at: AHORA, lat: 25.77, lng: -80.19, speedMps: 0 })));
    const segundo = evaluarChequeo(estado, ping({
      at: AHORA + 10_000, lat: 25.78, lng: -80.17, speedMps: 0,
    }));
    expect(segundo.anomalia).toBeNull();
    expect(segundo.estado.stoppedSince).toBeNull();
    expect(distanciaMetros(PICKUP, DROPOFF)).toBeGreaterThan(1000);
  });

  it('una caída fuerte de velocidad en pocos segundos es una frenada', () => {
    let estado = estadoVacio();
    ({ estado } = evaluarChequeo(estado, ping({ at: AHORA, lat: 25.77, lng: -80.18, speedMps: 20 })));
    const segundo = evaluarChequeo(estado, ping({ at: AHORA + 4_000, lat: 25.77002, lng: -80.18002, speedMps: 0 }));
    expect(segundo.anomalia).toBe('harsh_brake');
  });

  it('el sensor de frenada también abre el chequeo', () => {
    let estado = estadoVacio();
    ({ estado } = evaluarChequeo(estado, ping({ at: AHORA, lat: 25.77, lng: -80.18, speedMps: 12 })));
    const segundo = evaluarChequeo(estado, ping({
      at: AHORA + 2_000, lat: 25.771, lng: -80.179, speedMps: 9, harshBrake: true,
    }));
    expect(segundo.anomalia).toBe('harsh_brake');
  });

  it('irse muy lejos de la recta del viaje es una ruta desviada', () => {
    const lejos = { lat: 25.90, lng: -80.40 };
    const resultado = evaluarChequeo(estadoVacio(), ping({ at: AHORA, ...lejos, speedMps: 15 }));
    expect(resultado.anomalia).toBe('off_route');
  });

  it('con un chequeo abierto no dispara otro', () => {
    const medio = { lat: 25.775, lng: -80.16 };
    let estado = estadoVacio();
    ({ estado } = evaluarChequeo(estado, ping({ at: AHORA, ...medio, speedMps: 0 })));
    const segundo = evaluarChequeo(estado, ping({ at: AHORA + PARADA_MS, ...medio, speedMps: 0, bloqueado: true }));
    expect(segundo.anomalia).toBeNull();
  });

  it('el silencio después de quedarse quieto también vence la parada', () => {
    const estado: EstadoChequeo = {
      ...estadoVacio(),
      stoppedSince: AHORA,
      lastPingAt: AHORA,
      lastLat: 25.775,
      lastLng: -80.16,
      lastSpeedMps: 0,
    };
    expect(paradaVencidaEnSilencio(estado, DROPOFF, AHORA + PARADA_MS)).toBe(true);
    expect(paradaVencidaEnSilencio(estado, DROPOFF, AHORA + 30 * 60 * 1000)).toBe(false);
  });
});
