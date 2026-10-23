/**
 * ¿Están llegando los webhooks de Stripe?
 *
 * Existe por un fallo que costó meses: `account.updated` estaba programado en
 * el código pero el endpoint de Stripe nunca estuvo suscrito a ese evento. Un
 * webhook al que no estás suscrito no da error, simplemente no llega, así que
 * nadie se entera hasta que algo no cuadra. Aquí se contrasta lo que el código
 * sabe atender contra lo que Stripe tiene suscrito, y se nombra lo que falta.
 *
 * Todo lo de este archivo es puro: la parte que habla con Stripe y con la base
 * vive en la ruta que lo usa.
 */

export type Tono = 'ok' | 'warn' | 'error';

/**
 * Los eventos que el `switch` del webhook atiende hoy.
 *
 * `webhookHealth.test.ts` comprueba que esta lista coincide con los `case` de
 * `integrations.ts`. Si alguien añade un manejador y se olvida de esta lista,
 * el test falla: es justo la desconexión entre código y configuración que
 * provocó lo de `account.updated`.
 */
export const EVENTOS_MANEJADOS = [
  'account.updated',
  'charge.dispute.closed',
  'charge.dispute.created',
  'charge.dispute.funds_reinstated',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.updated',
  'charge.refunded',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'payment_intent.payment_failed',
  'payment_intent.succeeded',
  'payout.paid',
  'refund.created',
  'refund.updated',
] as const;

/**
 * Los que, si no llegan, rompen algo que se nota en dinero. Se separan del
 * resto para que el panel no pinte en rojo la falta de un evento accesorio.
 */
export const EVENTOS_CRITICOS = new Set<string>([
  'payment_intent.succeeded',
  'account.updated',
  'charge.refunded',
  'charge.dispute.created',
]);

export interface EndpointStripe {
  id: string;
  url: string;
  /** 'enabled' | 'disabled' */
  status: string;
  enabled_events: string[];
  /** Si viene, el endpoint es de una app de Connect. */
  application?: string | null;
  description?: string | null;
  api_version?: string | null;
}

export interface EndpointRevisado {
  id: string;
  url: string;
  activo: boolean;
  esConnect: boolean;
  apiVersion: string | null;
  totalEventos: number;
  /** Los que atiende el código y este endpoint sí trae. */
  manejados: string[];
}

export interface DiagnosticoWebhooks {
  tono: Tono;
  resumen: string;
  endpoints: EndpointRevisado[];
  /** Eventos que el código atiende y NINGÚN endpoint activo entrega. */
  sinSuscribir: string[];
  sinSuscribirCriticos: string[];
  secretos: { principal: boolean; connect: boolean };
}

/** Stripe admite `*` como comodín: ese endpoint entrega cualquier evento. */
function entrega(endpoint: EndpointStripe, evento: string): boolean {
  return endpoint.enabled_events.includes('*') || endpoint.enabled_events.includes(evento);
}

/**
 * El diagnóstico completo.
 *
 * Un evento cuenta como cubierto si lo entrega CUALQUIER endpoint activo: los
 * dos endpoints de Urbont apuntan a la misma URL y el código prueba los dos
 * secretos de firma, así que da igual por cuál llegue.
 */
export function diagnosticar(
  endpoints: EndpointStripe[],
  secretos: { principal: boolean; connect: boolean },
  manejados: readonly string[] = EVENTOS_MANEJADOS,
): DiagnosticoWebhooks {
  const activos = endpoints.filter(e => e.status === 'enabled');

  const sinSuscribir = manejados.filter(ev => !activos.some(e => entrega(e, ev)));
  const sinSuscribirCriticos = sinSuscribir.filter(ev => EVENTOS_CRITICOS.has(ev));

  const revisados: EndpointRevisado[] = endpoints.map(e => ({
    id: e.id,
    url: e.url,
    activo: e.status === 'enabled',
    esConnect: !!e.application,
    apiVersion: e.api_version ?? null,
    totalEventos: e.enabled_events.length,
    manejados: manejados.filter(ev => entrega(e, ev)),
  }));

  let tono: Tono = 'ok';
  let resumen = 'Todo lo que el código atiende está suscrito en Stripe.';

  if (activos.length === 0) {
    tono = 'error';
    resumen = endpoints.length === 0
      ? 'Stripe no tiene ningún webhook configurado: no llega nada.'
      : 'Todos los webhooks están desactivados en Stripe: no llega nada.';
  } else if (sinSuscribirCriticos.length > 0) {
    tono = 'error';
    resumen = `Faltan ${sinSuscribirCriticos.length} evento(s) de los que mueven dinero: ${sinSuscribirCriticos.join(', ')}.`;
  } else if (sinSuscribir.length > 0) {
    tono = 'warn';
    resumen = `El código atiende ${sinSuscribir.length} evento(s) que Stripe no envía: ${sinSuscribir.join(', ')}.`;
  } else if (!secretos.principal) {
    tono = 'error';
    resumen = 'Falta STRIPE_WEBHOOK_SECRET: el servidor rechaza todo lo que llega.';
  }

  return { tono, resumen, endpoints: revisados, sinSuscribir, sinSuscribirCriticos, secretos };
}

export interface Contraste {
  /** Lo que Stripe dice que pasó en la ventana. */
  enStripe: number;
  /** Lo que quedó registrado de nuestro lado. */
  registrados: number;
  faltan: number;
  tono: Tono;
  nota: string;
}

/**
 * La prueba de verdad: lo que Stripe tiene contra lo que nosotros guardamos.
 *
 * Revisar la configuración dice si los eventos *deberían* llegar; esto dice si
 * de verdad llegaron. Un endpoint bien suscrito pero caído se ve igual de bien
 * en la configuración y aquí sale en rojo.
 *
 * Tolera que sobren registros: el cron de reconciliación y los reembolsos que
 * hacemos nosotros escriben sin esperar al webhook, así que tener de más es
 * normal y no es un problema.
 */
export function contrastar(enStripe: number, registrados: number, etiqueta: string): Contraste {
  const faltan = Math.max(0, enStripe - registrados);
  if (enStripe === 0) {
    return { enStripe, registrados, faltan: 0, tono: 'ok', nota: `Sin ${etiqueta} en la ventana revisada` };
  }
  if (faltan === 0) {
    return { enStripe, registrados, faltan, tono: 'ok', nota: `${enStripe} en Stripe, ${registrados} registrados` };
  }
  return {
    enStripe, registrados, faltan,
    tono: 'error',
    nota: `${faltan} de ${enStripe} ${etiqueta} no quedaron registrados`,
  };
}
