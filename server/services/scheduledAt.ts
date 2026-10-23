/**
 * La hora que elige el pasajero es la de Miami, el único mercado.
 * Un texto sin zona (`2026-10-23T07:30`) no es UTC: Postgres lo guardaría
 * cuatro horas antes en horario de verano. Si ya trae `Z` o un offset, es un
 * instante y se conserva.
 */

export const ZONA_SERVICIO = 'America/New_York';

const CON_ZONA = /(?:[zZ]|[+-]\d{2}:\d{2})$/;
const RELOJ = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/** Offset de `timeZone` respecto de UTC en ese instante, en milisegundos. */
function offsetDeZona(instante: Date, timeZone: string): number {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instante);
  const mapa: Record<string, string> = {};
  for (const p of partes) if (p.type !== 'literal') mapa[p.type] = p.value;
  const comoUtc = Date.UTC(
    Number(mapa.year),
    Number(mapa.month) - 1,
    Number(mapa.day),
    Number(mapa.hour) % 24,
    Number(mapa.minute),
    Number(mapa.second),
  );
  return comoUtc - instante.getTime();
}

function paredEnZonaAUtc(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
  timeZone: string,
): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const suposicion = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset1 = offsetDeZona(suposicion, timeZone);
  let resultado = new Date(suposicion.getTime() - offset1);
  const offset2 = offsetDeZona(resultado, timeZone);
  if (offset2 !== offset1) resultado = new Date(suposicion.getTime() - offset2);
  return Number.isFinite(resultado.getTime()) ? resultado : null;
}

/**
 * Instante UTC listo para `TIMESTAMPTZ`. `null` si el texto no es una fecha.
 * Cadena vacía también devuelve `null`: no había reserva.
 */
export function citaAUtc(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  if (CON_ZONA.test(s)) {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const m = RELOJ.exec(s);
  if (!m) {
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const utc = paredEnZonaAUtc(
    Number(m[1]), Number(m[2]), Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] ?? 0),
    ZONA_SERVICIO,
  );
  return utc ? utc.toISOString() : null;
}
