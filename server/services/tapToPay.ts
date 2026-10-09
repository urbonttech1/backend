/**
 * Tap to Pay on iPhone: qué viaje puede cobrar el chofer en persona y por cuánto.
 *
 * Función pura, sin base de datos ni Stripe, para poder probarla.
 */

export interface ViajeCobrable {
  driver_id?: unknown;
  ride_status?: unknown;
  payment_status?: unknown;
  locked_fare?: unknown;
  fare?: unknown;
  wait_fee?: unknown;
  payment_intent_id?: unknown;
}

export type DecisionCobro =
  | { ok: true; fareCents: number }
  | { ok: false; status: number; error: string; errorCode: string };

/** Estados en los que el pasajero ya va o fue en el auto: antes no hay nada que cobrar. */
const ESTADOS_COBRABLES = new Set(['driver_arrived', 'in_progress', 'completed']);

/** Tope de Stripe Terminal por transacción, en centavos. */
const MAXIMO_CENTAVOS = 1_000_000;

export function decidirCobroPresencial(viaje: ViajeCobrable | null, choferId: string): DecisionCobro {
  if (!viaje) return { ok: false, status: 404, error: 'Ride not found.', errorCode: 'RIDE_NOT_FOUND' };
  if (String(viaje.driver_id ?? '') !== choferId) {
    return { ok: false, status: 403, error: 'This ride is not yours.', errorCode: 'NOT_YOUR_RIDE' };
  }
  if (viaje.payment_status === 'paid') {
    return { ok: false, status: 409, error: 'This ride is already paid.', errorCode: 'ALREADY_PAID' };
  }
  // Pagado con tarjeta en la app: el cobro está retenido y se captura al
  // terminar, así que todavía no figura como 'paid'. Cobrarlo aquí sería doble.
  if (viaje.payment_intent_id) {
    return { ok: false, status: 409, error: 'The passenger already paid this ride by card in the app.', errorCode: 'ALREADY_HAS_CARD_PAYMENT' };
  }
  if (!ESTADOS_COBRABLES.has(String(viaje.ride_status ?? ''))) {
    return { ok: false, status: 409, error: 'The ride must start before you can collect payment.', errorCode: 'RIDE_NOT_STARTED' };
  }

  // `locked_fare` es el precio garantizado al reservar y la espera se cobra
  // aparte (`wait_fee`). `fare` ya la incluye al completar, así que solo se suma
  // al precio garantizado.
  const garantizado = viaje.locked_fare != null && viaje.locked_fare !== '';
  const espera = garantizado ? Number(viaje.wait_fee ?? 0) || 0 : 0;
  const precio = Number(garantizado ? viaje.locked_fare : viaje.fare) + espera;
  const fareCents = Math.round(precio * 100);
  if (!Number.isFinite(precio) || fareCents < 50 || fareCents > MAXIMO_CENTAVOS) {
    return { ok: false, status: 422, error: 'This ride has no valid fare to collect.', errorCode: 'INVALID_FARE' };
  }
  return { ok: true, fareCents };
}
