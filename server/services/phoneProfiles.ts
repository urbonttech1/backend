/**
 * Un teléfono, dos cuentas.
 *
 * `profiles.phone` era único, así que la misma persona no podía tener su número
 * en su cuenta de pasajero y en la de conductor: al guardarlo en la segunda, el
 * backend lo descartaba y avisaba de que «ya está en otra cuenta». Casi nadie
 * tiene dos números, así que el perfil de conductor quedaba sin teléfono.
 *
 * Ahora la unicidad es por (teléfono, rol): un número puede estar en una cuenta
 * de pasajero y en una de conductor, pero no en dos del mismo tipo.
 *
 * El inicio de sesión no cambia: el conductor entra con correo y contraseña, y
 * el pasajero con el código al teléfono. Lo único que hace falta es que la
 * búsqueda por teléfono, que ahora puede encontrar dos perfiles, elija siempre
 * el mismo: el de pasajero, que es quien inicia sesión por esa vía.
 *
 * Reglas puras, sin base de datos, para poder probarlas.
 */

export interface PerfilPorTelefono {
  id: string;
  phone: string | null;
  role: string | null;
  created_at?: string | null;
}

/** `+573053001165`, `573053001165` — el número se guardó de las dos formas. */
export function variantesTelefono(phone: string): string[] {
  const sinMas = phone.replace(/^\+/, '');
  return Array.from(new Set([phone, sinMas, `+${sinMas}`]));
}

const esPasajero = (p: PerfilPorTelefono) => (p.role ?? 'passenger') === 'passenger';

/**
 * Cuál de los perfiles que comparten un número es el que inicia sesión por
 * teléfono. Gana el de pasajero; entre varios, el más antiguo, para que la
 * elección no cambie de una llamada a otra.
 */
export function elegirPerfilPorTelefono(perfiles: readonly PerfilPorTelefono[]): PerfilPorTelefono | null {
  if (perfiles.length === 0) return null;

  const antiguedad = (p: PerfilPorTelefono) => {
    const t = p.created_at ? Date.parse(p.created_at) : NaN;
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
  };

  return [...perfiles].sort((a, b) => {
    if (esPasajero(a) !== esPasajero(b)) return esPasajero(a) ? -1 : 1;
    return antiguedad(a) - antiguedad(b);
  })[0];
}
