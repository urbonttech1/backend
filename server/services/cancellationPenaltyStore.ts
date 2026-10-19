/**
 * Guarda y consulta las penalidades por soltar una reserva.
 *
 * Las reglas viven en `cancellationPenalty.ts`, que no toca la base. Aquí está
 * lo que habla con Supabase: registrar la penalidad al cancelar, listarla para
 * el panel y saldarla cuando se descuenta de las ganancias.
 *
 * Registrar NO interrumpe la cancelación. Si la base falla, el chofer igual
 * suelta la reserva y el pasajero igual recibe otro coche: dejar a alguien
 * atrapado en una pantalla porque no se pudo escribir una fila sería peor. El
 * fallo se registra como error —es dinero— y el panel lo verá como una
 * cancelación sin penalidad asociada.
 *
 * Contra el doble cobro no hay lógica aquí: lo impide el índice único
 * `(ride_id, driver_id)` de la tabla. Dos peticiones de cancelación a la vez
 * insertan una sola fila.
 */

import { supabaseAdmin } from '../db/client';
import { createContextLogger } from '../lib/logger';
import { calcularPenalidad, penalizacionActiva, type Penalidad } from './cancellationPenalty';

const log = createContextLogger('CANCEL_PENALTY');
const TABLE = 'driver_cancellation_penalties';

export interface CancelacionDeChofer {
  rideId: string;
  driverId: string;
  /** `rides.accepted_at`, leído ANTES de liberar la reserva: la liberación lo borra. */
  acceptedAt: string | Date | null | undefined;
  scheduledAt: string | Date | null | undefined;
  /** `rides.locked_fare ?? rides.fare`. */
  valorReserva: number | string | null | undefined;
  /** Lo que escribió el chofer al cancelar, si escribió algo. */
  nota?: string | null;
}

/** Lo que se le devuelve a la app para que se lo enseñe al chofer. */
export interface PenalidadRegistrada extends Penalidad {
  /** `false` si el cálculo salió pero la fila no se pudo guardar. */
  guardada: boolean;
}

/**
 * Calcula la penalidad y la deja escrita. Devuelve `null` si la penalización
 * está apagada por configuración.
 *
 * Una penalidad de cero también se guarda: el panel tiene que poder enseñar que
 * la cancelación existió y por qué no costó nada. Se guarda como `waived` para
 * que el cobro no la mire siquiera.
 */
export async function registrarPenalidad(c: CancelacionDeChofer): Promise<PenalidadRegistrada | null> {
  if (!penalizacionActiva()) return null;

  const canceladaEn = new Date().toISOString();
  const penalidad = calcularPenalidad(
    { aceptadaEn: c.acceptedAt, canceladaEn, servicioEn: c.scheduledAt },
    c.valorReserva,
  );

  const fila = {
    ride_id:              c.rideId,
    driver_id:            c.driverId,
    accepted_at:          c.acceptedAt ? new Date(c.acceptedAt).toISOString() : null,
    cancelled_at:         canceladaEn,
    scheduled_at:         c.scheduledAt ? new Date(c.scheduledAt).toISOString() : null,
    minutes_to_service:   penalidad.minutosHastaServicio,
    minutes_since_accept: penalidad.minutosDesdeAceptacion,
    ride_value:           Number(c.valorReserva) || 0,
    percentage:           penalidad.porcentaje,
    amount:               penalidad.importe,
    reason:               penalidad.motivo,
    status:               penalidad.importe > 0 ? 'recorded' : 'waived',
    notes:                c.nota ?? null,
  };

  try {
    const { error } = await supabaseAdmin
      .from(TABLE)
      .upsert(fila, { onConflict: 'ride_id,driver_id', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    return { ...penalidad, guardada: true };
  } catch (err) {
    // A propósito no se relanza: ver la cabecera del módulo.
    log.error(
      { rideId: c.rideId, driverId: c.driverId, importe: penalidad.importe, err: err instanceof Error ? err.message : String(err) },
      'penalidad calculada pero NO guardada',
    );
    return { ...penalidad, guardada: false };
  }
}

/** Lo que un chofer debe y aún no se le ha descontado, lo más viejo primero. */
export async function penalidadesPendientes(driverId: string): Promise<Array<{ id: string; amount: number }>> {
  try {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .select('id, amount')
      .eq('driver_id', driverId)
      .eq('status', 'recorded')
      .gt('amount', 0)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map(f => ({ id: String(f.id), amount: Number(f.amount) || 0 }));
  } catch (err) {
    // Leer nunca bloquea un pago: si esto falla, se le paga completo. Cobrar de
    // menos a un chofer por un fallo de lectura sería peor que cobrar tarde.
    log.warn({ driverId, err: err instanceof Error ? err.message : String(err) }, 'no se pudieron leer las penalidades pendientes');
    return [];
  }
}

/** Marca como cobradas las penalidades que se acaban de descontar de un viaje. */
export async function marcarCobradas(ids: string[], viajeQueLasSalda: string): Promise<void> {
  if (ids.length === 0) return;
  try {
    const { error } = await supabaseAdmin
      .from(TABLE)
      .update({
        status: 'charged',
        settled_ride_id: viajeQueLasSalda,
        settled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .in('id', ids)
      // Sólo las que siguen pendientes: si un admin anuló una mientras tanto,
      // su decisión manda sobre el descuento automático.
      .eq('status', 'recorded');
    if (error) throw new Error(error.message);
  } catch (err) {
    log.error({ ids, err: err instanceof Error ? err.message : String(err) }, 'penalidades descontadas pero no marcadas como cobradas');
  }
}
