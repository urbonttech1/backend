/**
 * Catálogo de documentos de conductor — datos puros, sin base de datos.
 *
 * Vive aparte de `driverVerification.ts` por la misma razón que `pricing.ts` vive
 * aparte de `fareConfig.ts`: este módulo no importa nada, así que se puede probar
 * sin variables de entorno ni conexión. El otro es el que consulta y decide.
 *
 * Aquí están las listas de documentos, sus metadatos y la normalización de
 * estados. Nada de esto necesita saber qué hay en la base.
 */

/**
 * Los once documentos que piden hoy la app y el signup web
 * (ChauffeurRegistrationScreen.tsx y driver-signup.tsx). Este es el esquema
 * vigente: es el que recibe `POST /api/chauffeur/documents` en producción.
 */
export const REQUIRED_DOC_KEYS = [
  'license', 'photo', 'bgCheck', 'registration', 'insurance',
  'commercialInsurance', 'inspection', 'tncPermit', 'defensiveDriving',
  'w9', 'drugTest',
] as const;

/**
 * Esquema anterior, de licencia de limusina. Hay conductores con estos once
 * documentos ya aprobados, así que se sigue aceptando y se sigue considerando
 * un alta completa; simplemente ya no se le pide a nadie nuevo.
 */
export const LEGACY_DOC_KEYS = [
  'limoPermit', 'airportPermit', 'inspection', 'portPermit',
  'insurance', 'registration', 'corpFiles', 'w9', 'taxId',
  'license', 'photo',
] as const;

/**
 * ESQUEMA VIGENTE: los diecisiete documentos que se le piden a todo conductor
 * nuevo, venga del alta web (websitev2, src/lib/driver-documents.ts) o de la
 * app. Une los permisos de Miami-Dade del esquema de limusina con los federales
 * del anterior, y suma `businessTaxes` y `backgroundCheck`.
 *
 * Antes el alta móvil pedía once y la web diecisiete, así que un mismo
 * conductor veía una lista distinta según por dónde se hubiera dado de alta.
 * La lista es una sola y global: `elegirEsquema` sólo conserva un esquema
 * anterior a quien ya lo completó, para no devolver a `pending_documents` a
 * conductores que ya estaban aprobados.
 */
export const WEB_DOC_KEYS = [
  'license', 'photo', 'bgCheck', 'registration', 'insurance',
  'commercialInsurance', 'inspection', 'airportPermit', 'portPermit',
  'limoPermit', 'tncPermit', 'w9', 'businessTaxes', 'corpFiles',
  'taxId', 'drugTest', 'backgroundCheck',
] as const;

/** Todo lo que se admite subir, sin importar el esquema. */
export const ACCEPTED_DOC_KEYS = [
  ...new Set<string>([...REQUIRED_DOC_KEYS, ...LEGACY_DOC_KEYS, ...WEB_DOC_KEYS]),
] as readonly string[];

export type DocKey =
  | typeof REQUIRED_DOC_KEYS[number]
  | typeof LEGACY_DOC_KEYS[number]
  | typeof WEB_DOC_KEYS[number];

/* ── Catálogo de documentos ────────────────────────────────────────────────
 *
 * La etiqueta, la categoría y la ayuda de cada documento vivían SÓLO en el
 * código de la app, duplicadas en dos pantallas que no coincidían: el registro
 * pedía once y Cuenta → Documentos otros once, con seis claves en común y un
 * `insurance` que significaba cosas distintas en cada sitio.
 *
 * Aquí están una sola vez, y `GET /api/chauffeur/required-docs` las sirve. Que
 * la lista viva en el servidor es lo que permite cambiarla —o partirla por
 * país— sin publicar una versión de la app.
 *
 * `expires` marca los que caducan: son los que llevan `expiryDate` al subirlos
 * y los que vigila el cron de vencimientos.
 */
export interface DocMeta {
  key:      string;
  label:    string;
  category: string;
  hint:     string;
  expires:  boolean;
}

/*
 * Nombres, ayudas y categorías iguales a los del alta web
 * (websitev2/src/lib/driver-documents.ts), que son los acordados con el cliente.
 * Antes aquí seguían los anteriores —«Personal Auto Insurance», «TNC / Chauffeur
 * Permit»—, y la app, que lee de este catálogo, llamaba a un mismo documento de
 * forma distinta que la web. Si se cambia un nombre, hay que cambiarlo en los dos.
 *
 * `defensiveDriving` no está en la web: ya no se le pide a nadie nuevo, pero
 * sigue en el esquema del alta móvil y conserva su nombre.
 */
export const DOC_CATALOG: Record<string, Omit<DocMeta, 'key'>> = {
  // Identidad
  license:             { label: "Driver's License",                   category: 'Personal Identity',        hint: 'Front & back, clearly visible',              expires: true  },
  photo:               { label: 'Profile Photo',                      category: 'Personal Identity',        hint: 'Professional headshot, no sunglasses',       expires: false },
  bgCheck:             { label: 'Background Check Consent',           category: 'Personal Identity',        hint: 'Signed authorization form',                  expires: false },

  // Vehículo, incluidos los permisos de condado
  registration:        { label: 'Vehicle Registration',               category: 'Vehicle Documents',        hint: 'Proof of ownership, must match vehicle',     expires: true  },
  insurance:           { label: 'Auto Insurance Identification Card', category: 'Vehicle Documents',        hint: 'Current card, FL state minimum',             expires: true  },
  commercialInsurance: { label: 'Commercial Auto Insurance',          category: 'Vehicle Documents',        hint: 'Required for TNC operations in FL',          expires: true  },
  inspection:          { label: 'Vehicle Inspection',                 category: 'Vehicle Documents',        hint: 'Annual safety inspection certificate',       expires: true  },
  airportPermit:       { label: 'Miami-Dade Airport Permit',          category: 'Vehicle Documents',        hint: 'Required to pick up at MIA',                 expires: true  },
  portPermit:          { label: 'Port of Miami Permit',               category: 'Vehicle Documents',        hint: 'Required to pick up at PortMiami',           expires: true  },
  limoPermit:          { label: 'Miami-Dade Limousine Sticker',       category: 'Vehicle Documents',        hint: 'Current county limousine decal',             expires: true  },

  // Credenciales profesionales
  tncPermit:           { label: 'Chauffeur License',                  category: 'Professional Credentials', hint: 'Miami-Dade County, current',                 expires: true  },
  defensiveDriving:    { label: 'Defensive Driving Cert.',            category: 'Professional Credentials', hint: 'Completed within last 3 years',              expires: true  },

  // Legal y empresa
  w9:                  { label: 'Tax Form W-9',                       category: 'Legal & Compliance',       hint: 'Required for IRS reporting',                 expires: false },
  businessTaxes:       { label: 'Local Business Taxes',               category: 'Legal & Compliance',       hint: 'Most recent business tax return',            expires: false },
  corpFiles:           { label: 'Corporation Certificate',            category: 'Legal & Compliance',       hint: 'Certificate of incorporation',               expires: false },
  taxId:               { label: 'Corporation Tax ID',                 category: 'Legal & Compliance',       hint: 'EIN confirmation letter from the IRS',       expires: false },
  drugTest:            { label: 'Drug Test Results',                  category: 'Legal & Compliance',       hint: 'FMCSA 10-panel test, within 30 days',        expires: true  },
  backgroundCheck:     { label: 'Background Check',                   category: 'Legal & Compliance',       hint: 'Completed report from an approved provider', expires: true  },
};

/** Los diecisiete de hoy: la lista que se le pide a todo el mundo. */
export const ESQUEMA_GLOBAL = WEB_DOC_KEYS;

/**
 * El esquema contra el que se evalúa a un conductor: los diecisiete, para todo
 * el mundo.
 *
 * Hasta ahora había tres listas vivas y se elegía una según lo que cada
 * conductor tuviera subido, así que dos personas veían requisitos distintos —el
 * alta móvil pedía once y la web diecisiete—. Con el proyecto todavía en
 * desarrollo se unifica: una sola lista, sin excepciones por esquema anterior.
 *
 * `REQUIRED_DOC_KEYS` y `LEGACY_DOC_KEYS` siguen existiendo porque describen lo
 * que se pidió en su día y sus claves siguen en `ACCEPTED_DOC_KEYS`, así que
 * nada de lo ya subido se rechaza ni se pierde.
 *
 * Efecto en quien completó un esquema de once: la próxima vez que se recalcule
 * su verificación —al subir un documento o al revisarlo un admin— le van a
 * faltar los seis que no tenía, y pasará a `pending_documents` hasta subirlos.
 *
 * Recibe las claves subidas por compatibilidad con quien la llama; ya no las usa.
 */
export function elegirEsquema(_clavesSubidas: readonly string[] = []): readonly string[] {
  return ESQUEMA_GLOBAL;
}

/** Metadatos de un documento, con un respaldo razonable si la clave es nueva. */
export function docMeta(key: string): DocMeta {
  const m = DOC_CATALOG[key];
  return m
    ? { key, ...m }
    : { key, label: key, category: 'Other', hint: '', expires: false };
}

export type VerificationStatus =
  | 'pending_documents'  // faltan documentos, o falta el vehículo
  | 'pending_review'     // están todos, esperan revisión del admin
  | 'rejected'           // al menos uno rechazado
  | 'approved';          // todos aprobados y vehículo cargado

/**
 * `driver_documents` guarda el mismo estado con dos palabras, 'valid' y
 * 'approved', según por qué ruta se haya escrito. Contar solo una de las dos
 * hacía que la aprobación automática no se disparara nunca para quien tuviera
 * la otra.
 */
export function normalizarEstadoDoc(estado: unknown): 'aprobado' | 'rechazado' | 'pendiente' {
  const s = String(estado);
  if (s === 'valid' || s === 'approved') return 'aprobado';
  if (s === 'rejected') return 'rechazado';
  return 'pendiente';
}

/* ── Catálogo administrable ────────────────────────────────────────────────
 *
 * El catálogo de arriba es la semilla. A partir de la migración vive en la tabla
 * `document_catalog`, que el panel administra: nombre, categoría, ayuda, si
 * caduca, el orden y —sobre todo— si se le pide o no al conductor.
 *
 * `docCatalogStore.ts` es quien lee esa tabla; aquí sólo van las reglas puras.
 */

/** Documentos que no se le piden al conductor cuando se siembra la tabla. */
export const DESACTIVADOS_INICIALES = ['bgCheck', 'backgroundCheck', 'defensiveDriving'] as const;

export interface DocumentoCatalogo extends DocMeta {
  /** false: sigue aceptándose si ya está subido, pero no se le pide a nadie. */
  active: boolean;
  sortOrder: number;
}

/** La semilla: el catálogo del código, en el orden del esquema vigente. */
export function catalogoSemilla(): DocumentoCatalogo[] {
  const orden = [...ESQUEMA_GLOBAL, ...Object.keys(DOC_CATALOG).filter((k) => !ESQUEMA_GLOBAL.includes(k as never))];
  return orden.map((key, i) => ({
    ...docMeta(key),
    active: ESQUEMA_GLOBAL.includes(key as never) && !(DESACTIVADOS_INICIALES as readonly string[]).includes(key),
    sortOrder: (i + 1) * 10,
  }));
}

export interface ErrorCampo { errorCode: string; field: string; error: string }

const CATEGORIAS_CONOCIDAS = [
  'Personal Identity', 'Vehicle Documents', 'Professional Credentials', 'Legal & Compliance', 'Other',
];
export { CATEGORIAS_CONOCIDAS };

const CLAVE_VALIDA = /^[a-zA-Z][a-zA-Z0-9]{1,39}$/;

/**
 * Lo que manda el panel al crear o editar un documento. En una edición, los
 * campos que no llegan no se tocan (`undefined`), así que el panel puede mandar
 * sólo `active` para activar o desactivar.
 */
export function normalizarDocumentoAdmin(
  body: Record<string, unknown>,
  opciones: { nuevo?: boolean } = {},
): { doc: Partial<DocumentoCatalogo> & { key?: string } } | ErrorCampo {
  const doc: Partial<DocumentoCatalogo> & { key?: string } = {};

  if (opciones.nuevo) {
    const key = String(body.key ?? '').trim();
    if (!CLAVE_VALIDA.test(key)) {
      return { errorCode: 'INVALID_KEY', field: 'key', error: 'La clave debe ser alfanumérica, sin espacios, de 2 a 40 caracteres.' };
    }
    doc.key = key;
  }

  if (body.label !== undefined || opciones.nuevo) {
    const label = String(body.label ?? '').trim();
    if (label.length < 2 || label.length > 80) {
      return { errorCode: 'INVALID_LABEL', field: 'label', error: 'El nombre debe tener entre 2 y 80 caracteres.' };
    }
    doc.label = label;
  }

  if (body.category !== undefined || opciones.nuevo) {
    const category = String(body.category ?? '').trim();
    if (category.length < 2 || category.length > 60) {
      return { errorCode: 'INVALID_CATEGORY', field: 'category', error: 'La categoría debe tener entre 2 y 60 caracteres.' };
    }
    doc.category = category;
  }

  if (body.hint !== undefined) {
    const hint = String(body.hint ?? '').trim();
    if (hint.length > 200) {
      return { errorCode: 'INVALID_HINT', field: 'hint', error: 'La ayuda no puede pasar de 200 caracteres.' };
    }
    doc.hint = hint;
  }

  for (const campo of ['expires', 'active'] as const) {
    if (body[campo] !== undefined) {
      const v = body[campo];
      if (typeof v !== 'boolean' && v !== 'true' && v !== 'false') {
        return { errorCode: 'INVALID_FLAG', field: campo, error: `El campo ${campo} tiene que ser verdadero o falso.` };
      }
      doc[campo] = v === true || v === 'true';
    }
  }

  if (body.sortOrder !== undefined) {
    const n = Number(body.sortOrder);
    if (!Number.isFinite(n) || n < 0 || n > 9999) {
      return { errorCode: 'INVALID_SORT_ORDER', field: 'sortOrder', error: 'El orden tiene que ser un número entre 0 y 9999.' };
    }
    doc.sortOrder = Math.round(n);
  }

  if (Object.keys(doc).length === 0) {
    return { errorCode: 'NOTHING_TO_UPDATE', field: '', error: 'No llegó ningún campo para actualizar.' };
  }
  return { doc };
}
