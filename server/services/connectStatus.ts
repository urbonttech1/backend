/**
 * Si un chofer puede cobrar, y cómo lo sabemos.
 *
 * El pago al chofer sólo se intenta cuando `profiles.stripe_connect_status`
 * dice `'active'`. Esa columna la escribía únicamente el webhook
 * `account.updated`… que nunca llegaba: el endpoint de Stripe no estaba
 * suscrito a ese evento, y encima los eventos de cuentas conectadas sólo van a
 * endpoints marcados como Connect. Resultado: choferes con la cuenta perfecta
 * en Stripe —`transfers: active`, `payouts_enabled`— a los que el backend
 * consideraba «sin Connect» y a los que no se transfirió nunca nada, mientras
 * al pasajero sí se le cobraba.
 *
 * De ahí la regla de aquí: la columna es una caché, no la verdad. Si dice que
 * no, se le pregunta a Stripe antes de rendirse, y lo que conteste Stripe se
 * guarda. Así un webhook perdido retrasa un pago, pero ya no lo impide.
 *
 * Las reglas son puras y están probadas; el acceso a Stripe y a la base va
 * aparte, al final del archivo.
 */

export type EstadoConnect = 'not_connected' | 'pending' | 'active';

/** Lo poco que nos importa de una cuenta de Stripe Connect. */
export interface CuentaConnect {
  charges_enabled?: boolean | null;
  payouts_enabled?: boolean | null;
  details_submitted?: boolean | null;
  capabilities?: { transfers?: string | null } | null;
}

/**
 * En qué estado está la cuenta.
 *
 * Manda la capacidad `transfers`: es exactamente lo que Stripe exige para que
 * un `transfers.create` no falle. `details_submitted` —lo que miraba el
 * webhook— sólo dice que el chofer terminó el formulario, no que la cuenta
 * esté habilitada, así que por sí solo no basta para dar por bueno un pago.
 */
export function estadoDeCuenta(cuenta: CuentaConnect | null | undefined): EstadoConnect {
  if (!cuenta) return 'not_connected';
  if (cuenta.capabilities?.transfers === 'active') return 'active';
  return 'pending';
}

/** Con qué estados se intenta transferir. */
export function puedeCobrar(estado: string | null | undefined): boolean {
  return estado === 'active';
}

/**
 * Si hace falta preguntarle a Stripe por esta cuenta.
 *
 * Sólo cuando hay cuenta y la columna aún no la da por activa: si ya dice
 * `'active'` no se gasta una llamada por viaje.
 */
export function hayQueConsultarAStripe(
  accountId: string | null | undefined,
  estadoGuardado: string | null | undefined,
): boolean {
  return !!accountId && !puedeCobrar(estadoGuardado);
}
