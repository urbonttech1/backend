import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  AVISO_HORAS_ANTES,
  compararConAnteriores,
  distanciaHamming,
  estadoRevision,
  fotosFaltantes,
  mimeInspeccion,
  validarOdometro,
} from './vehicleInspection';
import { huellaDeImagen } from './imageHash';

const H = 3600_000;
const inicio = new Date('2026-11-01T12:00:00Z');

describe('estadoRevision', () => {
  it('sin revisiones, el plazo de 48 h cuenta desde que se activó la función', () => {
    const e = estadoRevision(null, inicio, new Date(inicio.getTime() + 10 * H));
    expect(e.situacion).toBe('ok');
    expect(e.habilitado).toBe(true);
    expect(e.venceEl.toISOString()).toBe('2026-11-03T12:00:00.000Z');
  });

  it(`avisa en las últimas ${AVISO_HORAS_ANTES} h y bloquea al vencer`, () => {
    expect(estadoRevision(null, inicio, new Date(inicio.getTime() + 45 * H)).situacion).toBe('due_soon');
    const vencida = estadoRevision(null, inicio, new Date(inicio.getTime() + 48 * H));
    expect(vencida.situacion).toBe('due');
    expect(vencida.habilitado).toBe(false);
  });

  it('una revisión enviada, aún sin revisar, habilita por 48 h desde el envío', () => {
    const enviada = { status: 'submitted' as const, submittedAt: '2026-11-05T08:00:00Z' };
    const e = estadoRevision(enviada, inicio, new Date('2026-11-06T08:00:00Z'));
    expect(e.habilitado).toBe(true);
    expect(e.venceEl.toISOString()).toBe('2026-11-07T08:00:00.000Z');
  });

  it('una rechazada bloquea en el acto y trae el motivo', () => {
    const e = estadoRevision({ status: 'rejected', submittedAt: '2026-11-05T08:00:00Z', rejectionReason: 'Asientos sucios' }, inicio, new Date('2026-11-05T09:00:00Z'));
    expect(e.situacion).toBe('rejected');
    expect(e.habilitado).toBe(false);
    expect(e.rejectionReason).toBe('Asientos sucios');
  });
});

describe('validarOdometro', () => {
  it('acepta números y texto con separadores', () => {
    expect(validarOdometro(45210, null)).toEqual({ ok: true, valor: 45210 });
    expect(validarOdometro('45,210', 45000)).toEqual({ ok: true, valor: 45210 });
  });

  it('rechaza un odómetro menor que el anterior', () => {
    expect(validarOdometro(44000, 45000)).toMatchObject({ ok: false, code: 'ODOMETER_DECREASED' });
  });

  it('rechaza valores vacíos o absurdos', () => {
    expect(validarOdometro('', null)).toMatchObject({ ok: false, code: 'INVALID_ODOMETER' });
    expect(validarOdometro(-5, null)).toMatchObject({ ok: false, code: 'INVALID_ODOMETER' });
    expect(validarOdometro(12.5, null)).toMatchObject({ ok: false, code: 'INVALID_ODOMETER' });
  });
});

describe('fotos', () => {
  it('lista las posiciones que faltan', () => {
    expect(fotosFaltantes([{ slot: 'exterior_front' }, { slot: 'dashboard' }]))
      .toEqual(['exterior_rear', 'front_seats', 'rear_seats']);
  });

  it('no acepta HEIC, que no se puede comparar', () => {
    expect(mimeInspeccion('image/jpg')).toBe('image/jpeg');
    expect(mimeInspeccion('image/heic')).toBeNull();
  });
});

describe('fotos repetidas', () => {
  it('cuenta los bits distintos', () => {
    expect(distanciaHamming('ffffffffffffffff', 'ffffffffffffffff')).toBe(0);
    expect(distanciaHamming('0000000000000000', '0000000000000003')).toBe(2);
  });

  it('clasifica por distancia', () => {
    expect(compararConAnteriores('0000000000000000', ['0000000000000001'])).toBe('repetida');
    expect(compararConAnteriores('0000000000000000', ['000000000000001f'])).toBe('parecida');
    expect(compararConAnteriores('0000000000000000', ['ffffffffffffffff'])).toBe('nueva');
    expect(compararConAnteriores('0000000000000000', [])).toBe('nueva');
  });

  // Dos imágenes de prueba con dibujos distintos, generadas aquí mismo.
  const imagen = (svg: string) => sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  const rayas = `<svg width="400" height="300"><rect width="400" height="300" fill="#fff"/>${
    Array.from({ length: 10 }, (_, i) => `<rect x="${i * 40}" width="20" height="300" fill="#000"/>`).join('')}</svg>`;
  const circulo = `<svg width="400" height="300"><rect width="400" height="300" fill="#333"/><circle cx="120" cy="150" r="90" fill="#eee"/></svg>`;

  it('reconoce la misma foto aunque la recompriman y la achiquen', async () => {
    const original = await imagen(rayas);
    const reenviada = await sharp(original).resize(200).jpeg({ quality: 50 }).toBuffer();
    const [a, b] = await Promise.all([huellaDeImagen(original), huellaDeImagen(reenviada)]);
    expect(compararConAnteriores(b, [a])).toBe('repetida');
  });

  it('no confunde dos fotos distintas', async () => {
    const [a, b] = await Promise.all([huellaDeImagen(await imagen(rayas)), huellaDeImagen(await imagen(circulo))]);
    expect(compararConAnteriores(b, [a])).toBe('nueva');
  });
});
