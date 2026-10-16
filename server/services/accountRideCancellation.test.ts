import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  perfil: { id: 'p1', role: 'passenger' } as Record<string, unknown> | null,
  viajes: [] as Record<string, unknown>[],
  cancelados: [] as string[],
  devueltos: [] as string[],
  avisos: [] as string[],
}));

vi.mock('../db/client', () => {
  const consulta = (tabla: string) => {
    const estado: { id?: string; update?: boolean } = {};
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'or', 'in']) q[m] = () => q;
    q.eq = (_c: string, v: string) => { estado.id = v; return q; };
    q.update = () => { estado.update = true; return q; };
    q.maybeSingle = async () => {
      if (tabla === 'profiles') return { data: db.perfil, error: null };
      if (estado.update && estado.id) { db.cancelados.push(estado.id); return { data: { id: estado.id }, error: null }; }
      return { data: null, error: null };
    };
    q.then = (ok: (v: unknown) => unknown) => ok({ data: db.viajes, error: null });
    return q;
  };
  return { supabaseAdmin: { from: consulta } };
});
vi.mock('../db/pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('./rideRefund', () => ({ devolverCobroDelViaje: async (pi: string | null) => { if (pi) db.devueltos.push(pi); } }));
vi.mock('./socketService', () => ({ broadcastRideStatus: () => {} }));
vi.mock('./fcm', () => ({ notifyUser: async (uid: string) => { db.avisos.push(`conductor:${uid}`); } }));
vi.mock('./valetNotifications', () => ({ notifyRidePassenger: async (_r: string, uid: string) => { db.avisos.push(`pasajero:${uid}`); } }));

import { aQuienAvisar, cancelarViajesDeLaCuenta, planDeCancelacion } from './accountRideCancellation';
import { DUENO_BORRADO } from './accountDeletion';

const viaje = (id: string, ride_status: string, extra: Record<string, unknown> = {}) => ({
  id, ride_status, passenger_id: 'p1', driver_id: 'd1', payment_intent_id: `pi_${id}`, ...extra,
});

beforeEach(() => {
  db.perfil = { id: 'p1', role: 'passenger' };
  db.viajes = [];
  db.cancelados = [];
  db.devueltos = [];
  db.avisos = [];
});

describe('planDeCancelacion', () => {
  it('cancela programados, en búsqueda, confirmados y con el conductor esperando', () => {
    const r = planDeCancelacion(['scheduled', 'searching', 'confirmed', 'driver_arrived'].map((s, i) => viaje(`r${i}`, s)));
    expect(r).toMatchObject({ ok: true });
  });

  it('no sigue si hay un viaje en curso', () => {
    expect(planDeCancelacion([viaje('r1', 'scheduled'), viaje('r2', 'in_progress')])).toEqual({ ok: false, enCurso: 1 });
  });
});

describe('aQuienAvisar', () => {
  it('avisa a la otra parte, nunca a la cuenta que se borra', () => {
    expect(aQuienAvisar(viaje('r1', 'confirmed'), 'p1')).toEqual({ pasajero: null, conductor: 'd1' });
    expect(aQuienAvisar(viaje('r1', 'confirmed'), 'd1')).toEqual({ pasajero: 'p1', conductor: null });
  });

  it('no avisa al perfil sin dueño ni a un conductor que no hay', () => {
    expect(aQuienAvisar(viaje('r1', 'searching', { passenger_id: DUENO_BORRADO, driver_id: null }), 'x')).toEqual({ pasajero: null, conductor: null });
  });
});

describe('cancelarViajesDeLaCuenta', () => {
  it('cancela cada viaje, devuelve su cobro y avisa al conductor', async () => {
    db.viajes = [viaje('r1', 'scheduled'), viaje('r2', 'confirmed', { payment_intent_id: null })];
    const r = await cancelarViajesDeLaCuenta('p1', 'passenger');
    expect(r).toEqual({ ok: true, cancelados: 2 });
    expect(db.cancelados).toEqual(['r1', 'r2']);
    expect(db.devueltos).toEqual(['pi_r1']);
    expect(db.avisos).toEqual(['conductor:d1', 'conductor:d1']);
  });

  it('con un viaje en curso no cancela ninguno', async () => {
    db.viajes = [viaje('r1', 'scheduled'), viaje('r2', 'in_progress')];
    const r = await cancelarViajesDeLaCuenta('p1', 'passenger');
    expect(r).toMatchObject({ ok: false, status: 409, errorCode: 'RIDE_IN_PROGRESS' });
    expect(db.cancelados).toEqual([]);
    expect(db.devueltos).toEqual([]);
  });

  it('no toca viajes de una cuenta de otro tipo', async () => {
    db.perfil = { id: 'p1', role: 'chauffeur' };
    db.viajes = [viaje('r1', 'scheduled')];
    const r = await cancelarViajesDeLaCuenta('p1', 'passenger');
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(db.cancelados).toEqual([]);
  });
});
