/**
 * Cómo se nombra a un conductor en el panel.
 *
 * La pantalla de Documentos mostraba «Unknown Driver» porque leía
 * `driver_documents.driver_name`, una copia del nombre que se escribe al subir
 * cada documento. Si el perfil aún no tenía nombre en ese momento —alta con
 * Google, donde el nombre se completa después— la copia quedaba vacía para
 * siempre, aunque el perfil estuviera completo. Lo mismo si el conductor
 * corregía su nombre más tarde.
 *
 * Aquí manda el perfil, y lo demás son respaldos. Nunca devuelve una cadena
 * vacía: sin nombre, el administrador necesita algo con lo que identificarlo.
 *
 * Reglas puras, sin base de datos, para poder probarlas.
 */

export interface PerfilConductor {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface NombreConductorInput {
  /** El perfil, si se pudo cargar. Es la fuente buena. */
  perfil?: PerfilConductor | null;
  /** La copia guardada en el documento, de cuando se subió. */
  copia?: string | null;
  /** El id del conductor, para el último respaldo. */
  id?: string | null;
}

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * El «Driver ID» que el conductor ve en su cuenta: los primeros ocho caracteres
 * de su UUID. Mismo formato que `formatUrbontId` en la app y en el panel, para
 * que el administrador pueda cruzarlos.
 */
export function urbontId(uuid: unknown): string {
  const limpio = texto(uuid).replace(/-/g, '').toUpperCase().slice(0, 8);
  return limpio.length === 8 ? `URB-${limpio.slice(0, 4)}-${limpio.slice(4)}` : '';
}

/** Nombre y apellido del perfil, o cadena vacía si no hay ninguno. */
export function nombreDelPerfil(perfil?: PerfilConductor | null): string {
  if (!perfil) return '';
  return [texto(perfil.first_name), texto(perfil.last_name)].filter(Boolean).join(' ');
}

/** Con qué identificar al conductor, en orden de preferencia. */
export function nombreDeConductor({ perfil, copia, id }: NombreConductorInput): string {
  const delPerfil = nombreDelPerfil(perfil);
  if (delPerfil) return delPerfil;

  const guardado = texto(copia);
  if (guardado) return guardado;

  const correo = texto(perfil?.email);
  if (correo) return correo;

  const telefono = texto(perfil?.phone);
  if (telefono) return telefono;

  const corto = urbontId(id);
  return corto ? `Conductor ${corto}` : 'Conductor sin nombre';
}
