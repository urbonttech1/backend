import { describe, it, expect } from 'vitest';
import { tasaDeCancelacion, tasaDeAceptacion, valoracionMedia } from './driverPerformance';

const asignado = (id: string, created_at: string, rating: number | null = null) => ({ id, created_at, rating });
const evento = (ride_id: string, event: string, created_at: string) => ({ ride_id, event, created_at });

describe('tasaDeCancelacion', () => {
  it('es null si el conductor todavía no aceptó ningún viaje', () => {
    expect(tasaDeCancelacion([], [])).toBeNull();
  });

  it('es 0 si aceptó viajes y no canceló ninguno', () => {
    const asignados = [asignado('a', '2026-09-01T10:00:00Z'), asignado('b', '2026-09-02T10:00:00Z')];
    expect(tasaDeCancelacion(asignados, [])).toBe(0);
  });

  it('cuenta los viajes cancelados antes de empezar, que ya no figuran a su nombre en rides', () => {
    // 3 que conserva + 1 que soltó = 4 aceptados, 1 cancelado.
    const asignados = [
      asignado('a', '2026-09-01T10:00:00Z'),
      asignado('b', '2026-09-02T10:00:00Z'),
      asignado('c', '2026-09-03T10:00:00Z'),
    ];
    const eventos = [evento('d', 'driver_cancelled', '2026-09-04T10:00:00Z')];
    expect(tasaDeCancelacion(asignados, eventos)).toBe(25);
  });

  it('no cuenta dos veces el viaje abandonado en curso, que está en las dos listas', () => {
    const asignados = [asignado('a', '2026-09-01T10:00:00Z'), asignado('b', '2026-09-02T10:00:00Z')];
    const eventos = [evento('a', 'driver_cancelled', '2026-09-01T10:30:00Z')];
    expect(tasaDeCancelacion(asignados, eventos)).toBe(50);
  });

  it('una reasignación del sistema suma como aceptado, pero no como cancelación', () => {
    const asignados = [asignado('a', '2026-09-01T10:00:00Z')];
    const eventos = [evento('b', 'reassigned', '2026-09-02T10:00:00Z')];
    expect(tasaDeCancelacion(asignados, eventos)).toBe(0);
  });

  it('un rechazo no cuenta como viaje aceptado', () => {
    // Aceptados: a y b (cancelado). El rechazo de c no entra: 1 de 2, no 1 de 3.
    const asignados = [asignado('a', '2026-09-01T10:00:00Z')];
    const eventos = [
      evento('b', 'driver_cancelled', '2026-09-02T10:00:00Z'),
      evento('c', 'rejected', '2026-09-03T10:00:00Z'),
    ];
    expect(tasaDeCancelacion(asignados, eventos)).toBe(50);
  });

  it('sólo mira los viajes más recientes de la ventana', () => {
    // El cancelado es el más antiguo: queda fuera de una ventana de 2.
    const asignados = [asignado('b', '2026-09-02T10:00:00Z'), asignado('c', '2026-09-03T10:00:00Z')];
    const eventos = [evento('a', 'driver_cancelled', '2026-09-01T10:00:00Z')];
    expect(tasaDeCancelacion(asignados, eventos, 2)).toBe(0);
    expect(tasaDeCancelacion(asignados, eventos, 3)).toBe(33);
  });
});

describe('tasaDeAceptacion', () => {
  it('es null si el conductor todavía no aceptó ni rechazó nada', () => {
    expect(tasaDeAceptacion([], [])).toBeNull();
  });

  it('es 100 si aceptó y nunca rechazó', () => {
    const asignados = [asignado('a', '2026-09-01T10:00:00Z'), asignado('b', '2026-09-02T10:00:00Z')];
    expect(tasaDeAceptacion(asignados, [])).toBe(100);
  });

  it('divide las aceptadas entre las aceptadas más las rechazadas', () => {
    const asignados = [asignado('a', '2026-09-01T10:00:00Z')];
    const eventos = [
      evento('b', 'rejected', '2026-09-02T10:00:00Z'),
      evento('c', 'rejected', '2026-09-03T10:00:00Z'),
    ];
    expect(tasaDeAceptacion(asignados, eventos)).toBe(33);
  });

  it('un viaje que aceptó y después canceló sigue contando como aceptado', () => {
    const eventos = [
      evento('x', 'driver_cancelled', '2026-09-01T10:00:00Z'),
      evento('y', 'rejected', '2026-09-02T10:00:00Z'),
    ];
    expect(tasaDeAceptacion([], eventos)).toBe(50);
  });

  it('un viaje rechazado y aceptado más tarde cuenta como aceptado', () => {
    const asignados = [asignado('a', '2026-09-02T10:00:00Z')];
    const eventos = [evento('a', 'rejected', '2026-09-01T10:00:00Z')];
    expect(tasaDeAceptacion(asignados, eventos)).toBe(100);
  });

  it('sólo mira las decisiones más recientes de la ventana', () => {
    // El rechazo es lo más antiguo: queda fuera de una ventana de 1.
    const asignados = [asignado('b', '2026-09-02T10:00:00Z')];
    const eventos = [evento('a', 'rejected', '2026-09-01T10:00:00Z')];
    expect(tasaDeAceptacion(asignados, eventos, 1)).toBe(100);
    expect(tasaDeAceptacion(asignados, eventos, 2)).toBe(50);
  });
});

describe('valoracionMedia', () => {
  it('es null si ningún pasajero valoró todavía', () => {
    expect(valoracionMedia([asignado('a', '2026-09-01T10:00:00Z')])).toBeNull();
    expect(valoracionMedia([])).toBeNull();
  });

  it('promedia sólo los viajes valorados', () => {
    const viajes = [
      asignado('a', '2026-09-01T10:00:00Z', 5),
      asignado('b', '2026-09-02T10:00:00Z', null),
      asignado('c', '2026-09-03T10:00:00Z', 4),
    ];
    expect(valoracionMedia(viajes)).toBe(4.5);
  });

  it('redondea a dos decimales', () => {
    const viajes = [
      asignado('a', '2026-09-01T10:00:00Z', 5),
      asignado('b', '2026-09-02T10:00:00Z', 4),
      asignado('c', '2026-09-03T10:00:00Z', 4),
    ];
    expect(valoracionMedia(viajes)).toBe(4.33);
  });

  it('ignora valores fuera de 1–5', () => {
    const viajes = [asignado('a', '2026-09-01T10:00:00Z', 0), asignado('b', '2026-09-02T10:00:00Z', 5)];
    expect(valoracionMedia(viajes)).toBe(5);
  });
});
