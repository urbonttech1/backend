/**
 * Cuándo se le quita un viaje a un chofer por inactividad.
 *
 * El vigilante busca viajes «varados» y se los reasigna a otro. Decidía que un
 * chofer estaba inactivo si NO tenía posición guardada, y como las
 * actualizaciones de GPS estaban fallando —`driver_locations` quedó vacía— daba
 * por varados todos los viajes de más de cuatro minutos. El pasajero iba dentro
 * del coche y aun así su viaje volvía a «buscando»: veía «tu chofer canceló» y
 * lo mandaba a buscar otro, justo al terminar el trayecto.
 *
 * Ahora la ausencia de posición NO basta para quitarle un viaje en curso a
 * nadie: sin dato no se sabe si el chofer está parado o si el GPS no llega, y
 * con el pasajero a bordo equivocarse es mucho peor que esperar.
 *
 * Reglas puras, sin base de datos.
 */

/** Sin señal del chofer camino a recoger: se reasigna. */
export const MINUTOS_SIN_GPS_CONFIRMADO = 5;
/** Con el pasajero a bordo se espera bastante más. */
export const MINUTOS_SIN_GPS_EN_CURSO = 12;

export interface CandidatoVarado {
  id: string;
  driver_id: string;
  ride_status: string;
  /** Última posición conocida del chofer, en ISO. Ausente = nunca mandó. */
  ultimaPosicion?: string | null;
}

/**
 * ¿Hay que quitarle este viaje al chofer?
 *
 * - `confirmed` (va a recoger): sí, si su última posición es vieja, y también si
 *   nunca mandó ninguna: ahí el pasajero aún no está con él.
 * - `in_progress` (pasajero a bordo): sólo si SÍ hay posición y está vieja. Sin
 *   posición no se toca: puede ser el GPS, no el chofer.
 * - Cualquier otro estado: no.
 */
export function esViajeVarado(candidato: CandidatoVarado, ahora: Date): boolean {
  const posicion = candidato.ultimaPosicion ? Date.parse(candidato.ultimaPosicion) : NaN;
  const hayPosicion = Number.isFinite(posicion);

  if (candidato.ride_status === 'confirmed') {
    if (!hayPosicion) return true;
    return posicion <= ahora.getTime() - MINUTOS_SIN_GPS_CONFIRMADO * 60 * 1000;
  }

  if (candidato.ride_status === 'in_progress') {
    if (!hayPosicion) return false;
    return posicion <= ahora.getTime() - MINUTOS_SIN_GPS_EN_CURSO * 60 * 1000;
  }

  return false;
}

/** Los que hay que reasignar, de entre los candidatos que trae la consulta. */
export function viajesVarados(candidatos: readonly CandidatoVarado[], ahora: Date): CandidatoVarado[] {
  return candidatos.filter((c) => esViajeVarado(c, ahora));
}
