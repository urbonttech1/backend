import { beforeEach, describe, expect, it, vi } from 'vitest';

// Estado de la base simulada para cada test.
const db = vi.hoisted(() => ({
  perfil: null as Record<string, unknown> | null,
  activos: 0,
  authError: null as { message: string } | null,
  fallarEn: null as string | null,
  sql: [] as string[],
  pasos: [] as string[],
}));

vi.mock('../db/client', () => {
  // Constructor de consultas mínimo: cualquier cadena termina en lo que toque.
  const consulta = (tabla: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'or', 'in', 'ilike', 'update', 'delete']) q[m] = () => q;
    q.maybeSingle = async () => ({ data: tabla === 'profiles' ? db.perfil : null, error: null });
    q.then = (ok: (v: unknown) => unknown) => ok({ data: [], error: null, count: tabla === 'rides' ? db.activos : 0 });
    return q;
  };
  return {
    supabaseAdmin: {
      from: consulta,
      auth: {
        admin: {
          deleteUser: async () => { db.pasos.push('auth'); return { error: db.authError }; },
          updateUserById: async () => ({ error: null }),
        },
      },
      storage: {
        from: () => ({
          list: async () => ({ data: [{ name: 'license.jpg' }] }),
          remove: async (rutas: string[]) => { db.pasos.push(`storage:${rutas.join(',')}`); return {}; },
        }),
      },
    },
  };
});

vi.mock('../db/pool', () => ({
  pool: {
    connect: async () => ({
      query: async (sql: string) => {
        db.sql.push(sql.replace(/\s+/g, ' ').trim());
        if (db.fallarEn && sql.includes(db.fallarEn)) throw new Error('fallo simulado');
        return { rows: [], rowCount: 1 };
      },
      release: () => {},
    }),
  },
}));

import { borrarCuentaDefinitiva, DUENO_BORRADO } from './accountDeletion';

const UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => {
  db.perfil = { id: UID, email: 'winnie@example.com', first_name: 'winnie', last_name: 'pooh', role: 'valet', account_status: 'active' };
  db.activos = 0;
  db.authError = null;
  db.fallarEn = null;
  db.sql = [];
  db.pasos = [];
});

describe('borrarCuentaDefinitiva', () => {
  it('borra la cuenta aunque tenga viajes, que pasan al perfil sin dueño', async () => {
    const r = await borrarCuentaDefinitiva(UID, 'valet');

    expect(r).toEqual({ ok: true, email: 'winnie@example.com', nombre: 'winnie pooh', persona: 'winnie pooh' });
    expect(db.pasos[0]).toBe('auth');                    // Auth antes que la base
    expect(db.sql[0]).toBe('BEGIN');
    expect(db.sql.some(s => s.startsWith('INSERT INTO profiles') && s.includes('ON CONFLICT (id) DO NOTHING'))).toBe(true);
    const reasignar = db.sql.findIndex(s => s.startsWith('UPDATE rides SET passenger_id'));
    const borrarPerfil = db.sql.findIndex(s => s.startsWith('DELETE FROM profiles'));
    expect(reasignar).toBeGreaterThan(0);
    expect(borrarPerfil).toBeGreaterThan(reasignar);     // si no, la FK NOT NULL lo rechaza
    expect(db.sql.at(-1)).toBe('COMMIT');
    expect(db.pasos).toContain(`storage:${UID}/license.jpg`);
  });

  it('sirve para conductores', async () => {
    db.perfil = { ...db.perfil, role: 'chauffeur' };
    const r = await borrarCuentaDefinitiva(UID, 'chauffeur');
    expect(r.ok).toBe(true);
    expect(db.sql.some(s => s.startsWith('UPDATE rides SET driver_name'))).toBe(true);
  });

  it('no toca nada si tiene un viaje activo', async () => {
    db.activos = 1;
    const r = await borrarCuentaDefinitiva(UID, 'valet');
    expect(r).toMatchObject({ ok: false, status: 409, errorCode: 'ACTIVE_RIDES' });
    expect(db.pasos).toEqual([]);
    expect(db.sql).toEqual([]);
  });

  it('si Auth falla no toca la base', async () => {
    db.authError = { message: 'boom' };
    const r = await borrarCuentaDefinitiva(UID, 'valet');
    expect(r).toMatchObject({ ok: false, errorCode: 'ACCOUNT_NOT_DELETED' });
    expect(db.sql).toEqual([]);
  });

  it('un usuario de Auth que ya no existe no impide terminar el borrado', async () => {
    db.authError = { message: 'User not found' };
    const r = await borrarCuentaDefinitiva(UID, 'valet');
    expect(r.ok).toBe(true);
  });

  it('si falla la base deshace la transacción y no borra archivos', async () => {
    db.fallarEn = 'DELETE FROM profiles';
    const r = await borrarCuentaDefinitiva(UID, 'valet');
    expect(r).toMatchObject({ ok: false, errorCode: 'ACCOUNT_NOT_DELETED' });
    expect(db.sql.at(-1)).toBe('ROLLBACK');
    expect(db.pasos.some(p => p.startsWith('storage'))).toBe(false);
  });

  it('el perfil sin dueño no se puede borrar', async () => {
    const r = await borrarCuentaDefinitiva(DUENO_BORRADO, 'passenger');
    expect(r).toMatchObject({ ok: false, status: 404 });
  });

  it('no borra una cuenta de otro tipo', async () => {
    const r = await borrarCuentaDefinitiva(UID, 'passenger');   // es un valet
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(db.pasos).toEqual([]);
  });
});
