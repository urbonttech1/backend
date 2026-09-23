/**
 * Cuánto se busca otro chofer tras una cancelación del que ya había aceptado.
 *
 * Cuando un chofer cancela un viaje que aún no había empezado, el viaje no se le
 * cancela al pasajero: vuelve a «buscando» y se le ofrece a otro
 * (api/rides/cancel.ts). Si nadie lo toma, el pasajero se quedaba esperando sin
 * final: la única red era el trabajo que cancela los viajes con más de DOS HORAS
 * buscando, pensado para limpiar viajes viejos, no para esto.
 *
 * Aquí está el plazo y a quién se le acabó. Reglas puras, sin base de datos.
 */

/** Minutos que se busca un reemplazo antes de rendirse y cancelar. */
export const MINUTOS_PARA_REEMPLAZO = 2;

export interface ViajeEnReasignacion {
  id: string;
  /** Cuándo quedó buscando reemplazo, en ISO. */
  reassigning_since?: string | null;
  ride_status?: string | null;
  driver_id?: string | null;
}

/** El instante a partir del cual un viaje en reasignación ya venció. */
export function limiteDeReasignacion(ahora: Date, minutos = MINUTOS_PARA_REEMPLAZO): Date {
  return new Date(ahora.getTime() - minutos * 60 * 1000);
}

/**
 * Los viajes a los que se les acabó el plazo: siguen buscando, sin chofer, y
 * llevan más del plazo desde que el anterior canceló. Un viaje que ya encontró
 * chofer, o que nunca estuvo en reasignación, no se toca.
 */
export function reasignacionesVencidas(
  viajes: readonly ViajeEnReasignacion[],
  ahora: Date,
  minutos = MINUTOS_PARA_REEMPLAZO,
): ViajeEnReasignacion[] {
  const limite = limiteDeReasignacion(ahora, minutos).getTime();
  return viajes.filter((v) => {
    if (v.ride_status !== 'searching') return false;
    if (v.driver_id) return false;
    const desde = v.reassigning_since ? Date.parse(v.reassigning_since) : NaN;
    if (!Number.isFinite(desde)) return false;
    return desde <= limite;
  });
}
