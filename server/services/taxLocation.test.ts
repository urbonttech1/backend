import { describe, it, expect } from 'vitest';
import { codigoPostalDe, codigoPostalDelViaje } from './taxLocation';

describe('codigoPostalDe', () => {
  it('lo saca de una dirección de Google', () => {
    expect(codigoPostalDe('1234 Ocean Dr, Miami Beach, FL 33139, USA')).toBe('33139');
    expect(codigoPostalDe('800 Brickell Ave, Miami, FL 33131, United States')).toBe('33131');
  });

  it('acepta el ZIP+4 y se queda con los cinco dígitos', () => {
    expect(codigoPostalDe('1 Main St, Orlando, FL 32801-1234, USA')).toBe('32801');
  });

  it('no confunde el número de portal con el código postal', () => {
    // Un portal de cinco cifras al principio no debe ganarle al ZIP del final.
    expect(codigoPostalDe('33139 Collins Ave, Miami Beach, FL 33154, USA')).toBe('33154');
  });

  it('devuelve null cuando no hay ninguno', () => {
    expect(codigoPostalDe('Aeropuerto de Barranquilla, Colombia')).toBeNull();
    expect(codigoPostalDe('')).toBeNull();
    expect(codigoPostalDe(null)).toBeNull();
    expect(codigoPostalDe(undefined)).toBeNull();
    expect(codigoPostalDe({ address: '33139' })).toBeNull();
  });
});

describe('codigoPostalDelViaje', () => {
  it('manda la recogida, que es donde ocurre el servicio', () => {
    expect(codigoPostalDelViaje({
      pickup: { address: '1 Main St, Miami, FL 33131, USA' },
      dropoff: { address: '2 Ocean Dr, Miami Beach, FL 33139, USA' },
    })).toBe('33131');
  });

  it('si la recogida no lo trae, se prueba con el destino', () => {
    expect(codigoPostalDelViaje({
      pickup: { address: 'Marriott Hotel' },
      dropoff: { address: '2 Ocean Dr, Miami Beach, FL 33139, USA' },
    })).toBe('33139');
  });

  it('sin ninguno de los dos, null', () => {
    expect(codigoPostalDelViaje({ pickup: { address: 'Casa' }, dropoff: null })).toBeNull();
    expect(codigoPostalDelViaje({})).toBeNull();
  });
});
