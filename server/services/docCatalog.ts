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
 * Esquema del signup web nuevo (websitev2, src/lib/driver-documents.ts): los
 * diecisiete que pide hoy /conductor. Une los permisos de Miami-Dade del
 * esquema de limusina con los federales del vigente, y suma dos claves que no
 * existían: `businessTaxes` y `backgroundCheck`.
 *
 * Sin esta lista, un conductor que completara el formulario web quedaba con
 * `defensiveDriving` faltando para siempre — ya no se le pide a nadie — y sus
 * dos documentos nuevos se rechazaban al subir por no estar en ACCEPTED.
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

export const DOC_CATALOG: Record<string, Omit<DocMeta, 'key'>> = {
  // Los once del alta móvil
  license:             { label: "Driver's License",           category: 'Personal Identity',       hint: 'Front & back, clearly visible',            expires: true  },
  photo:               { label: 'Profile Photo',              category: 'Personal Identity',       hint: 'Professional headshot, no sunglasses',     expires: false },
  bgCheck:             { label: 'Background Check Consent',   category: 'Personal Identity',       hint: 'Signed authorization form',                expires: false },
  registration:        { label: 'Vehicle Registration',       category: 'Vehicle Documents',       hint: 'Proof of ownership, must match vehicle',   expires: true  },
  insurance:           { label: 'Personal Auto Insurance',    category: 'Vehicle Documents',       hint: 'Current policy, state minimum',            expires: true  },
  commercialInsurance: { label: 'Commercial Auto Insurance',  category: 'Vehicle Documents',       hint: 'Required for TNC operations',              expires: true  },
  inspection:          { label: 'Vehicle Inspection',         category: 'Vehicle Documents',       hint: 'Annual safety inspection certificate',     expires: true  },
  tncPermit:           { label: 'TNC / Chauffeur Permit',     category: 'Professional Credentials',hint: 'State or local authority permit',          expires: true  },
  defensiveDriving:    { label: 'Defensive Driving Cert.',    category: 'Professional Credentials',hint: 'Completed within last 3 years',            expires: true  },
  w9:                  { label: 'Tax Form W-9',               category: 'Legal & Compliance',      hint: 'Required for IRS reporting',               expires: false },
  drugTest:            { label: 'Drug Test Results',          category: 'Legal & Compliance',      hint: '10-panel test, within 30 days',            expires: true  },

  // Permisos de condado — esquema de limusina y signup web
  limoPermit:          { label: 'Limousine Sticker',          category: 'Local Permits',           hint: 'Miami-Dade limousine sticker',             expires: true  },
  airportPermit:       { label: 'Airport Permit',             category: 'Local Permits',           hint: 'MIA airport access permit',                expires: true  },
  portPermit:          { label: 'Port Permit',                category: 'Local Permits',           hint: 'Port of Miami access permit',              expires: true  },

  // Empresa
  corpFiles:           { label: 'Company Documents',          category: 'Legal & Compliance',      hint: 'Incorporation or LLC filing',              expires: false },
  taxId:               { label: 'Tax ID',                     category: 'Legal & Compliance',      hint: 'EIN or equivalent',                        expires: false },
  businessTaxes:       { label: 'Business Tax Filing',        category: 'Legal & Compliance',      hint: 'Most recent filing',                       expires: false },
  backgroundCheck:     { label: 'Background Check Report',    category: 'Personal Identity',       hint: 'Third-party report',                       expires: true  },
};

/**
 * El esquema contra el que se evalúa a un conductor, según lo que ya subió.
 *
 * Hay tres listas vivas a la vez y sólo comparten una parte de los nombres, así
 * que medir a todo el mundo contra una sola dejaría a media plantilla con
 * documentos «faltando» que nunca se le pidieron.
 *
 * Se compara por PROPORCIÓN cubierta, no por número de claves. Contando claves,
 * un conductor con el esquema de limusina completo (11 de 11) empataba con las 11
 * que ese mismo esquema cubre del web, y al desempatar hacia el web le aparecían
 * seis documentos faltantes: conductores ya aprobados volvían a
 * `pending_documents`. La proporción da 1.0 al esquema que sí completó. A igualdad
 * gana el que cubre más claves, que es el más específico de los dos.
 *
 * Con la lista vacía —un conductor que no ha subido nada— devuelve el esquema del
 * alta móvil, que es lo que se le va a pedir.
 */
export function elegirEsquema(clavesSubidas: readonly string[]): readonly string[] {
  const subidas = new Set(clavesSubidas);
  if (subidas.size === 0) return REQUIRED_DOC_KEYS;

  const cubiertos = (lista: readonly string[]) => lista.filter((k) => subidas.has(k)).length;

  return [WEB_DOC_KEYS, REQUIRED_DOC_KEYS, LEGACY_DOC_KEYS]
    .map((lista) => ({ lista, n: cubiertos(lista) }))
    .sort((a, b) => (b.n / b.lista.length) - (a.n / a.lista.length) || b.n - a.n)[0].lista;
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
