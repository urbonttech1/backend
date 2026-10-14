import { describe, expect, it } from 'vitest';
import { COPY, PUSH, ASUNTO, launchEmailHtml } from './tapToPayLaunchEmail';

const html = launchEmailHtml();
const textos = [ASUNTO, PUSH.title, PUSH.body, ...Object.values(COPY).flat().map(v => (typeof v === 'string' ? v : JSON.stringify(v)))];

describe('email de lanzamiento de Tap to Pay on iPhone', () => {
  it('nunca acorta el nombre: siempre "Tap to Pay on iPhone"', () => {
    for (const t of [html, ...textos]) {
      expect(t.match(/Tap to Pay(?! on iPhone)/g) ?? []).toEqual([]);
    }
  });

  it('abre con el nombre de la función, como pide la guía', () => {
    expect(html).toMatch(/<h1[^>]*>Tap to Pay on iPhone<\/h1>/);
  });

  it('no deja huecos de la plantilla sin rellenar', () => {
    expect(html).not.toMatch(/\[(partner|logo|botón|nombre|producto)/i);
  });

  it('lleva el aviso legal completo y los adicionales de privacidad y Apple Pay', () => {
    expect(html).toContain('Tap to Pay on iPhone Requirements:');
    expect(html).toContain('The Contactless Symbol is a trademark owned by and used with permission of EMVCo, LLC.');
    expect(html).toContain('Tap to Pay on iPhone Encryption and Storage:');
    expect(html).toContain('Apple Pay is a service provided by Apple Payments Services LLC');
  });

  it('toma las imágenes de la web, o de donde se le indique', () => {
    expect(html).toContain('https://urbont.com/email/tap-to-pay/launch-hero.jpg');
    expect(launchEmailHtml('file:///tmp/x')).toContain('file:///tmp/x/step-3.png');
  });
});
