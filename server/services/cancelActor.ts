/**
 * Quién cancela un viaje, decidido por el servidor.
 *
 * Sólo el pasajero (o el valet que lo pidió, que figura como pasajero), el
 * chofer asignado o un admin. Antes bastaba con estar autenticado: con el id
 * —los choferes ven los de todas las reservas abiertas— cualquiera cancelaba
 * una reserva ajena, y a menos de 1 h al pasajero se le cobraba el 100 %.
 *
 * `cancelledBy` del body sólo cuenta para un admin: un pasajero que se
 * declarara chofer esquivaba el cargo por cancelar tarde.
 */
export function quienCancela(args: {
  uid: string | undefined;
  role: string | undefined;
  passengerId: string | null | undefined;
  driverId: string | null | undefined;
  cancelledBy: unknown;
}): { permitido: false } | { permitido: true; cancelaChofer: boolean } {
  const { uid, role, passengerId, driverId, cancelledBy } = args;
  const esPasajero       = !!uid && passengerId === uid;
  const esChoferAsignado = !!uid && driverId === uid;
  const esAdmin          = role === 'admin';
  if (!esPasajero && !esChoferAsignado && !esAdmin) return { permitido: false };
  return {
    permitido: true,
    cancelaChofer: (esChoferAsignado && !esPasajero) || (esAdmin && cancelledBy === 'driver'),
  };
}
