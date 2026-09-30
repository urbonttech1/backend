/**
 * Quién puede escribir en el chat de un viaje, y bajo qué rol.
 *
 * `POST /api/translation/speak` estuvo sin autenticar a propósito (ver
 * docs/NOTIFICACIONES_Y_CHAT.md), por temor a que la app no mandara el token.
 * Sí lo manda, en los cuatro sitios desde los que llama, y ningún otro cliente
 * usa el endpoint. Sin esta regla, cualquiera con un rideId podía escribir
 * haciéndose pasar por el chofer, disparar notificaciones push y gastar cuota
 * de OpenAI transcribiendo audios.
 */
export type RolChat = 'chauffeur' | 'passenger';

/**
 * Plano y no una unión discriminada: este tsconfig no activa `strict`, y sin
 * `strictNullChecks` TypeScript no estrecha por un discriminante booleano.
 */
export interface QuienEscribe {
  permitido: boolean;
  /** Sólo cuando `permitido` es false. */
  motivo?: 'no_participa' | 'rol_ajeno';
  /** Sólo cuando `permitido` es true. */
  rol?: RolChat | 'admin';
}

export function quienEscribe(args: {
  uid: string | undefined;
  role: string | undefined;
  passengerId: string | null | undefined;
  driverId: string | null | undefined;
  senderRole: unknown;
}): QuienEscribe {
  const { uid, role, passengerId, driverId, senderRole } = args;
  if (role === 'admin') return { permitido: true, rol: 'admin' };

  const rolReal: RolChat | null = uid && driverId === uid
    ? 'chauffeur'
    : uid && passengerId === uid
      ? 'passenger'
      : null;
  if (!rolReal) return { permitido: false, motivo: 'no_participa' };

  // El `senderRole` del cuerpo decide de qué lado sale el mensaje y a quién se
  // notifica: lo fija el servidor, no el cliente.
  if (senderRole !== rolReal) return { permitido: false, motivo: 'rol_ajeno' };
  return { permitido: true, rol: rolReal };
}
