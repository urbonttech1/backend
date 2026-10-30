import { describe, it, expect } from 'vitest';
import {
  REQUIRED_DOC_KEYS,
  ACCEPTED_DOC_KEYS,
  DOC_CATALOG,
  docMeta,
  normalizarEstadoDoc,
  elegirEsquema,
  LEGACY_DOC_KEYS,
  WEB_DOC_KEYS,
  catalogoSemilla,
  normalizarDocumentoAdmin,

  estadoDeFases, documentosDeLaFase, faseValida,
  type DocumentoCatalogo, type EstadoDoc,
} from './docCatalog';

/**
 * El catálogo es lo que sirve `GET /api/chauffeur/required-docs`, y existe para
 * que las dos pantallas de la app dejen de traer cada una su propia lista de
 * once documentos que no coincidían. Si una clave requerida se queda sin
 * metadatos, la app volvería a mostrar nombres de variable al conductor.
 */

describe('catálogo de documentos', () => {
  it('todos los documentos requeridos tienen etiqueta, categoría y ayuda', () => {
    for (const key of REQUIRED_DOC_KEYS) {
      const m = docMeta(key);
      expect(m.label, `${key} sin etiqueta`).toBeTruthy();
      expect(m.label, `${key} muestra la clave interna como etiqueta`).not.toBe(key);
      expect(m.category, `${key} sin categoría`).toBeTruthy();
      expect(m.hint, `${key} sin ayuda`).toBeTruthy();
    }
  });

  it('todo lo que se acepta subir está en el catálogo', () => {
    const sinMeta = ACCEPTED_DOC_KEYS.filter((k) => !DOC_CATALOG[k]);
    expect(sinMeta, `claves sin metadatos: ${sinMeta.join(', ')}`).toEqual([]);
  });

  it('una clave desconocida no lanza: cae a un valor razonable', () => {
    const m = docMeta('inventado');
    expect(m.key).toBe('inventado');
    expect(m.category).toBe('Other');
    expect(m.expires).toBe(false);
  });

  it('marca como caducables los que el cron tiene que vigilar', () => {
    // Los que llevan fecha de vencimiento son los que alimentan el aviso de
    // 30 y 7 días y la suspensión automática.
    for (const key of ['license', 'insurance', 'inspection', 'tncPermit', 'drugTest']) {
      expect(docMeta(key).expires, `${key} debería caducar`).toBe(true);
    }
    // Y los que no caducan nunca no deben pedir fecha.
    for (const key of ['photo', 'w9', 'bgCheck']) {
      expect(docMeta(key).expires, `${key} no debería caducar`).toBe(false);
    }
  });

  it('son once los documentos del alta móvil', () => {
    expect(REQUIRED_DOC_KEYS).toHaveLength(11);
  });
});

describe('normalizarEstadoDoc', () => {
  it("trata 'valid' y 'approved' como el mismo estado", () => {
    // La tabla guarda las dos palabras según por qué ruta se escribió. Contar
    // sólo una hacía que la aprobación automática no se disparara nunca.
    expect(normalizarEstadoDoc('valid')).toBe('aprobado');
    expect(normalizarEstadoDoc('approved')).toBe('aprobado');
  });

  it('reconoce el rechazo y deja lo demás en pendiente', () => {
    expect(normalizarEstadoDoc('rejected')).toBe('rechazado');
    expect(normalizarEstadoDoc('pending')).toBe('pendiente');
    expect(normalizarEstadoDoc(null)).toBe('pendiente');
    expect(normalizarEstadoDoc(undefined)).toBe('pendiente');
  });
});

describe('elegirEsquema — contra qué lista se mide a cada conductor', () => {
  it('a quien no ha subido nada, los diecisiete', () => {
    expect(elegirEsquema([])).toBe(WEB_DOC_KEYS);
    expect(WEB_DOC_KEYS.length).toBe(17);
  });

  it('a quien completó un esquema anterior, también los diecisiete', () => {
    // Decisión del 2026-09-20: una sola lista para todos mientras el proyecto
    // está en desarrollo. A estos conductores les faltarán seis documentos.
    expect(elegirEsquema([...LEGACY_DOC_KEYS])).toBe(WEB_DOC_KEYS);
    expect(elegirEsquema([...REQUIRED_DOC_KEYS])).toBe(WEB_DOC_KEYS);
  });

  it('a quien completó el del signup web, ése', () => {
    expect(elegirEsquema([...WEB_DOC_KEYS])).toBe(WEB_DOC_KEYS);
  });

  it('con un alta a medias, los diecisiete: es la lista vigente', () => {
    expect(elegirEsquema(['license', 'photo', 'bgCheck'])).toBe(WEB_DOC_KEYS);
  });

  it('es la misma elección que usa el recálculo, no una copia', () => {
    // Si divergieran, `required-docs` pediría documentos distintos de los que
    // el servidor comprueba para aprobar.
    const subidas = [...LEGACY_DOC_KEYS];
    const esquema = elegirEsquema(subidas);
    expect(esquema).toBe(WEB_DOC_KEYS);
  });
});

describe('catálogo administrable', () => {
  it('la semilla marca activos los que se piden, y apaga los tres acordados', () => {
    const semilla = catalogoSemilla();
    const activos = semilla.filter((d) => d.active).map((d) => d.key);
    // 17 del esquema, menos bgCheck y backgroundCheck; defensiveDriving ya estaba fuera.
    expect(activos).toHaveLength(15);
    for (const k of ['bgCheck', 'backgroundCheck', 'defensiveDriving']) {
      expect(semilla.find((d) => d.key === k)?.active).toBe(false);
    }
    // Ninguna clave del catálogo se queda fuera de la tabla.
    expect(semilla).toHaveLength(Object.keys(DOC_CATALOG).length);
  });

  it('la semilla conserva el orden del esquema y respeta los metadatos', () => {
    const semilla = catalogoSemilla();
    expect(semilla[0].key).toBe('license');
    expect(semilla[0].label).toBe("Driver's License");
    expect(semilla[0].expires).toBe(true);
    expect(semilla.map((d) => d.sortOrder)).toEqual([...semilla].sort((a, b) => a.sortOrder - b.sortOrder).map((d) => d.sortOrder));
  });
});

describe('normalizarDocumentoAdmin', () => {
  const ok = (body: Record<string, unknown>, opciones = {}) => {
    const r = normalizarDocumentoAdmin(body, opciones);
    if ('errorCode' in r) throw new Error(`esperaba ok y llegó ${r.errorCode}`);
    return r.doc;
  };
  const error = (body: Record<string, unknown>, opciones = {}) => {
    const r = normalizarDocumentoAdmin(body, opciones);
    if (!('errorCode' in r)) throw new Error('esperaba un error');
    return r;
  };

  it('una edición sólo toca lo que llega', () => {
    expect(ok({ active: false })).toEqual({ active: false });
    expect(ok({ label: '  Vehicle Inspection  ' })).toEqual({ label: 'Vehicle Inspection' });
  });

  it('acepta los booleanos como texto, que es lo que manda un formulario', () => {
    expect(ok({ expires: 'true', active: 'false' })).toEqual({ expires: true, active: false });
  });

  it('un documento nuevo necesita clave, nombre y categoría', () => {
    expect(ok({ key: 'tollTag', label: 'Toll Tag', category: 'Vehicle Documents' }, { nuevo: true }))
      .toMatchObject({ key: 'tollTag', label: 'Toll Tag', category: 'Vehicle Documents' });
    expect(error({ label: 'Toll Tag', category: 'Vehicle Documents' }, { nuevo: true }).errorCode).toBe('INVALID_KEY');
    expect(error({ key: 'toll tag', label: 'Toll Tag', category: 'x y' }, { nuevo: true }).errorCode).toBe('INVALID_KEY');
    expect(error({ key: 'tollTag', label: '', category: 'Vehicle' }, { nuevo: true }).errorCode).toBe('INVALID_LABEL');
  });

  it('rechaza valores fuera de rango y cuerpos vacíos', () => {
    expect(error({ hint: 'x'.repeat(201) })).toMatchObject({ errorCode: 'INVALID_HINT', field: 'hint' });
    expect(error({ sortOrder: -1 }).errorCode).toBe('INVALID_SORT_ORDER');
    expect(error({ active: 'quizá' }).errorCode).toBe('INVALID_FLAG');
    expect(error({}).errorCode).toBe('NOTHING_TO_UPDATE');
  });
});

describe('estadoDeFases — el alta en dos tandas', () => {
  const doc = (key: string, phase: 1 | 2): DocumentoCatalogo =>
    ({ key, label: key, category: 'Other', hint: '', expires: false, active: true, sortOrder: 10, phase });

  // Fase 1: identidad y vehículo. Fase 2: permisos y papeles de empresa.
  const CATALOGO = [doc('license', 1), doc('photo', 1), doc('registration', 1), doc('limoPermit', 2), doc('w9', 2)];
  const estados = (m: Record<string, EstadoDoc>) => new Map(Object.entries(m));
  const FASE1_OK = { license: 'aprobado', photo: 'aprobado', registration: 'aprobado' } as const;

  it('recién llegado: solo ve la fase 1 y la 2 le queda bloqueada', () => {
    const f = estadoDeFases(CATALOGO, estados({}));
    expect(f).toMatchObject({ fase: 1, desbloqueada: false, motivo: 'espera_aprobacion' });
    expect(f.faltanFase1).toEqual(['license', 'photo', 'registration']);
    expect(f.bloqueados).toEqual(['limoPermit', 'w9']);
    expect(documentosDeLaFase(CATALOGO, f).map(d => d.key)).toEqual(['license', 'photo', 'registration']);
  });

  it('subida pero sin revisar: sigue bloqueada, y se sabe qué espera revisión', () => {
    const f = estadoDeFases(CATALOGO, estados({ license: 'pendiente', photo: 'pendiente', registration: 'pendiente' }));
    expect(f).toMatchObject({ desbloqueada: false });
    expect(f.faltanFase1).toEqual([]);
    expect(f.pendientesFase1).toEqual(['license', 'photo', 'registration']);
  });

  it('aprobada la fase 1 entera, se abre la 2', () => {
    const f = estadoDeFases(CATALOGO, estados(FASE1_OK));
    expect(f).toMatchObject({ fase: 2, desbloqueada: true, motivo: 'fase_1_aprobada' });
    expect(f.bloqueados).toEqual([]);
    expect(documentosDeLaFase(CATALOGO, f)).toHaveLength(5);
  });

  it('con uno solo sin aprobar la fase 2 no se abre', () => {
    const f = estadoDeFases(CATALOGO, estados({ ...FASE1_OK, registration: 'pendiente' }));
    expect(f.desbloqueada).toBe(false);
  });

  it('quien ya entregó documentos de la fase 2 no los pierde de vista', () => {
    // Los conductores anteriores a las fases: esconderles lo que ya subieron
    // les haría creer que se perdió.
    const f = estadoDeFases(CATALOGO, estados({ license: 'pendiente', w9: 'aprobado' }));
    expect(f).toMatchObject({ desbloqueada: true, motivo: 'ya_tiene_fase_2' });
  });

  it('un rechazo de la fase 1 no vuelve a cerrar la fase 2', () => {
    const abierta = estadoDeFases(CATALOGO, estados({ ...FASE1_OK, w9: 'pendiente' }));
    expect(abierta.desbloqueada).toBe(true);
    const tras = estadoDeFases(CATALOGO, estados({ ...FASE1_OK, photo: 'rechazado', w9: 'pendiente' }));
    expect(tras.desbloqueada).toBe(true);
  });

  it('sin documentos en la fase 2, no hay nada que bloquear', () => {
    const soloFase1 = CATALOGO.filter(d => d.phase === 1);
    expect(estadoDeFases(soloFase1, estados({}))).toMatchObject({ desbloqueada: true, motivo: 'sin_fase_2' });
  });

  it('los desactivados no cuentan: quien llama pasa solo los activos', () => {
    const f = estadoDeFases([doc('license', 1), doc('w9', 2)], estados({ license: 'aprobado' }));
    expect(f.desbloqueada).toBe(true);
  });
});

describe('faseValida', () => {
  it('solo la 2 es la 2; lo demás es fase 1', () => {
    expect(faseValida(2)).toBe(2);
    expect(faseValida('2')).toBe(2);
    for (const v of [1, null, undefined, 0, 3, 'x']) expect(faseValida(v)).toBe(1);
  });
});
