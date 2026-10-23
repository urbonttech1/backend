/**
 * URLs de los documentos del conductor, firmadas al leer.
 *
 * Antes se guardaba —y se servía— la URL *pública* del bucket
 * `chauffeur-docs`. Eso significaba que cualquiera con la clave anónima, que va
 * dentro de la app, podía listar el bucket y descargar licencias, seguros y
 * permisos TNC. Se comprobó: una descarga real de 7 KB sin más credencial que
 * esa clave.
 *
 * El arreglo es firmar en el momento de servir, como ya hacían
 * `incident-photos`, `valet-tax` y las fotos de limpieza. Así el bucket se
 * puede cerrar sin que el panel deje de ver los documentos.
 *
 * No se tocan las subidas ni se migra lo guardado: `storage_url` sigue
 * conteniendo lo de siempre y de ahí se deduce la ruta. Las filas viejas
 * —URL pública completa— y las nuevas funcionan igual.
 */

import { supabaseAdmin } from '../db/client';
import { createContextLogger } from '../lib/logger';
import { rutaPrivadaW9 } from './valetDocumentation';

const log = createContextLogger('DOC_URL');

export const BUCKET_DOCS = 'chauffeur-docs';
export const BUCKET_W9 = 'valet-tax';

/** Una hora: lo que ya usan el resto de documentos privados del panel. */
export const VALIDEZ_SEGUNDOS = 60 * 60;

export interface UbicacionDocumento {
  bucket: string;
  path: string;
}

/**
 * De lo guardado en `storage_url` a bucket y ruta.
 *
 * Acepta las tres formas que conviven en la base:
 *   · `valet-tax:ruta/x.pdf`  — el W-9, que ya se guardaba marcado
 *   · la URL pública completa — lo que guardan las subidas de hoy
 *   · una ruta pelada         — el respaldo cuando no se pudo formar la URL
 *
 * Devuelve `null` si no se reconoce, y entonces quien llama deja el valor tal
 * cual: más vale una URL que quizá no cargue que romper la pantalla entera.
 */
export function ubicacionDocumento(storageUrl: string | null | undefined): UbicacionDocumento | null {
  const v = typeof storageUrl === 'string' ? storageUrl.trim() : '';
  if (!v) return null;

  const w9 = rutaPrivadaW9(v);
  if (w9) return { bucket: BUCKET_W9, path: w9 };

  // .../storage/v1/object/public/<bucket>/<ruta>  — y también `/sign/` y
  // `/authenticated/`, por si alguna fila quedó guardada ya firmada.
  const m = v.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/?#]+)\/([^?#]+)/);
  if (m) {
    const path = decodeURIComponent(m[2]);
    return path ? { bucket: m[1], path } : null;
  }

  // Cualquier otra cosa con esquema no es nuestra: no se inventa una ruta.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return null;

  return { bucket: BUCKET_DOCS, path: v.replace(/^\/+/, '') };
}

/**
 * La URL con la que el panel puede abrir el documento.
 *
 * Nunca lanza: si firmar falla se devuelve lo guardado, que es como se
 * comportaba antes. Un documento que no carga es un problema; una pantalla de
 * documentos que revienta, uno mayor.
 */
export async function urlFirmadaDocumento(storageUrl: string | null | undefined): Promise<string | null> {
  const ubi = ubicacionDocumento(storageUrl);
  if (!ubi) return storageUrl ?? null;

  try {
    const { data, error } = await supabaseAdmin.storage
      .from(ubi.bucket)
      .createSignedUrl(ubi.path, VALIDEZ_SEGUNDOS);
    if (error) throw new Error(error.message);
    return data?.signedUrl ?? storageUrl ?? null;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), bucket: ubi.bucket },
      'no se pudo firmar el documento; se devuelve lo guardado',
    );
    return storageUrl ?? null;
  }
}

/**
 * Firma varios de una vez, conservando el orden.
 *
 * El panel lista decenas de documentos por pantalla y firmarlos en serie
 * añadía una ida y vuelta por cada uno.
 */
export async function urlesFirmadas(storageUrls: Array<string | null | undefined>): Promise<Array<string | null>> {
  return Promise.all(storageUrls.map(u => urlFirmadaDocumento(u)));
}
