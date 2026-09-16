/**
 * Reportes de incidentes del conductor (pantalla Help de la app).
 *
 * Valida y normaliza lo que manda la app, sin base de datos, para poder
 * probarlo. La ruta está en `api/driver-incidents.ts` y escribe en la tabla
 * `incidents`, que es la que muestra la pantalla Incidentes del panel.
 */

export const TIPOS_INCIDENTE = [
  'accident', 'cannot_pickup', 'vehicle_issue', 'roadside_assistance', 'other',
] as const;
export type TipoIncidente = typeof TIPOS_INCIDENTE[number];

/** Severidad en la escala del panel. `critical` queda reservada para el SOS. */
export type SeveridadPanel = 'low' | 'medium' | 'high' | 'critical';
export type SeveridadApp = 'minor' | 'moderate' | 'severe';

/** La app usa minor/moderate/severe; el panel, low/medium/high. */
const SEVERIDAD: Record<SeveridadApp, SeveridadPanel> = {
  minor: 'low',
  moderate: 'medium',
  severe: 'high',
};

/** Severidad de los tipos que no la traen. */
const SEVERIDAD_POR_TIPO: Record<TipoIncidente, SeveridadPanel> = {
  accident: 'medium',
  cannot_pickup: 'medium',
  vehicle_issue: 'medium',
  roadside_assistance: 'medium',
  other: 'low',
};

const ALIAS_TIPO: Record<string, TipoIncidente> = {
  accident: 'accident',
  accident_report: 'accident',
  cannot_pickup: 'cannot_pickup',
  cannot_pick_up: 'cannot_pickup',
  vehicle_issue: 'vehicle_issue',
  vehicle_breakdown: 'vehicle_issue',
  breakdown: 'vehicle_issue',
  roadside_assistance: 'roadside_assistance',
  roadside: 'roadside_assistance',
  other: 'other',
  other_incident: 'other',
};

export const ETIQUETA_INCIDENTE: Record<TipoIncidente, string> = {
  accident: 'Accident Report',
  cannot_pickup: 'Cannot Pick Up Client',
  vehicle_issue: 'Vehicle Breakdown',
  roadside_assistance: 'Roadside Assistance',
  other: 'Other Incident',
};

/** Límites de las fotos, que también se publican a la app. */
export const FOTO_TIPOS = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
export const FOTO_MAX_BYTES = 10 * 1024 * 1024;
export const FOTOS_POR_INCIDENTE = 3;

export interface IncidenteNormalizado {
  tipo: TipoIncidente;
  severidad: SeveridadPanel;
  /** La que eligió el conductor. Sólo en accidentes. */
  severidadApp: SeveridadApp | null;
  descripcion: string;
  rideId: string | null;
  lat: number | null;
  lng: number | null;
  /** ISO-8601. Si la app no la manda, el momento del reporte. */
  occurredAt: string;
  /** Accidente grave: se avisa a operaciones en el momento. */
  avisarYa: boolean;
}

export type ResultadoIncidente =
  | { ok: true; incidente: IncidenteNormalizado }
  | { ok: false; error: string; errorCode: string; field: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const fallo = (error: string, errorCode: string, field: string): ResultadoIncidente =>
  ({ ok: false, error, errorCode, field });

const numero = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

export function normalizarIncidente(body: Record<string, unknown>, ahora = new Date()): ResultadoIncidente {
  const tipo = ALIAS_TIPO[(texto(body.category) || texto(body.type)).toLowerCase()];
  if (!tipo) {
    return fallo(
      'category must be accident, cannot_pickup, vehicle_issue, roadside_assistance or other.',
      'INVALID_CATEGORY', 'category',
    );
  }

  const descripcion = texto(body.description) || texto(body.message);
  if (descripcion.length > 3000) {
    return fallo('The description is too long (3000 characters max).', 'DESCRIPTION_TOO_LONG', 'description');
  }

  // La severidad sólo cuenta en accidentes, y ahí es obligatoria: de ella
  // depende avisar a operaciones en el momento.
  let severidadApp: SeveridadApp | null = null;
  if (tipo === 'accident') {
    const s = texto(body.severity).toLowerCase();
    if (!s) return fallo('severity is required for accidents: minor, moderate or severe.', 'MISSING_SEVERITY', 'severity');
    if (!(s in SEVERIDAD)) return fallo('severity must be minor, moderate or severe.', 'INVALID_SEVERITY', 'severity');
    severidadApp = s as SeveridadApp;
  }
  const severidad = severidadApp ? SEVERIDAD[severidadApp] : SEVERIDAD_POR_TIPO[tipo];

  const rideId = texto(body.rideId) || texto(body.ride_id) || null;
  if (rideId && !UUID.test(rideId)) {
    return fallo('rideId is not a valid ride id.', 'INVALID_RIDE_ID', 'rideId');
  }

  // Ubicación: `location: { lat, lng }`, o `lat` y `lng` sueltos.
  const loc = (body.location && typeof body.location === 'object' ? body.location : body) as Record<string, unknown>;
  const lat = numero(loc.lat);
  const lng = numero(loc.lng);
  const hayAlguna = lat !== null || lng !== null;
  if (hayAlguna) {
    const valida = lat !== null && lng !== null && !Number.isNaN(lat) && !Number.isNaN(lng)
      && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
    if (!valida) return fallo('location must include valid lat and lng.', 'INVALID_LOCATION', 'location');
  }

  let occurredAt = ahora.toISOString();
  const cuando = texto(body.occurredAt) || texto(body.occurred_at);
  if (cuando) {
    const t = Date.parse(cuando);
    // Cinco minutos de margen por relojes de teléfono adelantados.
    if (Number.isNaN(t) || t > ahora.getTime() + 5 * 60 * 1000) {
      return fallo('occurredAt must be a past ISO-8601 date.', 'INVALID_OCCURRED_AT', 'occurredAt');
    }
    occurredAt = new Date(t).toISOString();
  }

  return {
    ok: true,
    incidente: {
      tipo,
      severidad,
      severidadApp,
      descripcion,
      rideId,
      lat: hayAlguna ? lat : null,
      lng: hayAlguna ? lng : null,
      occurredAt,
      avisarYa: tipo === 'accident' && severidadApp === 'severe',
    },
  };
}

/**
 * Número de emergencias por país (ISO 3166-1 alpha-2). `null` si no se conoce:
 * la app debe quedarse con el suyo antes que mostrar uno equivocado. En
 * Colombia la línea nacional es el 123, no el 911.
 */
const EMERGENCIAS: Record<string, string> = {
  US: '911',
  PR: '911',
  CA: '911',
  MX: '911',
  CO: '123',
};

export function telefonoEmergencias(pais: string | null | undefined): string | null {
  return EMERGENCIAS[(pais ?? '').trim().toUpperCase()] ?? null;
}
