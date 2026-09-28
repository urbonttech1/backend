import { describe, it, expect } from 'vitest';
import { desgloseDeDinero } from './rideMoneyBreakdown';

describe('desgloseDeDinero', () => {
  it('reparte 85/15 sobre la tarifa, con el impuesto retenido', () => {
    // El viaje real del 25/09: $28.07 cobrados = $26.36 tarifa + $1.71 impuesto.
    const d = desgloseDeDinero({ fare: 26.36, tax_amount: 1.71, total_with_tax: 28.07 });
    expect(d.cobradoAlPasajero).toBe(28.07);
    expect(d.comisionUrbont).toBeCloseTo(5.66, 2); // 15% de 26.36 + 1.71 de impuesto
    expect(d.gananciaChofer).toBeCloseTo(22.41, 2); // 85% de 26.36
    expect(d.fuente).toBe('estimado');
    expect(d.transferido).toBe(false);
  });

  it('si ya hay driver_earnings, manda: es un hecho, no una proyección', () => {
    const d = desgloseDeDinero({
      fare: 26.36, tax_amount: 1.71, total_with_tax: 28.07,
      driver_earnings: 22.41, stripe_transfer_id: 'tr_123',
    });
    expect(d.fuente).toBe('registrado');
    expect(d.gananciaChofer).toBe(22.41);
    expect(d.transferido).toBe(true);
    expect(d.transferId).toBe('tr_123');
  });

  it('cuando driver_earnings se pagó sobre una tarifa que ya cambió, Urbont + Chofer sigue sumando el total', () => {
    // El caso real del 27/09: fare pasó a $23.25 después de haberle pagado al
    // chofer $21.05, el 85 % de los $24.76 que el viaje tenía entonces. Con el
    // 15 % calculado sobre el fare actual (comisionUrbont=$3.49) la tarjeta
    // sumaba $24.54, casi un dólar más que "Cobrado al pasajero".
    const d = desgloseDeDinero({ fare: 23.25, driver_earnings: 21.05, stripe_transfer_id: 'tr_x' });
    expect(d.gananciaChofer).toBe(21.05);
    expect(d.comisionUrbont).toBeCloseTo(2.20, 2); // 23.25 - 21.05, no 15% de 23.25
    expect(d.comisionUrbont + d.gananciaChofer).toBeCloseTo(d.cobradoAlPasajero, 2);
  });

  it('con propina, la propina no infla la comisión de Urbont', () => {
    // La propina es del chofer entera; restarla del total antes de derivar la
    // comisión evita que Urbont "se quede" con parte de una propina de $10.
    const d = desgloseDeDinero({ fare: 23.25, driver_earnings: 21.05, tip_amount: 10 });
    expect(d.gananciaChofer).toBe(31.05); // 21.05 + 10 de propina
    expect(d.comisionUrbont).toBeCloseTo(2.20, 2); // igual que sin propina
  });

  describe('gananciaChoferViaje', () => {
    it('es la ganancia sin propina, y es la que cuadra con comisionUrbont', () => {
      // El caso real: la caja "Chofer" mostraba $31.05 (con los $10 de propina)
      // al lado de "Urbont" $2.20, y la barra los comparaba entre sí — hacía
      // ver que el chofer se llevó el 93 % del viaje cuando el viaje real se
      // repartió 90,5 % / 9,5 %. gananciaChoferViaje es el número correcto
      // para esa comparación; gananciaChofer (con propina) no lo es.
      const d = desgloseDeDinero({ fare: 23.25, driver_earnings: 21.05, tip_amount: 10 });
      expect(d.gananciaChoferViaje).toBe(21.05);
      expect(d.comisionUrbont + d.gananciaChoferViaje).toBeCloseTo(d.cobradoAlPasajero, 2);
    });

    it('sin propina, coincide con gananciaChofer', () => {
      const d = desgloseDeDinero({ fare: 23.25, driver_earnings: 21.05 });
      expect(d.gananciaChoferViaje).toBe(d.gananciaChofer);
    });

    it('también cuadra en el caso estimado, no sólo en el registrado', () => {
      const d = desgloseDeDinero({ fare: 20, tip_amount: 10 });
      expect(d.gananciaChoferViaje).toBeCloseTo(17, 2); // 85% de 20, sin la propina
      expect(d.comisionUrbont + d.gananciaChoferViaje).toBeCloseTo(d.cobradoAlPasajero, 2);
    });
  });

  it('la propina se suma a la ganancia del chofer, registrada o estimada', () => {
    const estimado = desgloseDeDinero({ fare: 20, tip_amount: 10 });
    expect(estimado.gananciaChofer).toBeCloseTo(17 + 10, 2); // 85% de 20 + propina

    const registrado = desgloseDeDinero({ fare: 20, driver_earnings: 17, tip_amount: 10 });
    expect(registrado.gananciaChofer).toBe(27);
  });

  it('sin total_with_tax, se completa con tarifa + impuesto', () => {
    const d = desgloseDeDinero({ fare: 26.36, tax_amount: 1.71 });
    expect(d.cobradoAlPasajero).toBeCloseTo(28.07, 2);
  });

  it('la comisión del valet no es del chofer', () => {
    const conValet = desgloseDeDinero({ fare: 30, valet_surcharge: 5 });
    const sinValet = desgloseDeDinero({ fare: 30 });
    expect(conValet.gananciaChofer).toBeLessThan(sinValet.gananciaChofer);
  });

  it('sin ningún dato, todo en cero y estimado', () => {
    const d = desgloseDeDinero({});
    expect(d.cobradoAlPasajero).toBe(0);
    expect(d.gananciaChofer).toBe(0);
    expect(d.fuente).toBe('estimado');
    expect(d.transferido).toBe(false);
  });

  it('los cargos aparte se reportan sin mezclarse con el reparto', () => {
    const d = desgloseDeDinero({ fare: 20, wait_fee: 3, no_show_fee: 15, promo_discount: 2 });
    expect(d.cargoEspera).toBe(3);
    expect(d.cargoNoShow).toBe(15);
    expect(d.descuentoPromo).toBe(2);
  });

  describe('cargo por espera', () => {
    // status.ts reescribe fare = locked_fare + wait_fee al completar el viaje.
    const conEspera = {
      fare: 26.00, locked_fare: 23.25, wait_fee: 2.75,
      base_fare_breakdown: JSON.stringify({ booking_fee: 0, booking_fee_flat: 2.50 }),
    };

    it('no se cuenta dos veces: va dentro de la tarifa, no encima', () => {
      const d = desgloseDeDinero(conEspera);
      expect(d.tarifaBase).toBe(26.00);
      expect(d.cobradoAlPasajero).toBe(26.00);
      expect(d.cargoEspera).toBe(2.75);
    });

    it('las partes de la tarifa suman la tarifa', () => {
      const d = desgloseDeDinero(conEspera);
      expect(d.tarifaRecorrido).toBeCloseTo(20.75, 2);
      expect(d.tarifaRecorrido + (d.bookingFee ?? 0) + d.cargoEspera).toBeCloseTo(d.tarifaBase, 2);
    });

    it('entra en el reparto 85/15, como el resto del precio', () => {
      const d = desgloseDeDinero(conEspera);
      expect(d.gananciaChoferViaje).toBeCloseTo(26.00 * 0.85, 1);
    });

    it('si la reescritura de fare falló, la espera se suma igual', () => {
      // La escritura va sin esperar resultado: si falla, fare se queda en la
      // tarifa congelada, pero la espera sí se capturó.
      const d = desgloseDeDinero({ ...conEspera, fare: 23.25 });
      expect(d.tarifaBase).toBe(26.00);
      expect(d.cobradoAlPasajero).toBe(26.00);
    });

    it('sin espera, nada cambia', () => {
      const d = desgloseDeDinero({ fare: 23.25, locked_fare: 23.25 });
      expect(d.tarifaBase).toBe(23.25);
      expect(d.cargoEspera).toBe(0);
    });
  });

  describe('comisión del valet', () => {
    it('no se cuenta como de Urbont: se transfiere al valet', () => {
      const d = desgloseDeDinero({ fare: 40, valet_surcharge: 10 });
      // 40 de servicio: 10 al valet, y el 85/15 se aplica a los 30 restantes.
      expect(d.comisionValet).toBe(10);
      expect(d.comisionUrbont).toBeCloseTo(4.50, 2);
      expect(d.gananciaChoferViaje).toBeCloseTo(25.50, 2);
    });

    it('Urbont + Valet + Chofer suman lo cobrado, estimado o registrado', () => {
      const estimado = desgloseDeDinero({ fare: 40, valet_surcharge: 10, tax_amount: 2.60 });
      expect(estimado.comisionUrbont + estimado.comisionValet + estimado.gananciaChoferViaje)
        .toBeCloseTo(estimado.cobradoAlPasajero, 2);

      const registrado = desgloseDeDinero({ fare: 40, valet_surcharge: 10, driver_earnings: 25.50 });
      expect(registrado.comisionUrbont).toBeCloseTo(4.50, 2);
      expect(registrado.comisionUrbont + registrado.comisionValet + registrado.gananciaChoferViaje)
        .toBeCloseTo(registrado.cobradoAlPasajero, 2);
    });
  });

  describe('bookingFee', () => {
    it('lo saca del desglose guardado: el fijo más el de clase', () => {
      const d = desgloseDeDinero({
        fare: 29.60,
        base_fare_breakdown: JSON.stringify({ base_fare: 17, distance_charge: 0, time_charge: 0.10, booking_fee: 10, booking_fee_flat: 2.50 }),
      });
      expect(d.bookingFee).toBe(12.50);
      expect(d.tarifaRecorrido).toBeCloseTo(29.60 - 12.50, 2);
    });

    it('acepta el desglose ya parseado, no sólo texto', () => {
      // La ruta admin lo pasa tal cual viene de Supabase; a veces ya es objeto.
      const d = desgloseDeDinero({ fare: 20.50, base_fare_breakdown: { booking_fee: 0, booking_fee_flat: 2.50 } });
      expect(d.bookingFee).toBe(2.50);
    });

    it('null, no 0, cuando no hay desglose guardado', () => {
      // Un viaje sin booking fee real no existe: un 0 se leería como un dato.
      const d = desgloseDeDinero({ fare: 20 });
      expect(d.bookingFee).toBeNull();
      // El recorrido se queda con el booking fee dentro: no se puede separar.
      expect(d.tarifaRecorrido).toBe(20);
    });

    it('JSON corrupto no lanza: cae a null', () => {
      const d = desgloseDeDinero({ fare: 20, base_fare_breakdown: '{ esto no es json' });
      expect(d.bookingFee).toBeNull();
    });

    it('un desglose sin esas dos claves también cae a null', () => {
      const d = desgloseDeDinero({ fare: 20, base_fare_breakdown: JSON.stringify({ base_fare: 17 }) });
      expect(d.bookingFee).toBeNull();
    });
  });
});
