import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DocumentoCatalogo } from './docCatalog';

/**
 * El alta en dos fases, contra una base simulada.
 *
 * Lo que se prueba aquí es lo que no cabe en `docCatalog.test.ts`: que el
 * bloqueo se calcule con los documentos reales del conductor y que el aviso de
 * «fase 1 aprobada» salga UNA sola vez, que es lo que evita que el conductor
 * reciba el mismo correo cada vez que el admin toca otro documento.
 */

const doc = (key: string, phase: 1 | 2): DocumentoCatalogo =>
  ({ key, label: key, category: 'Other', hint: '', expires: false, active: true, sortOrder: 10, phase });

const CATALOGO = [doc('license', 1), doc('photo', 1), doc('limoPermit', 2), doc('w9', 2)];

/** Lo que hay en la base simulada; cada test la coloca a su gusto. */
const base = {
  documentos: [] as Array<{ doc_key: string; status: string }>,
  perfil: {} as Record<string, unknown> | null,
  fallaLectura: false,
};

vi.mock('./docCatalogStore', () => ({
  documentosVigentes: async () => CATALOGO,
}));

vi.mock('../db/client', () => {
  // Un `supabaseAdmin` con lo justo que usa docPhases: leer documentos, leer el
  // perfil y sellar el aviso.
  const supabaseAdmin = {
    from(tabla: string) {
      if (tabla === 'driver_documents') {
        return {
          select: () => ({
            eq: async () => (base.fallaLectura
              ? { data: null, error: { message: 'sin conexión' } }
              : { data: base.documentos, error: null }),
          }),
        };
      }
      // profiles
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: base.perfil }) }) }),
        update: (fila: Record<string, unknown>) => ({
          eq: () => ({
            is: async () => {
              // El sello solo prende si estaba sin sellar: así es como el aviso
              // no se repite aunque dos aprobaciones entren a la vez.
              if (base.perfil && !base.perfil.docs_phase1_notified_at) {
                base.perfil.docs_phase1_notified_at = fila.docs_phase1_notified_at;
                return { error: null };
              }
              return { error: null };
            },
          }),
        }),
      };
    },
  };
  return { supabaseAdmin };
});

const pushes: string[] = [];
const correos: Array<{ email?: string | null }> = [];
vi.mock('./fcm', () => ({ notifyUser: async (id: string) => { pushes.push(id); return true; } }));
vi.mock('./accountEmails', () => ({
  enviarAvisoFase1Aprobada: async (t: { email?: string | null }) => { correos.push(t); return { ok: true }; },
}));

import { avisarFase1Aprobada, bloqueoDeFase, fasesDelConductor } from './docPhases';

const CHOFER = 'driver-1';
const subidos = (m: Record<string, string>) =>
  Object.entries(m).map(([doc_key, status]) => ({ doc_key, status }));

beforeEach(() => {
  base.documentos = [];
  base.perfil = { first_name: 'Ana', last_name: 'Pérez', email: 'ana@example.com', docs_phase1_notified_at: null };
  base.fallaLectura = false;
  pushes.length = 0;
  correos.length = 0;
});

describe('fasesDelConductor', () => {
  it('sin documentos, solo puede subir la fase 1', async () => {
    const { fases, disponibles } = await fasesDelConductor(CHOFER);
    expect(fases).toMatchObject({ fase: 1, desbloqueada: false });
    expect(disponibles.map(d => d.key)).toEqual(['license', 'photo']);
  });

  it('con la fase 1 aprobada, puede subirlo todo', async () => {
    base.documentos = subidos({ license: 'approved', photo: 'valid' });
    const { fases, disponibles } = await fasesDelConductor(CHOFER);
    expect(fases.desbloqueada).toBe(true);
    expect(disponibles).toHaveLength(4);
  });

  it('si no se puede leer la base, no se bloquea a nadie', async () => {
    // Dejar a un conductor sin poder avanzar por un fallo nuestro es peor que
    // dejarle subir de más: el admin revisa igual.
    base.fallaLectura = true;
    const { fases } = await fasesDelConductor(CHOFER);
    expect(fases.desbloqueada).toBe(true);
  });
});

describe('bloqueoDeFase', () => {
  it('rechaza un documento de la fase 2 y dice qué falta de la 1', async () => {
    base.documentos = subidos({ license: 'pending' });
    const b = await bloqueoDeFase(CHOFER, 'chauffeur', 'w9');
    expect(b).toMatchObject({ errorCode: 'PHASE_LOCKED', docKey: 'w9' });
    expect(b?.missingPhase1).toEqual(['photo']);
  });

  it('deja pasar los de la fase 1', async () => {
    expect(await bloqueoDeFase(CHOFER, 'chauffeur', 'license')).toBeNull();
  });

  it('deja pasar la fase 2 una vez aprobada la 1', async () => {
    base.documentos = subidos({ license: 'approved', photo: 'approved' });
    expect(await bloqueoDeFase(CHOFER, 'chauffeur', 'w9')).toBeNull();
  });
});

describe('avisarFase1Aprobada', () => {
  it('avisa por push y por correo cuando la fase 1 queda aprobada', async () => {
    base.documentos = subidos({ license: 'approved', photo: 'approved' });
    expect(await avisarFase1Aprobada(CHOFER)).toBe(true);
    expect(pushes).toEqual([CHOFER]);
    expect(correos).toEqual([{ email: 'ana@example.com', name: 'Ana Pérez' }]);
  });

  it('no repite el aviso por mucho que se le llame', async () => {
    // Se llama en cada aprobación de documento: sin el sello, el conductor
    // recibiría el mismo correo una vez por documento que el admin revise.
    base.documentos = subidos({ license: 'approved', photo: 'approved' });
    await avisarFase1Aprobada(CHOFER);
    expect(await avisarFase1Aprobada(CHOFER)).toBe(false);
    expect(correos).toHaveLength(1);
    expect(pushes).toHaveLength(1);
  });

  it('no avisa mientras falte algo de la fase 1', async () => {
    base.documentos = subidos({ license: 'approved', photo: 'pending' });
    expect(await avisarFase1Aprobada(CHOFER)).toBe(false);
    expect(correos).toHaveLength(0);
  });

  it('a quien ya tenía documentos de la fase 2 no se le manda este correo', async () => {
    // Su fase 2 está abierta porque ya entregó, no porque se le acabe de
    // aprobar nada: avisarle de algo que no pasó sería ruido.
    base.documentos = subidos({ license: 'pending', w9: 'approved' });
    expect(await avisarFase1Aprobada(CHOFER)).toBe(false);
  });

  it('sin correo en el perfil, el push sale igual', async () => {
    base.documentos = subidos({ license: 'approved', photo: 'approved' });
    base.perfil = { first_name: 'Ana', email: null, docs_phase1_notified_at: null };
    expect(await avisarFase1Aprobada(CHOFER)).toBe(true);
    expect(pushes).toHaveLength(1);
    expect(correos).toHaveLength(0);
  });
});
