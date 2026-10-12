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

/** Texto corto, en inglés, para la oferta que ve el chofer. */
export function textoSillas(seats: ChildSeats | null | undefined): string {
  if (!seats) return '';
  const partes: string[] = [];
  const agregar = (n: number, uno: string, varios: string) => {
    if (n === 1) partes.push(`1 ${uno}`);
    else if (n > 1) partes.push(`${n} ${varios}`);
  };
  agregar(seats.rear_facing, 'rear-facing seat', 'rear-facing seats');
  agregar(seats.forward_facing, 'forward-facing seat', 'forward-facing seats');
  agregar(seats.booster, 'booster seat', 'booster seats');
  if (partes.length === 0) return '';
  if (partes.length === 1) return `Needs ${partes[0]}`;
  const ultima = partes.pop();
  return `Needs ${partes.join(', ')} and ${ultima}`;
}
