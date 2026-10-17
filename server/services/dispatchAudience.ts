/**
 * A qué conductores se les avisa de un viaje nuevo.
 *
 * El push salía a TODOS los conectados: ni distancia ni zona. Tenía un
 * `radiusKm = 15` que nunca se usaba, así que un viaje en Miami despertaba a un
 * conductor en Barranquilla. El socket sí ordena por cercanía, pero su última
 * oleada también termina avisando a todo el mundo.
 *
 * Dos filtros, con papeles distintos a propósito:
 *
 *  - ZONA (grueso, siempre fiable). La ciudad de un conductor no cambia entre
 *    viajes, así que sirve su última posición conocida AUNQUE SEA VIEJA: estar
 *    en Miami hace tres horas sigue diciendo que no está en Barranquilla. Si no
 *    hay posición, se intenta con `operating_city`.
 *
 *  - DISTANCIA (fino, sólo con GPS reciente). Exige una posición de los últimos
 *    minutos. Es justo lo que falla con la app en segundo plano —iOS congela el
 *    envío de posición—, y por eso NO se aplica cuando la posición está vieja:
 *    el push existe precisamente para ese caso.
 *
 * Ante la duda se avisa (se falla abierto): perder un viaje por un filtro es
 * peor que un aviso de más. `DISPATCH_AUDIENCE=off` lo apaga entero.
 */

/** Radio del filtro fino, en km. */
export const RADIO_KM = 15;

/** Hasta cuándo una posición sirve para medir distancia. */
export const FRESCURA_MS = 10 * 60 * 1000;

export interface ConductorCandidato {
  driverId: string;
  lat: number | null;
  lng: number | null;
  /** Última vez que el conductor mandó su posición. */
  updatedAt: string | Date | null;
  /** Texto libre del perfil: 'Miami, FL', 'Barranquilla, CO'… */
  operatingCity: string | null;
}

export interface CriteriosDeAviso {
  /** Zona del viaje; `null` si no se pudo resolver. */
  zonaDelViaje: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  /** Resuelve una coordenada a un id de zona. Lo inyecta quien llama. */
  resolverZona: (lat: number, lng: number) => string | null;
  /** Ids de las zonas activas, para leer `operating_city`. */
  zonas?: { id: string; name: string }[];
  radioKm?: number;
  frescuraMs?: number;
  ahora?: number;
}

export type MotivoDeAviso =
  | 'apagado'
  | 'sin-zona-del-viaje'
  | 'zona-distinta'
  | 'zona-desconocida'
  | 'sin-gps-reciente'
  | 'dentro-del-radio'
  | 'fuera-del-radio'
  | 'sin-coordenadas-de-recogida';

export function filtroActivo(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.DISPATCH_AUDIENCE ?? '').trim().toLowerCase() !== 'off';
}

const normalizar = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Zona a la que apunta un `operating_city` escrito a mano. Sólo cuando no deja
 * lugar a duda: 'Miami, FL' → miami. 'Fort Lauderdale' está en la zona de Miami
 * pero no lo dice su nombre, así que devuelve null y se falla abierto.
 */
export function zonaPorCiudad(ciudad: string | null | undefined, zonas: { id: string; name: string }[] = []): string | null {
  const c = normalizar(ciudad ?? '');
  if (!c) return null;
  const coincide = zonas.filter(z => {
    const partes = [normalizar(z.id), ...normalizar(z.name).split(/\s+y\s+|\s*\/\s*|\s+/)].filter(p => p.length >= 4);
    return partes.some(p => c === p || c.startsWith(`${p} `) || c.includes(` ${p}`) || c.includes(`${p} `));
  });
  return coincide.length === 1 ? coincide[0].id : null;
}

const ms = (v: string | Date | null | undefined): number => (v ? new Date(v).getTime() : NaN);

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Si a este conductor se le avisa del viaje, y por qué. Regla pura. */
export function decidirAviso(c: ConductorCandidato, k: CriteriosDeAviso): { avisar: boolean; motivo: MotivoDeAviso } {
  if (!filtroActivo()) return { avisar: true, motivo: 'apagado' };
  // Sin zona del viaje no hay con qué comparar: que salga como salía antes.
  if (!k.zonaDelViaje) return { avisar: true, motivo: 'sin-zona-del-viaje' };

  const tienePosicion = typeof c.lat === 'number' && typeof c.lng === 'number'
    && Number.isFinite(c.lat) && Number.isFinite(c.lng);

  // ── Grueso: la zona. Vale una posición vieja; nadie cambia de ciudad entre viajes.
  const zonaDelConductor = tienePosicion
    ? k.resolverZona(c.lat as number, c.lng as number)
    : zonaPorCiudad(c.operatingCity, k.zonas);
  if (!zonaDelConductor) return { avisar: true, motivo: 'zona-desconocida' };
  if (zonaDelConductor !== k.zonaDelViaje) return { avisar: false, motivo: 'zona-distinta' };

  // ── Fino: la distancia, sólo si la posición es de hace poco.
  const hayRecogida = typeof k.pickupLat === 'number' && typeof k.pickupLng === 'number';
  if (!hayRecogida) return { avisar: true, motivo: 'sin-coordenadas-de-recogida' };
  if (!tienePosicion) return { avisar: true, motivo: 'sin-gps-reciente' };

  const edad = (k.ahora ?? Date.now()) - ms(c.updatedAt);
  if (!Number.isFinite(edad) || edad > (k.frescuraMs ?? FRESCURA_MS)) {
    return { avisar: true, motivo: 'sin-gps-reciente' };
  }

  const km = haversineKm(c.lat as number, c.lng as number, k.pickupLat as number, k.pickupLng as number);
  return km <= (k.radioKm ?? RADIO_KM)
    ? { avisar: true, motivo: 'dentro-del-radio' }
    : { avisar: false, motivo: 'fuera-del-radio' };
}

/** Los que reciben el aviso, con el recuento por motivo para el log. */
export function audienciaDelViaje(
  candidatos: readonly ConductorCandidato[],
  k: CriteriosDeAviso,
): { avisar: string[]; motivos: Record<string, number> } {
  const avisar: string[] = [];
  const motivos: Record<string, number> = {};
  for (const c of candidatos) {
    const { avisar: si, motivo } = decidirAviso(c, k);
    motivos[motivo] = (motivos[motivo] ?? 0) + 1;
    if (si) avisar.push(c.driverId);
  }
  return { avisar, motivos };
}
