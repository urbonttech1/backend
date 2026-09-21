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
