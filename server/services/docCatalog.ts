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
 * El esquema contra el que se evalúa a un conductor.
 *
 * La regla es la lista global de diecisiete. La única excepción son los
 * esquemas anteriores YA COMPLETOS: hay conductores aprobados con los once del
 * alta móvil o con los once de limusina, y medirlos contra los diecisiete les
 * sacaría seis documentos «faltando» que nunca se les pidieron, devolviéndolos
 * a `pending_documents`.
 *
 * Quien los tiene a medias —incluido quien no ha subido nada— pasa a los
 * diecisiete: es la lista vigente y lo que ya pedía el alta web.
 */
export function elegirEsquema(clavesSubidas: readonly string[]): readonly string[] {
  const subidas = new Set(clavesSubidas);
  const completo = (lista: readonly string[]) => lista.every((k) => subidas.has(k));

  if (completo(ESQUEMA_GLOBAL)) return ESQUEMA_GLOBAL;
  // Aprobados bajo un esquema anterior: se respeta el suyo.
  if (completo(REQUIRED_DOC_KEYS)) return REQUIRED_DOC_KEYS;
  if (completo(LEGACY_DOC_KEYS)) return LEGACY_DOC_KEYS;
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
