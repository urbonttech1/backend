import { describe, it, expect } from 'vitest';
import { vistaPreviaMensaje } from './chatPreview';

describe('vistaPreviaMensaje', () => {
  it('deja el texto tal cual', () => {
    expect(vistaPreviaMensaje('Voy en camino')).toEqual({ text: 'Voy en camino', type: 'text' });
  });

  it('cambia una nota de voz por «Voice message», sin el audio', () => {
    const preview = vistaPreviaMensaje('[VOICE_NOTE:UklGRiQAAABXQVZFZm10IBAAAAABAAEA]');
    expect(preview).toEqual({ text: 'Voice message', type: 'voice' });
    expect(preview.text).not.toContain('UklGR');
  });

  it('una nota subida como archivo también es voz', () => {
    expect(vistaPreviaMensaje('Voice message', 'ride/nota.m4a')).toEqual({ text: 'Voice message', type: 'voice' });
    expect(vistaPreviaMensaje('Hola', null).type).toBe('text');
  });

  it('sin mensaje devuelve texto vacío', () => {
    expect(vistaPreviaMensaje(null)).toEqual({ text: '', type: 'text' });
    expect(vistaPreviaMensaje(undefined)).toEqual({ text: '', type: 'text' });
  });

  it('sólo reconoce el prefijo al principio', () => {
    expect(vistaPreviaMensaje('Te mandé un [VOICE_NOTE:').type).toBe('text');
  });
});
