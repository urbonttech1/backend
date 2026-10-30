/**
 * Revisión de limpieza del vehículo.
 *
 * Cada 48 h el chofer tiene que mandar fotos de su auto tomadas en ese momento.
 * Con la revisión vencida no puede aceptar ni reservar viajes; al enviar las
 * fotos queda habilitado y un admin las revisa después. Si las rechaza, vuelve
 * a quedar vencida.
 *
 * Contra las fotos guardadas de antemano hay varias barreras, ninguna perfecta
 * sola: la app sólo abre la cámara; las fotos tienen que llegar dentro de una
 * sesión de 15 minutos que abre el servidor; el odómetro no puede bajar; y cada
 * foto se compara con las anteriores del mismo chofer (`imageHash.ts`).
 *
 * Este archivo es puro para poder probarlo; las consultas están en
 * `vehicleInspectionStore.ts` y las rutas en `api/vehicleInspections.ts`.
 */

export const FOTOS = ['exterior_front', 'exterior_rear', 'front_seats', 'rear_seats', 'dashboard'] as const;
export type Foto = typeof FOTOS[number];

export const INTERVALO_HORAS = 48;
export const AVISO_HORAS_ANTES = 4;
export const SESION_MINUTOS = 15;
export const FOTO_MAX_BYTES = 10 * 1024 * 1024;

/** Sin HEIC: `sharp` no lo decodifica y la comparación de fotos fallaría. */
export const MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Distancias entre huellas de 64 bits (ver `imageHash.ts`). */
export const DISTANCIA_REPETIDA = 2;
export const DISTANCIA_PARECIDA = 6;

export type EstadoInspeccion = 'collecting' | 'submitted' | 'approved' | 'rejected' | 'expired';

/** La última revisión enviada del chofer, sea cual sea su resultado. */
export interface UltimaInspeccion {
  status: EstadoInspeccion;
  submittedAt: string | null;
  rejectionReason?: string | null;
}

export type Situacion = 'ok' | 'due_soon' | 'due' | 'rejected';

export interface EstadoRevision {
  situacion: Situacion;
  /** Desde cuándo está (o estará) vencida. */
  venceEl: Date;
  /** Si con esto puede aceptar viajes. */
  habilitado: boolean;
  rejectionReason: string | null;
}

/**
 * En qué situación está el chofer.
 *
 * Sin ninguna revisión, el plazo cuenta desde `inicio`, la fecha en que se
 * activó la función: si contara desde siempre, toda la flota quedaría
 * bloqueada el día del despliegue.
 */
export function estadoRevision(
  ultima: UltimaInspeccion | null,
  inicio: Date,
  ahora: Date,
  intervaloHoras = INTERVALO_HORAS,
): EstadoRevision {
  const intervalo = intervaloHoras * 3600_000;

  if (ultima?.status === 'rejected') {
    return { situacion: 'rejected', venceEl: ahora, habilitado: false, rejectionReason: ultima.rejectionReason ?? null };
  }

  const enviada = ultima && (ultima.status === 'submitted' || ultima.status === 'approved') && ultima.submittedAt
    ? new Date(ultima.submittedAt)
    : null;
  const venceEl = new Date((enviada ?? inicio).getTime() + intervalo);

  if (ahora >= venceEl) return { situacion: 'due', venceEl, habilitado: false, rejectionReason: null };
  const avisar = venceEl.getTime() - ahora.getTime() <= AVISO_HORAS_ANTES * 3600_000;
  return { situacion: avisar ? 'due_soon' : 'ok', venceEl, habilitado: true, rejectionReason: null };
}

export function esFoto(raw: unknown): raw is Foto {
  return typeof raw === 'string' && (FOTOS as readonly string[]).includes(raw);
}

export function mimeInspeccion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const mime = raw.trim().toLowerCase().replace('image/jpg', 'image/jpeg');
  return (MIMES as readonly string[]).includes(mime) ? mime : null;
}

export function sesionAbierta(expiraEl: Date, ahora: Date): boolean {
  return ahora < expiraEl;
}

export function fotosFaltantes(tomadas: readonly { slot: string }[]): Foto[] {
  const hechas = new Set(tomadas.map((f) => f.slot));
  return FOTOS.filter((f) => !hechas.has(f));
}

/** El odómetro es un entero razonable y no menor que el último enviado. */
export function validarOdometro(
  raw: unknown,
  anterior: number | null,
): { ok: true; valor: number } | { ok: false; error: string; code: string } {
  const valor = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw.replace(/[,.\s]/g, '')) : NaN;
  if (!Number.isInteger(valor) || valor < 0 || valor > 2_000_000) {
    return { ok: false, error: 'Enter the odometer reading shown in the dashboard photo.', code: 'INVALID_ODOMETER' };
  }
  if (anterior !== null && valor < anterior) {
    return { ok: false, error: `The odometer cannot be lower than your last check (${anterior}).`, code: 'ODOMETER_DECREASED' };
  }
  return { ok: true, valor };
}

/** Bits distintos entre dos huellas hexadecimales de 64 bits. */
export function distanciaHamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let distancia = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { distancia += x & 1; x >>= 1; }
  }
  return distancia;
}

/**
 * Si una foto ya se había enviado. `repetida` es prácticamente la misma imagen
 * y se rechaza; `parecida` se deja pasar pero se marca para quien revisa, porque
 * dos fotos honestas del mismo auto desde el mismo ángulo pueden acercarse.
 */
export function compararConAnteriores(huella: string, anteriores: readonly string[]): 'nueva' | 'parecida' | 'repetida' {
  let minima = 64;
  for (const otra of anteriores) minima = Math.min(minima, distanciaHamming(huella, otra));
  if (minima <= DISTANCIA_REPETIDA) return 'repetida';
  if (minima <= DISTANCIA_PARECIDA) return 'parecida';
  return 'nueva';
}
