/**
 * Los viajes que el chofer se ganó y todavía no ha cobrado.
 *
 * Cuando un viaje se cobra al pasajero pero el chofer aún no tiene Connect
 * activo, `pagarChoferPorViaje` deja escrito `driver_earnings` y no transfiere.
 * La única cosa que recuperaba ese dinero era el webhook `account.updated`, y
 * ese webhook no llegaba: el endpoint de Stripe no estaba suscrito al evento.
 * Se quedaron viajes cobrados al pasajero cuyo chofer nunca vio un centavo.
 *
 * Esto lo arregla sin depender de ningún webhook: se repasan los viajes con
 * deuda, se comprueba contra Stripe si el chofer ya puede cobrar y se paga.
 * Corre en el cron y también lo llama el webhook cuando sí llega, que entonces
 * sólo adelanta el momento.
 *
 * La parte que decide qué se debe es pura y está probada; la que mueve dinero
 * va al final.
 */

/** Un viaje con deuda pendiente, tal como sale de la base. */
export interface ViajePendiente {
  id: string;
  driver_id: string | null;
  driver_earnings: number | string | null;
}

/** Lo que hay que pagarle a un chofer, ya agrupado. */
export interface DeudaChofer {
  driverId: string;
  viajes: Array<{ id: string; centavos: number }>;
  totalCentavos: number;
}

/**
 * Lo que se le debe por un viaje, en centavos.
 * Lo que no sea un importe positivo no se paga: cero, nulo o basura.
 */
export function centavosDeViaje(earnings: unknown): number {
  const n = typeof earnings === 'number' ? earnings : Number(earnings);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

/**
 * Agrupa la deuda por chofer.
 *
 * Se agrupa para consultar a Stripe una vez por chofer y no una por viaje: un
 * chofer con quince viajes atrasados no debe costar quince llamadas.
 */
export function agruparDeuda(viajes: ViajePendiente[]): DeudaChofer[] {
  const porChofer = new Map<string, DeudaChofer>();

  for (const v of viajes) {
    const driverId = typeof v.driver_id === 'string' ? v.driver_id.trim() : '';
    if (!driverId) continue;
    const centavos = centavosDeViaje(v.driver_earnings);
    if (centavos <= 0) continue;

    const actual = porChofer.get(driverId) ?? { driverId, viajes: [], totalCentavos: 0 };
    actual.viajes.push({ id: v.id, centavos });
    actual.totalCentavos += centavos;
    porChofer.set(driverId, actual);
  }

  return [...porChofer.values()];
}
