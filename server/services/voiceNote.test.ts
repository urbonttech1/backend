import { describe, it, expect } from 'vitest';
import {
  normalizarMime, mimeDeRuta, rutaNota, normalizarDuracion, esUuid,
  AUDIO_MAX_DURACION_MS,
} from './voiceNote';

const RIDE = '07b47866-11aa-4ea6-8f21-dea545924727';
const NOTA = '5b0c2f4e-8d1a-4c3b-9e7f-1a2b3c4d5e6f';

describe('normalizarMime', () => {
  it('acepta los cuatro formatos', () => {
    for (const m of ['audio/mp4', 'audio/aac', 'audio/webm', 'audio/ogg']) expect(normalizarMime(m)).toBe(m);
  });

  it('quita los parámetros de códec y las mayúsculas', () => {
    expect(normalizarMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(normalizarMime(' Audio/MP4; codecs="mp4a.40.2"')).toBe('audio/mp4');
  });

  it('traduce los alias de m4a y aac', () => {
    expect(normalizarMime('audio/x-m4a')).toBe('audio/mp4');
    expect(normalizarMime('audio/m4a')).toBe('audio/mp4');
    expect(normalizarMime('audio/x-aac')).toBe('audio/aac');
  });

  it('rechaza lo demás', () => {
    expect(normalizarMime('audio/wav')).toBeNull();
    expect(normalizarMime('image/png')).toBeNull();
    expect(normalizarMime(undefined)).toBeNull();
  });
});

describe('rutaNota y mimeDeRuta', () => {
  it('una carpeta por viaje, con la extensión del formato', () => {
    expect(rutaNota(RIDE, NOTA, 'audio/mp4')).toBe(`${RIDE}/${NOTA}.m4a`);
    expect(rutaNota(RIDE, NOTA, 'audio/webm')).toBe(`${RIDE}/${NOTA}.webm`);
  });

  it('recupera el formato desde la ruta', () => {
    expect(mimeDeRuta(`${RIDE}/${NOTA}.m4a`)).toBe('audio/mp4');
    expect(mimeDeRuta(`${RIDE}/${NOTA}.ogg`)).toBe('audio/ogg');
    expect(mimeDeRuta(`${RIDE}/${NOTA}.wav`)).toBeNull();
  });
});

describe('normalizarDuracion', () => {
  it('es opcional', () => {
    expect(normalizarDuracion(undefined)).toBeNull();
    expect(normalizarDuracion(null)).toBeNull();
  });

  it('acepta números y cadenas, y redondea', () => {
    expect(normalizarDuracion(15230.4)).toBe(15230);
    expect(normalizarDuracion('8000')).toBe(8000);
  });

  it('rechaza negativos, texto y más de 5 minutos', () => {
    expect(normalizarDuracion(-1)).toBeUndefined();
    expect(normalizarDuracion('abc')).toBeUndefined();
    expect(normalizarDuracion(AUDIO_MAX_DURACION_MS + 1)).toBeUndefined();
  });
});

describe('esUuid', () => {
  it('valida el identificador de la nota', () => {
    expect(esUuid(NOTA)).toBe(true);
    expect(esUuid('../otro-viaje/x')).toBe(false);
    expect(esUuid(123)).toBe(false);
  });
});
