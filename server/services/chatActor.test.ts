import { describe, it, expect } from 'vitest';
import { quienEscribe } from './chatActor';

const viaje = { passengerId: 'pasajero', driverId: 'chofer' };

describe('quienEscribe — quién puede escribir en el chat de un viaje', () => {
  it('rechaza a quien no es parte del viaje, aunque conozca el rideId', () => {
    expect(quienEscribe({ ...viaje, uid: 'otro', role: 'chauffeur', senderRole: 'chauffeur' }))
      .toEqual({ permitido: false, motivo: 'no_participa' });
    expect(quienEscribe({ ...viaje, uid: undefined, role: undefined, senderRole: 'passenger' }))
      .toEqual({ permitido: false, motivo: 'no_participa' });
  });

  it('no deja al pasajero escribir como si fuera el chofer', () => {
    expect(quienEscribe({ ...viaje, uid: 'pasajero', role: 'passenger', senderRole: 'chauffeur' }))
      .toEqual({ permitido: false, motivo: 'rol_ajeno' });
  });

  it('deja a cada uno escribir bajo su rol real del viaje', () => {
    expect(quienEscribe({ ...viaje, uid: 'pasajero', role: 'passenger', senderRole: 'passenger' }))
      .toEqual({ permitido: true, rol: 'passenger' });
    expect(quienEscribe({ ...viaje, uid: 'chofer', role: 'chauffeur', senderRole: 'chauffeur' }))
      .toEqual({ permitido: true, rol: 'chauffeur' });
  });

  it('el rol del viaje manda sobre el del token', () => {
    // Un chofer que pide un viaje como pasajero escribe como pasajero.
    expect(quienEscribe({ passengerId: 'chofer', driverId: 'otro', uid: 'chofer', role: 'chauffeur', senderRole: 'passenger' }))
      .toEqual({ permitido: true, rol: 'passenger' });
  });

  it('un admin pasa sin atarse a un rol del viaje', () => {
    expect(quienEscribe({ ...viaje, uid: 'admin', role: 'admin', senderRole: 'chauffeur' }))
      .toEqual({ permitido: true, rol: 'admin' });
  });
});
