/**
 * El teléfono del perfil.
 *
 * El pasajero inicia sesión con un código por SMS y la cuenta se busca por
 * `profiles.phone` (ver getOrCreateSupabaseUser). Si se pudiera guardar un
 * número sin demostrar que es propio, alguien podría poner el de otra persona
 * en su cuenta: cuando esa persona entrara con su número, lo haría en la cuenta
 * ajena, con sus tarjetas, y el dueño vería sus viajes.
 *
 * Por eso el pasajero lo añade o lo cambia en POST /api/users/phone, con el
 * código enviado a ese número, y PATCH /api/users/profile no se lo cambia.
 * Conductores y valets entran con correo y contraseña: su teléfono es solo de
 * contacto y siguen editándolo como hasta ahora.
 *
 * Reglas puras, sin base de datos, para poder probarlas.
 */

/** Si este rol puede cambiar el teléfono sin verificarlo (PATCH /profile). */
export function cambiaTelefonoSinCodigo(role: string | null | undefined): boolean {
  return (role || 'passenger') !== 'passenger';
}

/**
 * Si el número ya es de otra cuenta del mismo tipo. La unicidad es por
 * (teléfono, rol): el mismo número puede estar en la cuenta de pasajero y en la
 * de conductor de una persona, pero no en dos de pasajero.
 */
export function numeroEnOtraCuenta(
  perfiles: readonly { id: string; role: string | null }[],
  uid: string,
  role: string | null | undefined,
): boolean {
  const mio = role || 'passenger';
  return perfiles.some(p => p.id !== uid && (p.role || 'passenger') === mio);
}
