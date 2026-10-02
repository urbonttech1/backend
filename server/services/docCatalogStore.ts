/**
 * El catálogo de documentos, leído de la tabla `document_catalog`.
 *
 * Las listas de `docCatalog.ts` siguen siendo la semilla y el respaldo: si la
 * tabla no existe todavía o la consulta falla, se responde con ellas en vez de
 * dejar a la app sin catálogo. Lo que la tabla añade es poder cambiar el
 * nombre, la categoría y —sobre todo— si un documento se le pide o no al
 * conductor, desde el panel y sin desplegar.
 *
 * `active = false` no borra nada: la clave sigue en `ACCEPTED_DOC_KEYS`, los
 * archivos ya subidos siguen ahí y el panel los sigue mostrando. Sólo deja de
 * pedirse y deja de contar para `pending_review`.
 */
import pino from 'pino';
import { supabaseAdmin } from '../db/client';
import { catalogoSemilla, catalogoSemillaValet, audienciaDeRol, type AudienciaCatalogo, type DocumentoCatalogo } from './docCatalog';

const log = pino({ level: 'info' });

export const TABLA_CATALOGO = 'document_catalog';
export const TABLA_CATALOGO_VALET = 'valet_document_catalog';

/** Cada audiencia tiene su tabla: conductores y valets se administran por separado. */
export function tablaCatalogo(audiencia: AudienciaCatalogo): string {
  return audiencia === 'valet' ? TABLA_CATALOGO_VALET : TABLA_CATALOGO;
}

/** Caché corta: el catálogo se pide en cada pantalla de documentos. */
const TTL_MS = 60_000;
const cache: Partial<Record<AudienciaCatalogo, { at: number; docs: DocumentoCatalogo[] }>> = {};

/** Tras escribir desde el panel, para que el cambio se vea sin esperar el TTL. */
export function invalidarCatalogo(audiencia?: AudienciaCatalogo): void {
  if (audiencia) delete cache[audiencia];
  else { delete cache.driver; delete cache.valet; }
}

type Fila = {
  doc_key: string; label: string; category: string; hint: string | null;
  expires: boolean | null; active: boolean | null; sort_order: number | null;
};

const deFila = (f: Fila): DocumentoCatalogo => ({
  key: f.doc_key,
  label: f.label,
  category: f.category,
  hint: f.hint ?? '',
  expires: !!f.expires,
  active: f.active !== false,
  sortOrder: f.sort_order ?? 0,
});

/** Todo el catálogo, activos e inactivos, en orden. Nunca lanza. */
export async function catalogoCompleto(audiencia: AudienciaCatalogo = 'driver'): Promise<DocumentoCatalogo[]> {
  const guardado = cache[audiencia];
  if (guardado && Date.now() - guardado.at < TTL_MS) return guardado.docs;

  try {
    const { data, error } = await supabaseAdmin
      .from(tablaCatalogo(audiencia))
      .select('doc_key, label, category, hint, expires, active, sort_order')
      .order('sort_order', { ascending: true });
    if (error) throw error;
    const docs = (data ?? []) as Fila[];
    if (docs.length === 0) throw new Error('catálogo vacío');
    const lista = docs.map(deFila);
    cache[audiencia] = { at: Date.now(), docs: lista };
    return lista;
  } catch (err: unknown) {
    // Sin tabla o sin base: se sigue con el catálogo del código.
    log.warn({ err: err instanceof Error ? err.message : String(err) }, `${tablaCatalogo(audiencia)} no disponible — se usa la semilla`);
    return audiencia === 'valet' ? catalogoSemillaValet() : catalogoSemilla();
  }
}

/** Los que se le piden hoy al conductor. Es contra esta lista que se le evalúa. */
export async function esquemaVigente(role?: string | null): Promise<readonly string[]> {
  return (await documentosVigentes(role)).map((d) => d.key);
}

/**
 * Metadatos de los activos, tal como los sirve `GET /required-docs`.
 *
 * El valet no conduce, así que tiene su propio catálogo —`valet_document_catalog`—
 * en vez de un recorte del del conductor: desactivar o editar un documento en
 * una pestaña del panel no afecta a la otra.
 */
export async function documentosVigentes(role?: string | null): Promise<DocumentoCatalogo[]> {
  return (await catalogoCompleto(audienciaDeRol(role))).filter((d) => d.active);
}
