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

  it('a quien completó el esquema de limusina, ése', () => {
    // Contando claves empataba con el web y le aparecían seis faltantes:
    // conductores ya aprobados volvían a pending_documents.
    expect(elegirEsquema([...LEGACY_DOC_KEYS])).toBe(LEGACY_DOC_KEYS);
  });

  it('a quien completó el del signup web, ése', () => {
    expect(elegirEsquema([...WEB_DOC_KEYS])).toBe(WEB_DOC_KEYS);
  });

  it('con un alta a medias, los diecisiete: es la lista vigente', () => {
    expect(elegirEsquema(['license', 'photo', 'bgCheck'])).toBe(WEB_DOC_KEYS);
  });

  it('a quien completó el alta móvil de once, ése: ya estaba aprobado', () => {
    expect(elegirEsquema([...REQUIRED_DOC_KEYS])).toBe(REQUIRED_DOC_KEYS);
  });

  it('es la misma elección que usa el recálculo, no una copia', () => {
    // Si divergieran, `required-docs` pediría documentos distintos de los que
    // el servidor comprueba para aprobar.
    const subidas = [...LEGACY_DOC_KEYS];
    const esquema = elegirEsquema(subidas);
    expect(esquema).toBe(LEGACY_DOC_KEYS);
  });
});
