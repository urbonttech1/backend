/** Sillas pedidas en una reserva. El chofer las ve en la oferta y acepta si puede llevarlas. */

export interface ChildSeats {
  rear_facing: number;
  forward_facing: number;
  booster: number;
}

const CLAVES = ['rear_facing', 'forward_facing', 'booster'] as const;
const ALIAS: Record<string, keyof ChildSeats> = {
  rear_facing: 'rear_facing',
  rearFacing: 'rear_facing',
  forward_facing: 'forward_facing',
  forwardFacing: 'forward_facing',
  booster: 'booster',
};

/** Más de 30 minutos: la misma regla que deja el viaje en `scheduled`. */
export function esReservaConTiempo(scheduledAt: unknown): boolean {
  if (typeof scheduledAt !== 'string' || !scheduledAt) return false;
  const ms = new Date(scheduledAt).getTime();
  if (!Number.isFinite(ms)) return false;
  return (ms - Date.now()) / 60000 > 30;
}

export function leerSillas(raw: unknown): { ok: true; seats: ChildSeats | null } | { ok: false } {
  if (raw == null) return { ok: true, seats: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
  const origen = raw as Record<string, unknown>;
  const seats: ChildSeats = { rear_facing: 0, forward_facing: 0, booster: 0 };
  for (const clave of Object.keys(origen)) {
    const destino = ALIAS[clave];
    if (!destino) return { ok: false };
    const n = origen[clave] ?? 0;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return { ok: false };
    seats[destino] = n;
  }
  for (const clave of CLAVES) {
    if (seats[clave] == null) seats[clave] = 0;
  }
  const suma = seats.rear_facing + seats.forward_facing + seats.booster;
  if (suma > 4) return { ok: false };
  if (suma === 0) return { ok: true, seats: null };
  return { ok: true, seats };
}

const NOMBRES_SILLAS = {
  en: {
    rear_facing:    ['rear-facing seat', 'rear-facing seats'],
    forward_facing: ['forward-facing seat', 'forward-facing seats'],
    booster:        ['booster seat', 'booster seats'],
    necesita: 'Needs', y: 'and',
  },
  es: {
    rear_facing:    ['silla a contramarcha', 'sillas a contramarcha'],
    forward_facing: ['silla mirando al frente', 'sillas mirando al frente'],
    booster:        ['asiento elevador', 'asientos elevadores'],
    necesita: 'Necesita', y: 'y',
  },
} as const;

/** Texto corto para la oferta que ve el chofer. */
export function textoSillas(seats: ChildSeats | null | undefined, idioma: 'en' | 'es' = 'en'): string {
  if (!seats) return '';
  const nombres = NOMBRES_SILLAS[idioma];
  const partes: string[] = [];
  for (const tipo of ['rear_facing', 'forward_facing', 'booster'] as const) {
    const n = seats[tipo];
    if (n === 1) partes.push(`1 ${nombres[tipo][0]}`);
    else if (n > 1) partes.push(`${n} ${nombres[tipo][1]}`);
  }
  if (partes.length === 0) return '';
  if (partes.length === 1) return `${nombres.necesita} ${partes[0]}`;
  const ultima = partes.pop();
  return `${nombres.necesita} ${partes.join(', ')} ${nombres.y} ${ultima}`;
}
