/**
 * Normaliza lo que la app manda a `POST /api/support/tickets`.
 *
 * Cada pantalla de la app arma el ticket a su manera: unas envían `message` y
 * otras `description`, varias sin `subject`, y con categorías que el esquema
 * original no admitía (`roadside_assistance`, `driver_support`, `phone`…). El
 * esquema las rechazaba con 400 y la app nunca miraba la respuesta, así que la
 * mayoría de sus pantallas —el SOS del conductor entre ellas— no guardaron un
 * solo ticket. Aquí se aceptan todas sin pedirle un cambio a la app.
 *
 * Función pura: sin base de datos, para poder probarla.
 */

export const CATEGORIAS = [
  'lost_item', 'driver_issue', 'billing', 'app_issue', 'safety',
  'roadside_assistance', 'support_chat', 'other',
  'pqrs_peticion', 'pqrs_queja', 'pqrs_reclamo', 'pqrs_sugerencia',
] as const;

export type Categoria = typeof CATEGORIAS[number];
export type Prioridad = 'low' | 'normal' | 'high' | 'urgent';

/** Lo que manda cada pantalla de la app, llevado a una categoría conocida. */
const ALIAS: Record<string, Categoria> = {
  lost_item: 'lost_item',
  lost_object: 'lost_item',
  driver_issue: 'driver_issue',
  billing: 'billing',
  payment_issue: 'billing',
  app_issue: 'app_issue',
  safety: 'safety',
  roadside_assistance: 'roadside_assistance',
  driver_support: 'support_chat',
  customer_support: 'support_chat',
  other: 'other',
};

/** Objetos perdidos: la pantalla manda el objeto como categoría. */
const OBJETOS = new Set(['phone', 'wallet', 'keys', 'bag', 'glasses', 'clothing']);

export const ETIQUETA_CATEGORIA: Record<Categoria, string> = {
  lost_item:           'Lost Item',
  driver_issue:        'Driver Issue',
  billing:             'Billing',
  app_issue:           'App Issue',
  safety:              'Safety',
  roadside_assistance: 'Roadside Assistance',
  support_chat:        'Support Chat',
  other:               'Other',
  pqrs_peticion:       'PQRS · Petición',
  pqrs_queja:          'PQRS · Queja',
  pqrs_reclamo:        'PQRS · Reclamo',
  pqrs_sugerencia:     'PQRS · Sugerencia',
};

const PRIORIDADES = new Set<string>(['low', 'normal', 'high', 'urgent']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TicketNormalizado {
  category: Categoria;
  subject: string;
  description: string;
  rideId: string | null;
  priority: Prioridad;
  /** Botón de emergencia: categoría `safety` con prioridad `urgent`. */
  esSOS: boolean;
}

export type ResultadoTicket =
  | { ok: true; ticket: TicketNormalizado }
  | { ok: false; error: string; errorCode: string; field: string };

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function normalizarTicket(body: Record<string, unknown>): ResultadoTicket {
  // `message` es el nombre que usan casi todas las pantallas de la app.
  const description = texto(body.description) || texto(body.message);
  if (!description) {
    return { ok: false, error: 'Please describe what happened.', errorCode: 'MISSING_DESCRIPTION', field: 'description' };
  }
  if (description.length > 3000) {
    return { ok: false, error: 'The description is too long (3000 characters max).', errorCode: 'DESCRIPTION_TOO_LONG', field: 'description' };
  }

  const prioridadPedida = texto(body.priority).toLowerCase();
  if (prioridadPedida && !PRIORIDADES.has(prioridadPedida)) {
    return { ok: false, error: 'priority must be low, normal, high or urgent.', errorCode: 'INVALID_PRIORITY', field: 'priority' };
  }
  const priority = (prioridadPedida || 'normal') as Prioridad;

  const rideEnviado = texto(body.ride_id) || texto(body.rideId);
  if (rideEnviado && !UUID.test(rideEnviado)) {
    return { ok: false, error: 'rideId is not a valid ride id.', errorCode: 'INVALID_RIDE_ID', field: 'rideId' };
  }
  // El SOS no manda el viaje como campo, sólo dentro del texto: «Ride ID: <uuid>».
  const rideEnTexto = description.match(/ride id:\s*([0-9a-f-]{36})/i)?.[1] ?? null;
  const rideId = rideEnviado || (rideEnTexto && UUID.test(rideEnTexto) ? rideEnTexto : null);

  const original = texto(body.category).toLowerCase();
  const esObjeto = OBJETOS.has(original);
  const category: Categoria = esObjeto ? 'lost_item' : (ALIAS[original] ?? 'other');

  let subject = texto(body.subject).slice(0, 150);
  if (!subject) {
    if (esObjeto) subject = `Lost item: ${original}`;
    // Una categoría que no se reconoce acaba en `other`: se conserva como asunto
    // para que el equipo de soporte sepa qué eligió el usuario.
    else if (category === 'other' && original && original !== 'other') subject = original.slice(0, 150);
    else subject = ETIQUETA_CATEGORIA[category];
  }

  return {
    ok: true,
    ticket: {
      category,
      subject,
      description,
      rideId,
      priority,
      esSOS: category === 'safety' && priority === 'urgent',
    },
  };
}

// ─── PQRS desde la web ───────────────────────────────────────────────────────
// Lo envía cualquiera, sin sesión: por eso se piden los datos de contacto y se
// valida todo aquí.

export const TIPOS_PQRS = ['peticion', 'queja', 'reclamo', 'sugerencia'] as const;
export type TipoPqrs = typeof TIPOS_PQRS[number];

/** Un reclamo pide algo concreto (reembolso, corrección): va antes en la cola. */
const PRIORIDAD_PQRS: Record<TipoPqrs, Prioridad> = {
  peticion: 'normal', queja: 'normal', reclamo: 'high', sugerencia: 'low',
};

export interface PqrsNormalizada {
  category: Categoria;
  tipo: TipoPqrs;
  name: string;
  email: string;
  phone: string | null;
  subject: string;
  description: string;
  priority: Prioridad;
}

export type ResultadoPqrs =
  | { ok: true; pqrs: PqrsNormalizada }
  | { ok: false; error: string; errorCode: string; field: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizarPqrs(body: Record<string, unknown>): ResultadoPqrs {
  const tipo = texto(body.type).toLowerCase() as TipoPqrs;
  const name = texto(body.name).slice(0, 255);
  const email = texto(body.email).toLowerCase().slice(0, 255);
  const phone = texto(body.phone).replace(/[^\d+]/g, '').slice(0, 20) || null;
  const description = texto(body.description).slice(0, 5000);
  const subject = texto(body.subject).slice(0, 150);

  const error = (msg: string, errorCode: string, field: string): ResultadoPqrs =>
    ({ ok: false, error: msg, errorCode, field });

  if (!TIPOS_PQRS.includes(tipo)) return error('Choose the type of request.', 'INVALID_TYPE', 'type');
  if (name.length < 2) return error('Enter your name.', 'INVALID_NAME', 'name');
  if (!EMAIL.test(email)) return error('Enter a valid email.', 'INVALID_EMAIL', 'email');
  if (description.length < 10) return error('Describe your request (at least 10 characters).', 'INVALID_DESCRIPTION', 'description');

  const category = `pqrs_${tipo}` as Categoria;
  return {
    ok: true,
    pqrs: {
      category, tipo, name, email, phone, description,
      subject: subject || ETIQUETA_CATEGORIA[category],
      priority: PRIORIDAD_PQRS[tipo],
    },
  };
}
