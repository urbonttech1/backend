/**
 * URBONT Ride State Machine
 * Defines valid status transitions and business rules for each role.
 *
 * States:
 *  scheduled      — future booking confirmed by passenger; no driver dispatched yet
 *  searching      — ride is live and awaiting driver acceptance
 *  confirmed      — driver accepted, en route to pickup
 *  driver_arrived — driver is at the pickup location (wait timer starts)
 *  in_progress    — trip started
 *  completed      — trip finished
 *  cancelled      — cancelled by passenger, driver, or system
 *
 * Uber/Lyft model for scheduled rides:
 *  scheduled → searching  (system/cron at T-30 min before pickup)
 *  searching → confirmed  (driver accepts)
 *  confirmed → driver_arrived → in_progress → completed
 */
export type RideStatus = 'scheduled' | 'searching' | 'confirmed' | 'driver_arrived' | 'in_progress' | 'completed' | 'cancelled';
export type UserRole   = 'passenger' | 'driver' | 'chauffeur' | 'admin' | 'valet';

interface Transition {
  from:       RideStatus[];
  allowedFor: UserRole[];
}

const TRANSITIONS: Record<RideStatus, Transition> = {
  scheduled: {
    // 'scheduled' is an initial state set only at ride creation time.
    // No state machine transition leads INTO scheduled — rides are never
    // moved back to scheduled once in any other state.  The from array
    // is intentionally empty; the cron job transitions scheduled → searching
    // directly via Supabase admin and does not call validateTransition.
    from:       [],
    allowedFor: ['admin'],
  },
  searching: {
    // From scheduled (cron dispatch) or from confirmed (admin reassignment)
    from:       ['scheduled', 'confirmed'],
    allowedFor: ['admin'],
  },
  confirmed: {
    // Driver accepts the ride from searching state
    from:       ['searching'],
    allowedFor: ['driver', 'chauffeur', 'admin'],
  },
  driver_arrived: {
    // Driver marks arrival at the pickup location — starts the wait timer
    from:       ['confirmed'],
    allowedFor: ['driver', 'chauffeur', 'admin'],
  },
  in_progress: {
    // Driver starts the trip (can skip driver_arrived for seamless acceptance)
    from:       ['confirmed', 'driver_arrived'],
    allowedFor: ['driver', 'chauffeur', 'admin'],
  },
  completed: {
    // Driver, passenger, or admin can mark a ride complete
    from:       ['in_progress'],
    allowedFor: ['driver', 'chauffeur', 'passenger', 'admin'],
  },
  cancelled: {
    // Any active state can be cancelled (including scheduled — pre-dispatch cancellation)
    from:       ['scheduled', 'searching', 'confirmed', 'driver_arrived', 'in_progress'],
    allowedFor: ['passenger', 'driver', 'chauffeur', 'admin', 'valet'],
  },
};

export interface TransitionResult {
  allowed: boolean;
  reason?: string;
}

export function validateTransition(
  from: RideStatus,
  to: RideStatus,
  role: UserRole,
): TransitionResult {
  if (from === 'completed' || from === 'cancelled') {
    return {
      allowed: false,
      reason: `This ride is already ${from} and cannot be updated.`,
    };
  }

  if (from === to) {
    return { allowed: true };
  }

  const rule = TRANSITIONS[to];
  if (!rule) {
    return { allowed: false, reason: `Invalid status: ${to}` };
  }

  if (!rule.from.includes(from)) {
    const allowed = rule.from.join(' or ');
    return {
      allowed: false,
      reason: `Cannot move from "${from}" to "${to}". The ride must be in ${allowed} status first.`,
    };
  }

  if (!rule.allowedFor.includes(role)) {
    return {
      allowed: false,
      reason: `Your role (${role}) is not permitted to set status to "${to}".`,
    };
  }

  // Passengers may not cancel a trip that is already in progress (Uber/Lyft policy).
  // Drivers and admins retain cancellation rights at all stages (safety / emergency).
  if (to === 'cancelled' && from === 'in_progress' && role === 'passenger') {
    return {
      allowed: false,
      reason: 'A trip that is already in progress cannot be cancelled by the passenger.',
    };
  }

  return { allowed: true };
}

export function isActiveStatus(status: RideStatus): boolean {
  return status === 'scheduled' || status === 'searching' || status === 'confirmed' || status === 'driver_arrived' || status === 'in_progress';
}

export const ACTIVE_STATUSES: RideStatus[] = ['scheduled', 'searching', 'confirmed', 'driver_arrived', 'in_progress'];

/**
 * Los estados en los que el chofer tiene un viaje entre manos.
 *
 * Existe porque `/api/rides/driver-active` —la ruta con la que la app recupera
 * el viaje al volver del segundo plano— preguntaba solo por `confirmed` e
 * `in_progress` y se dejaba fuera `driver_arrived`. Un chofer que marcaba
 * «llegué» y se iba a WhatsApp volvía y la app le decía que no tenía ningún
 * viaje: el servidor contestaba «ninguno» y el cliente le creía.
 *
 * Que la lista viva aquí, al lado de las transiciones, es para que añadir un
 * estado nuevo no vuelva a dejar la recuperación coja.
 *
 * No confundir con `ACTIVE_STATUSES`, que es más amplia: aquélla incluye
 * `scheduled` y `searching`, viajes vivos pero que ningún chofer tiene todavía.
 */
export const ESTADOS_CON_VIAJE_ACTIVO: RideStatus[] = ['confirmed', 'driver_arrived', 'in_progress'];

/** Si en ese estado el viaje sigue vivo para el chofer. */
export function tieneViajeActivo(estado: unknown): boolean {
  return typeof estado === 'string' && (ESTADOS_CON_VIAJE_ACTIVO as string[]).includes(estado);
}

/** Estados en los que el viaje ya terminó y no hay nada que recuperar. */
export function viajeTerminado(estado: unknown): boolean {
  return estado === 'completed' || estado === 'cancelled';
}
