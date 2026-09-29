import { describe, it, expect } from 'vitest';
import { quienCancela } from './cancelActor';

const viaje = { passengerId: 'pasajero', driverId: 'chofer' };

describe('quienCancela — quién puede cancelar un viaje y como qué', () => {
  it('rechaza a quien no es parte del viaje, aunque diga ser el chofer', () => {
    expect(quienCancela({ ...viaje, uid: 'otro-chofer', role: 'chauffeur', cancelledBy: 'driver' })).toEqual({ permitido: false });
    expect(quienCancela({ ...viaje, uid: undefined, role: undefined, cancelledBy: undefined })).toEqual({ permitido: false });
  });

  it('rechaza a un chofer cualquiera en una reserva todavía sin chofer', () => {
    expect(quienCancela({ passengerId: 'pasajero', driverId: null, uid: 'chofer', role: 'chauffeur', cancelledBy: 'driver' }))
      .toEqual({ permitido: false });
  });

  it('el pasajero cancela como pasajero aunque mande cancelledBy=driver', () => {
    expect(quienCancela({ ...viaje, uid: 'pasajero', role: 'passenger', cancelledBy: 'driver' }))
      .toEqual({ permitido: true, cancelaChofer: false });
  });

  it('el chofer asignado cancela como chofer aunque no mande cancelledBy', () => {
    expect(quienCancela({ ...viaje, uid: 'chofer', role: 'chauffeur', cancelledBy: undefined }))
      .toEqual({ permitido: true, cancelaChofer: true });
  });

  it('un admin cancela en nombre de quien indique', () => {
    expect(quienCancela({ ...viaje, uid: 'admin', role: 'admin', cancelledBy: 'driver' }))
      .toEqual({ permitido: true, cancelaChofer: true });
    expect(quienCancela({ ...viaje, uid: 'admin', role: 'admin', cancelledBy: 'passenger' }))
      .toEqual({ permitido: true, cancelaChofer: false });
  });
});
