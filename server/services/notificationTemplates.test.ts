import { describe, it, expect } from 'vitest';
import { buildNotificationCatalog } from './notificationCatalog';
import { driverNotif, passengerNotif } from './notificationTemplates';
import { textoSillas } from './childSeats';

/** Números del texto (montos, horas, días), para comparar las dos versiones. */
const numeros = (s: string) => (s.match(/\d+(?:[.:]\d+)?/g) ?? []).sort();

describe('plantillas en inglés y español', () => {
  const catalogo = buildNotificationCatalog();

  it.each(catalogo.map((e) => [`${e.audience}:${e.key}`, e] as const))('%s tiene las dos versiones', (_k, e) => {
    expect(e.titleEs?.trim()).toBeTruthy();
    expect(e.bodyEs?.trim()).toBeTruthy();
    for (const texto of [e.title, e.body, e.titleEs!, e.bodyEs!]) {
      expect(texto).not.toMatch(/undefined|NaN|null/);
    }
  });

  it.each(catalogo.map((e) => [`${e.audience}:${e.key}`, e] as const))('%s dice las mismas cifras en los dos idiomas', (_k, e) => {
    expect(numeros(`${e.titleEs} ${e.bodyEs}`)).toEqual(numeros(`${e.title} ${e.body}`));
  });
});

describe('fechas', () => {
  // 18:00 UTC del 3 de noviembre de 2026 = 1:00 p. m. en Miami.
  const iso = '2026-11-03T18:00:00Z';

  it('formatea la hora en la zona del servicio, no en la del servidor', () => {
    const t = passengerNotif.scheduled24h('r1', iso);
    expect(t.body).toContain('tomorrow at 1:00 PM');
    expect(t.es.body).toContain('mañana a la 1:00 p.m.');
  });

  it('usa "a las" salvo para la una', () => {
    expect(passengerNotif.scheduled1h('r1', '2026-11-03T20:00:00Z').es.body).toContain('a las 3:00 p.m.');
  });

  it('cae en "Tu chofer" si el chofer no tiene nombre', () => {
    expect(passengerNotif.chauffeurReserved('r1', undefined, iso).es.body).toMatch(/^Tu chofer te recogerá el /);
    expect(passengerNotif.chauffeurReserved('r1', undefined, null).body).toBe('Your chauffeur will pick you up at your reserved time.');
  });
});

describe('oferta programada con sillas', () => {
  const sillas = { rear_facing: 1, forward_facing: 0, booster: 2 };

  it('lleva el requisito en el idioma de cada versión', () => {
    const t = driverNotif.scheduledRideOffer('r1', 'suv', 'Calle 82', '2026-11-03T18:00:00Z', {
      en: textoSillas(sillas, 'en'), es: textoSillas(sillas, 'es'),
    });
    expect(t.body).toContain('Needs 1 rear-facing seat and 2 booster seats.');
    expect(t.es.body).toContain('Necesita 1 silla a contramarcha y 2 asientos elevadores.');
  });

  it('sin sillas no deja un punto suelto', () => {
    const t = driverNotif.scheduledRideOffer('r1', 'suv', 'Calle 82', '2026-11-03T18:00:00Z', { en: '', es: '' });
    expect(t.body.endsWith('at Calle 82.')).toBe(true);
    expect(t.es.body.endsWith('en Calle 82.')).toBe(true);
  });
});
