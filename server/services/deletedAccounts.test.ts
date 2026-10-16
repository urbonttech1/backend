import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../db/client', () => ({ supabaseAdmin: {} }));

import { emparejar, leerObjetivo, VENTANA_MS } from './deletedAccounts';
import { identidadParaReactivar, partirNombre } from './accountReactivation';

const UID = 'f7a022a3-ddaf-4be7-bf33-453e790df14b';

describe('leerObjetivo', () => {
  it('saca nombre, correo e id del registro de auditoría', () => {
    expect(leerObjetivo(`Paulo Estrada (pauloestrada1027@gmail.com) · 1 viaje(s) cancelados [${UID}]`))
      .toEqual({ nombre: 'Paulo Estrada', correo: 'pauloestrada1027@gmail.com', id: UID });
  });

  it('entiende los registros de antes, sin id ni viajes', () => {
    expect(leerObjetivo('Ciro Vargas (pcman2010@gmail.com)')).toEqual({ nombre: 'Ciro Vargas', correo: 'pcman2010@gmail.com', id: null });
    expect(leerObjetivo('solo@correo.com')).toEqual({ nombre: 'solo@correo.com', correo: null, id: null });
  });
});

describe('emparejar', () => {
  const perfil = { id: UID, role: 'passenger', updated_at: '2026-10-16T20:56:21.753Z', viajes: 3 };

  it('une el perfil con su registro por id', () => {
    const [c] = emparejar([perfil], [{ admin_name: 'Felipe', action: 'passenger.delete', target: `Paulo Estrada (p@x.com) [${UID}]`, created_at: '2026-10-10T00:00:00.000Z' }]);
    expect(c).toMatchObject({ id: UID, definitivo: false, nombre: 'Paulo Estrada', correo: 'p@x.com', borradaPor: 'Felipe', viajes: 3 });
  });

  it('sin id, por la hora del borrado; fuera de la ventana no adivina', () => {
    const cerca = { admin_name: 'Felipe', action: 'passenger.delete', target: 'Paulo Estrada (p@x.com)', created_at: '2026-10-16T20:56:25.272Z' };
    expect(emparejar([perfil], [cerca])[0]).toMatchObject({ nombre: 'Paulo Estrada', correo: 'p@x.com' });
    const lejos = { ...cerca, created_at: new Date(Date.parse(perfil.updated_at) + VENTANA_MS + 1000).toISOString() };
    expect(emparejar([perfil], [lejos]).find(c => !c.definitivo)).toMatchObject({ nombre: null, correo: null });
  });

  it('añade los borrados definitivos, que ya no tienen perfil, y ordena del más reciente', () => {
    const lista = emparejar([perfil], [
      { admin_name: 'Felipe', action: 'driver.delete.hard', target: 'Otro (o@x.com)', created_at: '2026-10-16T21:13:57.484Z' },
    ]);
    expect(lista.map(c => c.definitivo)).toEqual([true, false]);
    expect(lista[0]).toMatchObject({ id: null, nombre: 'Otro', correo: 'o@x.com', viajes: null });
  });

  it('un registro definitivo nunca se empareja con un perfil que sigue existiendo', () => {
    const [c] = emparejar([perfil], [{ admin_name: 'F', action: 'passenger.delete.hard', target: `X (x@x.com) [${UID}]`, created_at: perfil.updated_at }])
      .filter(x => !x.definitivo);
    expect(c.nombre).toBeNull();
  });
});

describe('reactivar: de quién era la cuenta', () => {
  it('toma el correo de Google, que no cambia al borrar, y el nombre de la auditoría', () => {
    const r = identidadParaReactivar(
      { nombre: 'Paulo Estrada', correo: 'otro@x.com' },
      { email: `deleted+${UID}@deleted.urbont.com`, identities: [{ provider: 'google', identity_data: { email: 'PauloEstrada1027@gmail.com' } }], user_metadata: { full_name: 'P. E.' } },
    );
    expect(r).toEqual({ nombre: 'Paulo Estrada', correo: 'pauloestrada1027@gmail.com' });
  });

  it('sin Google, usa el correo de la auditoría y nunca el de cuenta borrada', () => {
    expect(identidadParaReactivar({ nombre: 'Ana', correo: 'ana@x.com' }, { email: `deleted+${UID}@deleted.urbont.com` }))
      .toEqual({ nombre: 'Ana', correo: 'ana@x.com' });
    expect(identidadParaReactivar(null, { email: `deleted+${UID}@deleted.urbont.com` }).correo).toBeNull();
  });

  it('si la auditoría no tiene nombre, el de Google', () => {
    expect(identidadParaReactivar({ nombre: 'Deleted User', correo: null }, { user_metadata: { full_name: 'Paulo Estrada', email: 'p@x.com' } }))
      .toEqual({ nombre: 'Paulo Estrada', correo: 'p@x.com' });
  });

  it('parte el nombre en nombre y apellido', () => {
    expect(partirNombre('Paulo Andrés Estrada')).toEqual({ first: 'Paulo', last: 'Andrés Estrada' });
    expect(partirNombre('Ana')).toEqual({ first: 'Ana', last: null });
    expect(partirNombre(null)).toEqual({ first: null, last: null });
  });
});
