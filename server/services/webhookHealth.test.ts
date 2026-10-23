import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  diagnosticar, contrastar, EVENTOS_MANEJADOS,
  type EndpointStripe,
} from './webhookHealth';

const SECRETOS_OK = { principal: true, connect: true };

const ep = (extra: Partial<EndpointStripe> = {}): EndpointStripe => ({
  id: 'we_1',
  url: 'https://api.urbont.com/api/integrations/stripe/webhook',
  status: 'enabled',
  enabled_events: [...EVENTOS_MANEJADOS],
  api_version: '2026-02-25.clover',
  ...extra,
});

describe('EVENTOS_MANEJADOS no se desincroniza del webhook', () => {
  // Este es el test que importa. El fallo que motivó todo esto fue que el
  // código atendía `account.updated` y Stripe nunca lo enviaba; si alguien
  // añade un `case` y no lo apunta aquí, el validador del panel diría que todo
  // está bien mientras ese evento se pierde en silencio.
  it('la lista coincide con los case del switch de integrations.ts', () => {
    const fuente = readFileSync(join(__dirname, '../api/integrations.ts'), 'utf8');
    const webhook = fuente.slice(fuente.indexOf("integrationsRouter.post(\n  '/stripe/webhook'"));
    const cases = [...webhook.matchAll(/case '([a-z_]+\.[a-z_.]+)':/g)].map(m => m[1]);

    expect(cases.length).toBeGreaterThan(0);
    expect([...new Set(cases)].sort()).toEqual([...EVENTOS_MANEJADOS].sort());
  });
});

describe('diagnosticar', () => {
  it('todo suscrito, todo en verde', () => {
    const d = diagnosticar([ep()], SECRETOS_OK);
    expect(d.tono).toBe('ok');
    expect(d.sinSuscribir).toEqual([]);
  });

  it('nombra lo que el código atiende y Stripe no envía', () => {
    const sinAccount = EVENTOS_MANEJADOS.filter(e => e !== 'account.updated');
    const d = diagnosticar([ep({ enabled_events: [...sinAccount] })], SECRETOS_OK);
    expect(d.sinSuscribir).toEqual(['account.updated']);
    // Es el caso real que costó meses de choferes sin cobrar: va en rojo.
    expect(d.tono).toBe('error');
    expect(d.resumen).toContain('account.updated');
  });

  it('un evento accesorio avisa, pero no alarma', () => {
    const sinPayout = EVENTOS_MANEJADOS.filter(e => e !== 'payout.paid');
    const d = diagnosticar([ep({ enabled_events: [...sinPayout] })], SECRETOS_OK);
    expect(d.tono).toBe('warn');
    expect(d.sinSuscribirCriticos).toEqual([]);
  });

  it('entre dos endpoints se cubren: basta con que uno lo entregue', () => {
    const d = diagnosticar([
      ep({ id: 'we_conn', application: 'ca_1', enabled_events: ['account.updated', 'payout.paid'] }),
      ep({ id: 'we_main', enabled_events: EVENTOS_MANEJADOS.filter(e => e !== 'account.updated' && e !== 'payout.paid') }),
    ], SECRETOS_OK);
    expect(d.sinSuscribir).toEqual([]);
    expect(d.tono).toBe('ok');
    expect(d.endpoints.find(e => e.id === 'we_conn')!.esConnect).toBe(true);
  });

  it('un endpoint desactivado no cubre nada', () => {
    const d = diagnosticar([ep({ status: 'disabled' })], SECRETOS_OK);
    expect(d.tono).toBe('error');
    expect(d.resumen).toContain('desactivados');
  });

  it('sin endpoints lo dice claro', () => {
    const d = diagnosticar([], SECRETOS_OK);
    expect(d.tono).toBe('error');
    expect(d.resumen).toContain('ningún webhook');
  });

  it('el comodín de Stripe cubre todo', () => {
    const d = diagnosticar([ep({ enabled_events: ['*'] })], SECRETOS_OK);
    expect(d.sinSuscribir).toEqual([]);
    expect(d.tono).toBe('ok');
  });

  it('sin el secreto de firma el servidor rechaza todo', () => {
    const d = diagnosticar([ep()], { principal: false, connect: true });
    expect(d.tono).toBe('error');
    expect(d.resumen).toContain('STRIPE_WEBHOOK_SECRET');
  });

  it('lleva la lista completa de eventos para el detalle, ordenada', () => {
    const d = diagnosticar([ep({ enabled_events: ['payout.paid', 'account.updated', 'charge.refunded'] })], SECRETOS_OK);
    expect(d.endpoints[0].eventos).toEqual(['account.updated', 'charge.refunded', 'payout.paid']);
    expect(d.endpoints[0].totalEventos).toBe(3);
  });

  it('informa de cada endpoint sin perder ninguno', () => {
    const d = diagnosticar([ep({ id: 'a' }), ep({ id: 'b', status: 'disabled' })], SECRETOS_OK);
    expect(d.endpoints.map(e => e.id)).toEqual(['a', 'b']);
    expect(d.endpoints[1].activo).toBe(false);
  });
});

describe('contrastar — lo que Stripe tiene contra lo que guardamos', () => {
  it('cuadrado, en verde', () => {
    expect(contrastar(5, 5, 'reembolsos').tono).toBe('ok');
  });

  it('lo que falta es que el webhook no esta llegando', () => {
    const c = contrastar(5, 2, 'reembolsos');
    expect(c.tono).toBe('error');
    expect(c.faltan).toBe(3);
    expect(c.nota).toContain('3 de 5');
  });

  it('sin movimientos no hay nada que comparar', () => {
    const c = contrastar(0, 0, 'contracargos');
    expect(c.tono).toBe('ok');
    expect(c.faltan).toBe(0);
  });

  it('tener de mas no es un problema', () => {
    // El cron de reconciliación y nuestros propios reembolsos escriben sin
    // esperar al webhook, así que sobrar es lo normal.
    const c = contrastar(2, 7, 'reembolsos');
    expect(c.tono).toBe('ok');
    expect(c.faltan).toBe(0);
  });
});
