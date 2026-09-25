import { describe, it, expect } from 'vitest';
import { aCentavos, resumenDeSaldo, puedeRetirar, enDolares, gananciaDelChofer } from './driverBalance';

const sinStripe = { disponibleCents: 0, enCaminoCents: 0 };

describe('aCentavos', () => {
  it('convierte lo que venga de la base', () => {
    expect(aCentavos(25.16)).toBe(2516);
    expect(aCentavos('25.16')).toBe(2516);
  });
  it('lo que no es importe positivo vale cero', () => {
    expect(aCentavos(null)).toBe(0);
    expect(aCentavos(-3)).toBe(0);
    expect(aCentavos('x')).toBe(0);
  });
});

describe('resumenDeSaldo — los tres sitios donde vive el dinero', () => {
  it('separa la deuda de Urbont de lo que hay en Stripe', () => {
    const r = resumenDeSaldo({
      pendientesUSD: [25.16, 26.05, 36.08, 36.08],
      saldoStripe: { disponibleCents: 5000, enCaminoCents: 1200 },
    });
    expect(r.enUrbontCents).toBe(12337);
    expect(r.disponibleCents).toBe(5000);
    expect(r.enCaminoCents).toBe(1200);
    expect(r.totalCents).toBe(18537);
  });

  it('solo lo disponible en Stripe es retirable', () => {
    // El caso real del 24/09: $123.37 en deuda y $0 en Stripe.
    const r = resumenDeSaldo({ pendientesUSD: [123.37], saldoStripe: sinStripe });
    expect(r.totalCents).toBe(12337);
    expect(r.retirableCents).toBe(0);
  });

  it('el instantáneo nunca promete más que lo disponible', () => {
    const r = resumenDeSaldo({
      pendientesUSD: [],
      saldoStripe: { disponibleCents: 3000, enCaminoCents: 0, instantaneoCents: 9999 },
    });
    expect(r.instantaneoCents).toBe(3000);
  });

  it('sin nada, todo en cero', () => {
    const r = resumenDeSaldo({ pendientesUSD: [], saldoStripe: sinStripe });
    expect(r.totalCents).toBe(0);
    expect(r.retirableCents).toBe(0);
  });
});

describe('puedeRetirar — y por qué no, cuando no', () => {
  it('con saldo disponible, se puede', () => {
    const r = resumenDeSaldo({ pendientesUSD: [], saldoStripe: { disponibleCents: 4500, enCaminoCents: 0 } });
    expect(puedeRetirar(r, 'standard')).toEqual({ puede: true, motivo: null, montoCents: 4500 });
  });

  it('explica que el dinero está por cobrar de Urbont', () => {
    const r = resumenDeSaldo({ pendientesUSD: [123.37], saldoStripe: sinStripe });
    const v = puedeRetirar(r, 'standard');
    expect(v.puede).toBe(false);
    expect(v.motivo).toContain('123.37');
    expect(v.motivo).toContain('por cobrar');
  });

  it('explica que el dinero está en camino', () => {
    const r = resumenDeSaldo({ pendientesUSD: [], saldoStripe: { disponibleCents: 0, enCaminoCents: 8000 } });
    expect(puedeRetirar(r, 'standard').motivo).toContain('80.00');
  });

  it('el instantáneo sin tarjeta manda al estándar', () => {
    const r = resumenDeSaldo({
      pendientesUSD: [],
      saldoStripe: { disponibleCents: 4500, enCaminoCents: 0, instantaneoCents: 0 },
    });
    const v = puedeRetirar(r, 'instant');
    expect(v.puede).toBe(false);
    expect(v.motivo).toContain('tarjeta de débito');
  });

  it('sin nada, lo dice sin rodeos', () => {
    const r = resumenDeSaldo({ pendientesUSD: [], saldoStripe: sinStripe });
    expect(puedeRetirar(r, 'standard').motivo).toBe('No tienes saldo para retirar.');
  });
});

describe('enDolares', () => {
  it('centavos a dólares', () => {
    expect(enDolares(12337)).toBe(123.37);
    expect(enDolares(0)).toBe(0);
  });
});

describe('gananciaDelChofer — lo que gana, no lo que factura Urbont', () => {
  it('manda lo apuntado al repartir', () => {
    expect(gananciaDelChofer({ driver_earnings: 25.16, fare: 29.60 })).toBe(25.16);
    expect(gananciaDelChofer({ driver_earnings: '25.16', fare: 29.60 })).toBe(25.16);
  });

  it('sin importe apuntado, el 85 % de la tarifa', () => {
    // Los viajes viejos, de antes de que se escribiera la columna.
    expect(gananciaDelChofer({ fare: 100 })).toBe(85);
    expect(gananciaDelChofer({ driver_earnings: null, fare: 29.60 })).toBe(25.16);
    expect(gananciaDelChofer({ driver_earnings: 0, fare: 29.60 })).toBe(25.16);
  });

  it('sin nada, cero', () => {
    expect(gananciaDelChofer({})).toBe(0);
    expect(gananciaDelChofer({ fare: null, driver_earnings: null })).toBe(0);
    expect(gananciaDelChofer({ fare: 'abc' })).toBe(0);
  });
});
