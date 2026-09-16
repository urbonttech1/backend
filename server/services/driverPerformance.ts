/**
 * Métricas de la pantalla Performance del conductor (`GET /api/drivers/stats`).
 *
 * Funciones puras: reciben lo que ya se leyó de la base y devuelven el número.
 * Así se prueban sin base, y el endpoint sólo se ocupa de leer.
 */

/** Un viaje que hoy figura a nombre del conductor en `rides`. */
export interface ViajeAsignado {
  id: string;
  created_at: string;
  /** Valoración que dio el pasajero, de 1 a 5. */
  rating?: number | string | null;
}

/** Un evento del conductor sobre un viaje, tal como lo guarda `driver_ride_events`. */
export interface EventoConductor {
  ride_id: string;
  event: string;
  created_at: string;
}

/** Eventos de un viaje que el conductor aceptó y después soltó. */
const LIBERACIONES = new Set(['driver_cancelled', 'reassigned']);

const ms = (fecha: string): number => {
  const n = Date.parse(fecha);
  return Number.isFinite(n) ? n : 0;
};

/** Guarda la fecha más reciente de cada viaje. */
function anotar(mapa: Map<string, number>, id: string, fecha: string): void {
  const t = ms(fecha);
  const previa = mapa.get(id);
  if (previa === undefined || t > previa) mapa.set(id, t);
}

/**
 * Los viajes que el conductor aceptó. Salen de dos sitios y hay que unirlos:
 *   - `rides` con su driver_id: los que conserva, incluido el que abandonó en
 *     curso, que se cancela pero mantiene el driver_id.
 *   - `driver_ride_events`: los que soltó antes de empezar. Al cancelarlos vuelven
 *     a `searching` sin driver_id, así que en `rides` ya no figuran a su nombre.
 *
 * Un viaje que aparece en los dos sitios se cuenta una sola vez. Los rechazos no
 * entran: un viaje rechazado nunca se aceptó.
 */
function viajesAceptados(asignados: ViajeAsignado[], eventos: EventoConductor[]): Map<string, number> {
  const aceptados = new Map<string, number>();
  for (const v of asignados) anotar(aceptados, v.id, v.created_at);
  for (const e of eventos) if (LIBERACIONES.has(e.event)) anotar(aceptados, e.ride_id, e.created_at);
  return aceptados;
}

/** Los ids de los `ventana` viajes más recientes. */
function masRecientes(mapa: Map<string, number>, ventana: number): Set<string> {
  return new Set(
    [...mapa.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, ventana)
      .map(([id]) => id),
  );
}

/**
 * Porcentaje de viajes aceptados que el propio conductor canceló, sobre los
 * `ventana` más recientes. `null` si todavía no aceptó ninguno.
 *
 * Una reasignación del sistema cuenta como viaje aceptado pero no como
 * cancelación: no la decidió el conductor.
 */
export function tasaDeCancelacion(
  asignados: ViajeAsignado[],
  eventos: EventoConductor[],
  ventana = 500,
): number | null {
  const recientes = masRecientes(viajesAceptados(asignados, eventos), ventana);
  if (recientes.size === 0) return null;

  const cancelados = new Set(
    eventos
      .filter(e => e.event === 'driver_cancelled' && recientes.has(e.ride_id))
      .map(e => e.ride_id),
  );
  return Math.round((cancelados.size / recientes.size) * 100);
}

/**
 * Porcentaje de ofertas que el conductor aceptó entre las que aceptó o rechazó,
 * sobre las `ventana` decisiones más recientes. `null` si todavía no decidió
 * ninguna.
 *
 * Una oferta que otro conductor tomó antes de que éste respondiera no cuenta:
 * con el despacho por oleadas pasa a menudo y no dice nada de él.
 *
 * Los rechazos sólo se guardan por viaje desde que `/reject-ride` los registra;
 * los anteriores no se pueden recuperar.
 */
export function tasaDeAceptacion(
  asignados: ViajeAsignado[],
  eventos: EventoConductor[],
  ventana = 500,
): number | null {
  const aceptados = viajesAceptados(asignados, eventos);
  const decisiones = new Map(aceptados);
  for (const e of eventos) {
    // Un viaje que rechazó y más tarde aceptó cuenta como aceptado.
    if (e.event === 'rejected' && !aceptados.has(e.ride_id)) anotar(decisiones, e.ride_id, e.created_at);
  }

  const recientes = masRecientes(decisiones, ventana);
  if (recientes.size === 0) return null;

  let aceptadas = 0;
  for (const id of recientes) if (aceptados.has(id)) aceptadas++;
  return Math.round((aceptadas / recientes.size) * 100);
}

/**
 * Media de las valoraciones que dieron los pasajeros en estos viajes, con dos
 * decimales. `null` si no hay ninguna: se muestra «—» antes que un 5,0 sin
 * ninguna valoración detrás.
 */
export function valoracionMedia(viajes: ViajeAsignado[]): number | null {
  const notas = viajes
    .map(v => (v.rating === null || v.rating === undefined ? NaN : Number(v.rating)))
    .filter(n => Number.isFinite(n) && n >= 1 && n <= 5);
  if (notas.length === 0) return null;

  const media = notas.reduce((suma, n) => suma + n, 0) / notas.length;
  return Math.round(media * 100) / 100;
}
