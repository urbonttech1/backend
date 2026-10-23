import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/client', () => ({ supabaseAdmin: {} }));

import { ubicacionDocumento, BUCKET_DOCS, BUCKET_W9 } from './driverDocUrl';

const PUBLICA = 'https://rvlafaebvlrtrfdtcbut.supabase.co/storage/v1/object/public/chauffeur-docs/abc-123/licencia.jpg';

describe('ubicacionDocumento', () => {
  it('saca bucket y ruta de la URL publica que guardan las subidas de hoy', () => {
    expect(ubicacionDocumento(PUBLICA)).toEqual({ bucket: 'chauffeur-docs', path: 'abc-123/licencia.jpg' });
  });

  it('entiende el W-9, que ya se guardaba marcado', () => {
    expect(ubicacionDocumento('valet-tax:usuario/w9.pdf')).toEqual({ bucket: BUCKET_W9, path: 'usuario/w9.pdf' });
  });

  it('una ruta pelada va al bucket de documentos', () => {
    expect(ubicacionDocumento('abc-123/licencia.jpg')).toEqual({ bucket: BUCKET_DOCS, path: 'abc-123/licencia.jpg' });
    expect(ubicacionDocumento('/abc-123/licencia.jpg')).toEqual({ bucket: BUCKET_DOCS, path: 'abc-123/licencia.jpg' });
  });

  it('tambien reconoce una URL ya firmada', () => {
    // Por si alguna fila quedo guardada asi: se extrae la ruta igual y se
    // vuelve a firmar, en vez de servir una firma caducada.
    const firmada = 'https://x.supabase.co/storage/v1/object/sign/chauffeur-docs/abc/doc.pdf?token=eyJ';
    expect(ubicacionDocumento(firmada)).toEqual({ bucket: 'chauffeur-docs', path: 'abc/doc.pdf' });
  });

  it('decodifica los nombres con espacios o acentos', () => {
    const u = 'https://x.supabase.co/storage/v1/object/public/chauffeur-docs/abc/licencia%20conducci%C3%B3n.jpg';
    expect(ubicacionDocumento(u)!.path).toBe('abc/licencia conducción.jpg');
  });

  it('respeta el bucket que diga la URL, no asume chauffeur-docs', () => {
    const u = 'https://x.supabase.co/storage/v1/object/public/incident-photos/foto.jpg';
    expect(ubicacionDocumento(u)).toEqual({ bucket: 'incident-photos', path: 'foto.jpg' });
  });

  it('sin valor, nada que firmar', () => {
    for (const v of [null, undefined, '', '   ']) expect(ubicacionDocumento(v)).toBeNull();
  });

  it('una URL que no es de nuestro storage no se toca', () => {
    // Se devuelve null y quien llama deja el valor tal cual: inventarle una
    // ruta produciria una firma a un objeto que no existe.
    expect(ubicacionDocumento('https://ejemplo.com/foto.jpg')).toBeNull();
    expect(ubicacionDocumento('http://otro.com/a/b/c.pdf')).toBeNull();
  });
});
