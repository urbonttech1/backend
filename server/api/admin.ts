import { Router, Request, Response } from "express";
import Stripe from "stripe";
import { requireAdminJWT } from "./admin-auth";
import { supabaseAdmin } from "../db/client";
import { pool as pgPool } from "../db/pool";
import { logger } from '../lib/logger';
import { getMemory, getCpu } from '../services/systemMetrics';
import { getIntegrationChecks, checkDatabase, checkSupabase, checkRedis } from '../services/integrationChecks';
import { recalcularVerificacion, normalizarEstadoDoc, ACCEPTED_DOC_KEYS } from '../services/driverVerification';
import { loadDriverHistoryExtras, loadReleasedDrivers } from '../services/driverRideHistory';
import { enviarAvisoSuspension, enviarAvisoReactivacion } from '../services/accountEmails';
import { invalidateFares, parseStoredFares } from '../services/fareConfig';
import { invalidateZones } from '../services/serviceZones';
import { DEFAULT_FARE_CLASSES, type FareClass, getPricingPolicy } from '../config/pricing';

// Antes este archivo creaba su propio `new Pool()` con la connection string
// cruda, sin la conversión a pooler IPv4 que tiene server/db/pool.ts — por
// eso todas las queries de acá fallaban con EHOSTUNREACH (host directo de
// Supabase solo tiene AAAA/IPv6). Reusar el pool compartido, ya corregido,
// arregla las 27 rutas de este archivo sin tocar el SQL. — 2026-08-28

const _ADMIN_STRIPE_SK = process.env.STRIPE_SECRET_KEY || '';

function getStripeAdmin(): Stripe | null {
  const key = _ADMIN_STRIPE_SK;
  if (!key || key.startsWith('pk_')) return null;
  return new Stripe(key);
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export const adminRouter = Router();
adminRouter.use(requireAdminJWT);

const serverStartTime = Date.now();

// IMPORTANT: These values must mirror the real fare engine in
// `src/screens/booking/utils.ts` (FARE_RULES) and `server/config/pricing.ts`
// (VEHICLE_FARE_RULES). They are surfaced in the admin Fare Editor so admins
// can see/edit the same numbers passengers are actually charged.
// FIX: These defaults were mismatched against server/config/pricing.ts VEHICLE_FARE_RULES
// (sedan $14 vs $25, suv $20 vs $38, van $38 vs $65, perMile 2.50 vs 4.00, etc.).
// Admins saw incorrect numbers in the Fare Editor — these are now synced to the actual
// pricing engine values so what admins see matches what passengers are charged.
// Las tarifas por defecto viven en config/pricing.ts — ver getFaresFromDB abajo.
//
// `concierge` y `valet` ya no aparecen en este editor: no son clases de vehículo
// y ningún cálculo de tarifa las usaba. El cargo de valet es la constante
// VALET_COMMISSION_USD en rides/helpers.ts; si hace falta configurarlo, va por su
// propio camino y no mezclado con el precio por milla de un sedán.

/**
 * Tarifas para el editor del panel.
 *
 * Antes este archivo tenía su propia copia (`DEFAULT_FARES`, con la clave
 * `businessClass` y campos del esquema por kilómetro) y su propia lógica de
 * reseteo. Eran dos definiciones de tarifa en el mismo backend, y la de acá no
 * era la que cobraba.
 *
 * Ahora sale de `DEFAULT_FARE_CLASSES` y `parseStoredFares`, los mismos que usa
 * el motor: lo que el panel muestra es exactamente lo que se le cobra al
 * pasajero. La normalización de claves y campos heredados vive en
 * `services/fareConfig.ts`, no duplicada aquí.
 */
async function getFaresFromDB(): Promise<Record<string, FareClass>> {
  try {
    const { rows } = await pgPool.query(`SELECT value FROM app_config WHERE key = 'fares_config'`);
    if (rows[0]?.value) {
      return { ...DEFAULT_FARE_CLASSES, ...parseStoredFares(JSON.parse(rows[0].value)) };
    }
  } catch (e) {
    logger.warn({ err: errMsg(e) }, '[admin/fares] no se pudo leer fares_config, se usan los valores por defecto');
  }
  return { ...DEFAULT_FARE_CLASSES };
}

async function saveFaresToDB(fares: Record<string, unknown>): Promise<void> {
  await pgPool.query(
    `INSERT INTO app_config (key, value) VALUES ('fares_config', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(fares)]
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

adminRouter.get("/dashboard", async (_req: Request, res: Response) => {
  try {
    const [profilesRes, ridesRes, docsRes, incRes, supRes, compRes, actRes] = await Promise.all([
      supabaseAdmin.from('profiles').select('id, role, status_val, rating, total_rides').then(r => r, () => ({ data: [] as Record<string,unknown>[], error: null })),
      supabaseAdmin.from('rides').select('id, ride_status, fare, created_at, vehicle_type').then(r => r, () => ({ data: [] as Record<string,unknown>[], error: null })),
      pgPool.query(`SELECT COUNT(*)::int AS n FROM driver_documents WHERE status = 'pending'`).catch(() => ({ rows: [{ n: 0 }] })),
      pgPool.query(`SELECT COUNT(*)::int AS n FROM incidents WHERE incid_status NOT IN ('resolved', 'closed')`).catch(() => ({ rows: [{ n: 0 }] })),
      pgPool.query(`SELECT COUNT(*)::int AS n FROM support_tickets WHERE status NOT IN ('resolved', 'closed')`).catch(() => ({ rows: [{ n: 0 }] })),
      pgPool.query(`SELECT COUNT(*)::int AS n FROM complaints WHERE comp_status NOT IN ('resolved', 'closed')`).catch(() => ({ rows: [{ n: 0 }] })),
      pgPool.query(`
        SELECT rl.new_status, rl.old_status, rl.created_at, rl.changed_by_role,
          r.vehicle_type,
          COALESCE(p.first_name || ' ' || p.last_name, 'Sistema') AS actor_name
        FROM ride_logs rl
        LEFT JOIN rides r ON rl.ride_id = r.id
        LEFT JOIN profiles p ON rl.changed_by_id = p.id
        ORDER BY rl.created_at DESC LIMIT 20
      `).catch(() => ({ rows: [] })),
    ]);

    const drivers = (profilesRes.data ?? []).filter((p: Record<string, unknown>) => p.role === 'chauffeur');
    const activeDrivers = drivers.filter((d: Record<string, unknown>) => d.status_val === 'online' || d.status_val === 'on_trip').length;
    const rides = (ridesRes.data ?? []) as Record<string, unknown>[];
    const totalRides = rides.length;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayRides = rides.filter((r: Record<string, unknown>) => new Date(r.created_at as string) >= todayStart);
    const revenueToday = todayRides.filter((r: Record<string, unknown>) => r.ride_status === 'completed').reduce((sum: number, r: Record<string, unknown>) => sum + (Number(r.fare) || 0), 0);
    const activeRides = rides.filter((r: Record<string, unknown>) => r.ride_status === 'in_progress' || r.ride_status === 'confirmed').length;
    const weekStart = new Date(Date.now() - 7 * 86400000);
    const weekRides = rides.filter((r: Record<string, unknown>) => new Date(r.created_at as string) >= weekStart);
    const revenueThisWeek = weekRides.filter((r: Record<string, unknown>) => r.ride_status === 'completed').reduce((sum: number, r: Record<string, unknown>) => sum + (Number(r.fare) || 0), 0);

    const statusLabel: Record<string, string> = {
      completed: 'Ride completed',
      cancelled: 'Ride cancelled',
      in_progress: 'Ride started',
      confirmed: 'Driver assigned',
      searching: 'Searching driver',
    };

    const recentActivity = (actRes.rows as Record<string, unknown>[]).map((row, i) => ({
      id: i,
      type: row.new_status === 'completed' ? 'ride_completed' : row.new_status === 'cancelled' ? 'complaint_filed' : 'payment_processed',
      description: `${statusLabel[row.new_status as string] || String(row.new_status)} — ${row.vehicle_type || 'Vehicle'} by ${row.actor_name}`,
      timestamp: row.created_at,
    }));

    res.json({
      totalRides,
      activeDrivers,
      revenueToday: Math.round(revenueToday * 100) / 100,
      activeRides,
      pendingDocuments: docsRes.rows[0]?.n ?? 0,
      openIncidents: incRes.rows[0]?.n ?? 0,
      openSupportTickets: supRes.rows[0]?.n ?? 0,
      openComplaints: compRes.rows[0]?.n ?? 0,
      pendingComplaints: compRes.rows[0]?.n ?? 0,
      avgRating: drivers.length > 0
        ? Math.round(((drivers as any[]).reduce((s: number, d: any) => s + (Number(d.rating) || 0), 0) / drivers.length) * 100) / 100
        : 0,
      driversOnline: activeDrivers,
      ridesThisWeek: weekRides.length,
      revenueThisWeek: Math.round(revenueThisWeek * 100) / 100,
      totalPassengers: (profilesRes.data ?? []).filter((p: Record<string, unknown>) => p.role === 'passenger').length,
      totalDrivers: drivers.length,
      recentActivity,
    });
  } catch (err: any) {
    logger.error(`[admin/dashboard] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ─── Drivers ─────────────────────────────────────────────────────────────────

adminRouter.get("/drivers", async (_req: Request, res: Response) => {
  try {
    const [ridesRes, docsRes] = await Promise.all([
      supabaseAdmin
        .from('rides')
        .select(`
          id, driver_id, ride_status, fare, total_price, tip_amount,
          created_at, completed_at, cancelled_at,
          pickup, dropoff, pickup_address, dropoff_address,
          distance_miles, duration_minutes, vehicle_type, payment_method,
          payment_status, rating, cancel_reason,
          passenger:profiles!rides_passenger_id_fkey(first_name, last_name, phone)
        `)
        .not('driver_id', 'is', null)
        .order('created_at', { ascending: false }),
      supabaseAdmin
        .from('driver_documents')
        .select('id, driver_id, doc_key, status, file_name, storage_url, created_at, updated_at'),
    ]);

    // El contador `total_rides` del perfil solo cuenta completados, pero la lista
    // de viajes muestra todos los que tuvo asignados. Verlos juntos parecía un
    // descuadre, así que aquí se cuenta contra la tabla real y se devuelven las
    // tres cifras por separado, junto con lo facturado y el último viaje.
    // La ficha del conductor tiene una pestaña de viajes que no tenía a qué
    // llamar: no existía endpoint de viajes por conductor. Se arma aquí la lista
    // ya lista para pintar, con los mismos nombres que usa /rides.
    const nombrePasajero = (p: unknown) => {
      const x = p as { first_name?: string; last_name?: string; phone?: string } | null;
      if (!x) return null;
      return `${x.first_name || ''} ${x.last_name || ''}`.trim() || x.phone || null;
    };
    const direccionViaje = (json: unknown, texto: unknown) => {
      const j = json as { address?: string } | string | null;
      if (typeof j === 'string' && j) return j;
      if (j && typeof j === 'object' && j.address) return j.address;
      return (texto as string) || null;
    };

    const viajePanel = (v: Record<string, unknown>) => ({
      id: v.id,
      date: v.created_at,
      createdAt: v.created_at,
      completedAt: v.completed_at,
      cancelledAt: v.cancelled_at,
      status: v.ride_status,
      passenger: nombrePasajero(v.passenger),
      origin: direccionViaje(v.pickup, v.pickup_address),
      destination: direccionViaje(v.dropoff, v.dropoff_address),
      fare: v.fare,
      totalPrice: v.total_price,
      tipAmount: v.tip_amount,
      distanceMiles: v.distance_miles as number | null,
      durationMinutes: v.duration_minutes,
      vehicleType: v.vehicle_type,
      paymentMethod: v.payment_method,
      paymentStatus: v.payment_status,
      rating: v.rating,
      cancelReason: v.cancel_reason,
      // Sólo en entradas de historial: quién canceló y de dónde sale la fila.
      ...(v.history_source ? { cancelledBy: v.cancelled_by, historySource: v.history_source } : {}),
    });

    type Conteo = {
      completados: number; cancelados: number; total: number;
      facturado: number; ultimo: string | null;
      viajes: Record<string, unknown>[];
    };
    const conteo = new Map<string, Conteo>();
    for (const v of (ridesRes.data ?? []) as Record<string, unknown>[]) {
      const id = String(v.driver_id);
      const c = conteo.get(id) ?? { completados: 0, cancelados: 0, total: 0, facturado: 0, ultimo: null, viajes: [] };
      c.total += 1;
      if (v.ride_status === 'completed') {
        c.completados += 1;
        c.facturado += Number(v.fare) || 0;
        const fin = v.completed_at as string | null;
        if (fin && (!c.ultimo || fin > c.ultimo)) c.ultimo = fin;
      } else if (v.ride_status === 'cancelled') c.cancelados += 1;

      c.viajes.push(viajePanel(v));
      conteo.set(id, c);
    }

    // `driver_documents` usa dos palabras para lo mismo — 'valid' y 'approved' —
    // así que se normalizan antes de contar. El estado global es el peor de los
    // individuales: un solo rechazado deja al conductor en 'rejected'.
    interface DocumentoPanel {
      id: unknown;
      docKey: string;
      /** Estado normalizado, el mismo vocabulario que `documentsState`. */
      state: 'aprobado' | 'rechazado' | 'pendiente';
      /** Valor crudo de la columna, por si hace falta auditarlo. */
      rawStatus: string;
      fileName: string | null;
      url: string | null;
      uploadedAt: unknown;
      updatedAt: unknown;
      /** false = subido pero fuera del esquema que se le exige. */
      required: boolean;
    }
    type Docs = { aprobados: number; pendientes: number; rechazados: number; total: number; lista: DocumentoPanel[] };
    const documentos = new Map<string, Docs>();
    for (const x of (docsRes.data ?? []) as Record<string, unknown>[]) {
      const id = String(x.driver_id);
      const d = documentos.get(id) ?? { aprobados: 0, pendientes: 0, rechazados: 0, total: 0, lista: [] };
      d.total += 1;
      const estado = normalizarEstadoDoc(x.status);
      if (estado === 'aprobado') d.aprobados += 1;
      else if (estado === 'rechazado') d.rechazados += 1;
      else d.pendientes += 1;
      d.lista.push({
        id: x.id,
        docKey: String(x.doc_key),
        state: estado,
        rawStatus: String(x.status),
        fileName: (x.file_name as string) || null,
        url: (x.storage_url as string) || null,
        uploadedAt: x.created_at,
        updatedAt: x.updated_at,
        required: ACCEPTED_DOC_KEYS.includes(String(x.doc_key)),
      });
      documentos.set(id, d);
    }
    for (const d of documentos.values()) d.lista.sort((a, b) => a.docKey.localeCompare(b.docKey));
    const estadoDocumentos = (d: Docs | undefined): 'sin_documentos' | 'rechazado' | 'pendiente' | 'aprobado' => {
      if (!d || d.total === 0) return 'sin_documentos';
      if (d.rechazados > 0) return 'rechazado';
      if (d.pendientes > 0) return 'pendiente';
      return 'aprobado';
    };

    // Filtrar solo por rol escondía a quien maneja con el rol equivocado: un
    // perfil marcado `passenger` acumulaba 12 viajes como conductor y no salía
    // en la lista, de modo que las sumas nunca cuadraban contra /rides. Se
    // incluye además a todo el que aparezca como `driver_id` en algún viaje.
    const idsQueManejaron = [...conteo.keys()];

    // Viajes que el conductor ya no tiene asignados pero sí vivió: los que canceló
    // o le reasignaron (el viaje pierde su driver_id) y los que se le ofrecieron y
    // el pasajero canceló antes de asignarse. Van en su lista como cancelados;
    // sólo los que él soltó cuentan en `ridesCancelled`. Se agregan después de
    // armar `idsQueManejaron` para no sumar a la lista a quien sólo recibió ofertas.
    const extrasPorConductor = await loadDriverHistoryExtras(null, `
      id, driver_id, ride_status, fare, total_price, tip_amount,
      created_at, completed_at, cancelled_at,
      pickup, dropoff, pickup_address, dropoff_address,
      distance_miles, duration_minutes, vehicle_type, payment_method,
      payment_status, rating, cancel_reason,
      passenger:profiles!rides_passenger_id_fkey(first_name, last_name, phone)
    `);
    for (const [driverId, filas] of extrasPorConductor) {
      const c = conteo.get(driverId) ?? { completados: 0, cancelados: 0, total: 0, facturado: 0, ultimo: null, viajes: [] };
      for (const v of filas) {
        if (v.history_source !== 'offered') c.cancelados += 1;
        c.viajes.push(viajePanel(v));
      }
      c.viajes.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
      conteo.set(driverId, c);
    }
    let consulta = supabaseAdmin.from('profiles').select('*');
    consulta = idsQueManejaron.length
      ? consulta.or(`role.in.(chauffeur,driver),id.in.(${idsQueManejaron.join(',')})`)
      : consulta.in('role', ['chauffeur', 'driver']);
    const { data, error } = await consulta.order('created_at', { ascending: false });
    if (error) throw error;

    const rolesDeConductor = new Set(['chauffeur', 'driver']);

    const drivers = (data ?? []).map((d: Record<string, unknown>) => {
    const veh = (d.vehicle ?? {}) as Record<string, unknown>;
    const via = conteo.get(String(d.id));
    const doc = documentos.get(String(d.id));
    const estadoDocs = estadoDocumentos(doc);
    const bgStatus = (d.background_check as Record<string, unknown> | undefined)?.status as string | undefined;
    const comision = Number(d.commission_rate ?? 10);
    const facturado = Math.round((via?.facturado ?? 0) * 100) / 100;
    return {
      id: d.id,
      name: [d.first_name, d.last_name].filter(Boolean).join(' ') || 'Unnamed Driver',
      phone: d.phone || '',
      email: d.email || '',
      status: d.status_val || 'offline',
      rating: d.rating || 5.0,
      ridesCompleted: via?.completados ?? 0,
      ridesCancelled: via?.cancelados ?? 0,
      ridesAssigned:  via?.total ?? 0,
      lastRideAt: via?.ultimo ?? null,
      lastRide:   via?.ultimo ?? null,   // alias: el panel lee este nombre
      // Tarifas de sus viajes completados y lo que le queda tras la comisión.
      // Es un cálculo, no un pago confirmado: los pagos reales viven en Stripe.
      earningsGross: facturado,
      earningsNet: Math.round(facturado * (1 - comision / 100) * 100) / 100,
      // `earnings` es lo que gana el conductor, o sea el neto: es lo que la
      // ficha rotula como "Ganancias".
      earnings: Math.round(facturado * (1 - comision / 100) * 100) / 100,
      // Sus viajes, ya ordenados del más reciente al más antiguo.
      rides: via?.viajes ?? [],
      // Contador guardado en el perfil, para poder detectar si se desincroniza.
      totalRidesCounter: d.total_rides || 0,
      // true = maneja viajes pero su perfil no tiene rol de conductor.
      roleMismatch: !rolesDeConductor.has(String(d.role)) && (via?.total ?? 0) > 0,
      role: d.role,

      vehicle: `${veh.make || ''} ${veh.model || ''} ${veh.year || ''}`.trim(),
      vehicleMake:  (veh.make  as string) || null,
      vehicleModel: (veh.model as string) || null,
      vehicleYear:  veh.year != null && veh.year !== '' ? String(veh.year) : null,
      plate:        (veh.plate as string) || '',
      vehicleColor: (veh.color as string) || '',
      vehiclePhotoUrl: (veh.vehicle_photo_url as string) || null,
      // El registro de conductor no pide vehículo: se carga después, en un paso
      // aparte que muchos nunca completan. Estos dos campos separan "no lo cargó
      // todavía" de "quedó aprobado sin vehículo", que no debería poder pasar.
      hasVehicle: Object.keys(veh).length > 0,
      approvedWithoutVehicle: d.verification_status === 'approved' && Object.keys(veh).length === 0,

      // ── Verificación ────────────────────────────────────────────────────────
      // Tres fuentes describían esto y se contradecían entre sí. `documentsState`
      // es la única derivada de los documentos reales y es la que debe mandar en
      // el panel; las otras dos se exponen tal cual para poder auditarlas.
      documentsState: estadoDocs,
      documentsApproved: doc?.aprobados ?? 0,
      documentsPending:  doc?.pendientes ?? 0,
      documentsRejected: doc?.rechazados ?? 0,
      documentsTotal:    doc?.total ?? 0,
      // Cada documento con su archivo, para que el detalle del conductor no
      // tenga que pedir /documents aparte y filtrar por conductor.
      documents: doc?.lista ?? [],
      verificationStatus: d.verification_status || 'pending_documents',
      backgroundCheckStatus: bgStatus || 'not_submitted',
      rejectionReason: d.rejection_reason || null,
      // true = el perfil dice una cosa y sus documentos dicen otra.
      verificationMismatch:
        (d.verification_status === 'approved') !== (estadoDocs === 'aprobado'),
      // Se conservan los nombres viejos para no romper el panel actual.
      verified: bgStatus === 'approved',
      docsStatus: bgStatus || 'not_submitted',

      joinedDate: (d.created_at as string | undefined)?.split('T')[0] || '',
      createdAt: d.created_at ?? null,
      membership: d.membership || 'free',
      operatingCity: d.operating_city || '',
      commissionRate: comision,
      stripeConnectStatus: d.stripe_connect_status || 'not_connected',
      priorityScore: d.priority_score || 1.0,
      accountStatus: d.account_status || 'active',
    };
    });
    res.json({ drivers });
  } catch (err: any) {
    logger.error(`[admin/drivers] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to load drivers' });
  }
});

adminRouter.post("/drivers/:id/suspend", async (req: Request, res: Response) => {
  try {
    const { reason, suspendedUntil } = req.body || {};
    const { data, error } = await supabaseAdmin.from('profiles')
      .update({
        account_status: 'suspended',
        status_val: 'offline',
        status_reason: reason || 'Suspended by admin',
        ...(suspendedUntil ? { suspension_until: suspendedUntil } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id).in('role', ['chauffeur', 'driver'])
      .select('email, first_name, last_name').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Driver not found' });

    const aviso = await enviarAvisoSuspension(
      { email: data.email, name: [data.first_name, data.last_name].filter(Boolean).join(' ') },
      { reason, suspendedUntil },
    );
    res.json({ success: true, driverId: req.params.id, action: 'suspended', reason, notification: aviso, timestamp: new Date().toISOString() });
  } catch (err: any) {
    logger.error(`[admin/drivers/suspend] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to suspend driver' });
  }
});

adminRouter.post("/drivers/:id/reactivate", async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin.from('profiles')
      .update({ account_status: 'active', status_val: 'offline', status_reason: null, suspension_until: null, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).in('role', ['chauffeur', 'driver'])
      .select('email, first_name, last_name').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Driver not found' });

    const aviso = await enviarAvisoReactivacion({
      email: data.email,
      name: [data.first_name, data.last_name].filter(Boolean).join(' '),
    });
    res.json({ success: true, driverId: req.params.id, action: 'reactivated', notification: aviso, timestamp: new Date().toISOString() });
  } catch (err: any) {
    logger.error(`[admin/drivers/reactivate] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to reactivate driver' });
  }
});

adminRouter.post("/drivers/:id/verify", async (req: Request, res: Response) => {
  try {
    const { error } = await supabaseAdmin.from('profiles')
      .update({
        background_check: { status: 'approved', completed_at: new Date().toISOString() },
        verification_status: 'approved',
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id).in('role', ['chauffeur', 'driver']);
    if (error) throw error;
    res.json({ success: true, driverId: req.params.id, action: 'verified', timestamp: new Date().toISOString() });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to verify driver' });
  }
});

adminRouter.patch("/drivers/:id", async (req: Request, res: Response) => {
  try {
    const allowed = ['status_val', 'phone', 'email', 'commission_rate', 'operating_city'];
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (req.body.status !== undefined) updates.status_val = req.body.status;
    const { data, error } = await supabaseAdmin.from('profiles').update(updates)
      .eq('id', req.params.id).in('role', ['chauffeur', 'driver']).select().single();
    if (error) throw error;
    res.json({ success: true, driver: data });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update driver' });
  }
});

// ─── Passengers ──────────────────────────────────────────────────────────────

adminRouter.get("/passengers", async (req: Request, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || '200');
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('role', 'passenger')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;

    // La ficha del pasajero lee `lastRide`, `totalSpent` y `createdAt`, pero el
    // perfil no guarda ninguno de los tres y aquí nunca se enviaban: el panel
    // pintaba "—". Se calculan contra la tabla de viajes, igual que en /drivers.
    const ids = (data ?? []).map((p: Record<string, unknown>) => String(p.id));
    const viajes = new Map<string, { ultimo: string | null; gastado: number }>();
    if (ids.length) {
      const { data: rides, error: ridesError } = await supabaseAdmin
        .from('rides')
        .select('passenger_id, ride_status, fare, created_at, completed_at')
        .in('passenger_id', ids);
      if (ridesError) throw ridesError;
      for (const v of (rides ?? []) as Record<string, unknown>[]) {
        if (v.ride_status !== 'completed') continue;
        const id = String(v.passenger_id);
        const c = viajes.get(id) ?? { ultimo: null, gastado: 0 };
        c.gastado += Number(v.fare) || 0;
        const fin = (v.completed_at || v.created_at) as string | null;
        if (fin && (!c.ultimo || fin > c.ultimo)) c.ultimo = fin;
        viajes.set(id, c);
      }
    }

    const passengers = (data ?? []).map((p: Record<string, unknown>) => {
      const via = viajes.get(String(p.id));
      return {
        id: p.id,
        name: [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Unnamed Passenger',
        phone: p.phone || '',
        email: p.email || '',
        status: p.account_status || 'active',
        totalRides: p.total_rides || 0,
        rating: p.rating || 0,
        membership: p.membership || 'standard',
        createdAt: p.created_at || null,
        joinedDate: (p.created_at as string | undefined)?.split('T')[0] || '',
        lastRide: via?.ultimo ?? null,
        totalSpent: via ? Math.round(via.gastado * 100) / 100 : null,
        stripeCustomerId: p.stripe_customer_id || null,
        infractionCount: p.infraction_count || 0,
      };
    });
    res.json({ passengers });
  } catch (err: any) {
    logger.error(`[admin/passengers] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to load passengers' });
  }
});

// La pestaña "Viajes" de la ficha del pasajero llamaba a esta ruta y no existía,
// así que siempre salía vacía. Devuelve el arreglo tal como lo pinta el panel,
// derivando estado y direcciones de las columnas que sí se escriben (ver /rides).
adminRouter.get("/passengers/:id/trips", async (req: Request, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || '50');
    const { data, error } = await supabaseAdmin
      .from('rides')
      .select(`
        id, created_at, completed_at, ride_status,
        pickup, dropoff, pickup_address, dropoff_address,
        fare, total_price,
        driver:profiles!rides_driver_id_fkey(first_name, last_name, phone)
      `)
      .eq('passenger_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;

    const direccion = (json: unknown, texto: unknown) => {
      const j = json as { address?: string } | string | null;
      if (typeof j === 'string' && j) return j;
      if (j && typeof j === 'object' && j.address) return j.address;
      return (texto as string) || null;
    };
    const conductor = (d: unknown) => {
      const x = d as { first_name?: string; last_name?: string; phone?: string } | null;
      if (!x) return 'Sin conductor asignado';
      return `${x.first_name || ''} ${x.last_name || ''}`.trim() || x.phone || 'Conductor sin nombre';
    };

    const trips = (data ?? []).map((row: Record<string, unknown>) => ({
      id: row.id,
      driverName: conductor(row.driver),
      origin: direccion(row.pickup, row.pickup_address) || '—',
      destination: direccion(row.dropoff, row.dropoff_address) || '—',
      status: row.ride_status,
      fare: row.fare != null ? Number(row.fare) : null,
      totalPrice: row.total_price != null ? Number(row.total_price) : null,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    }));
    res.json(trips);
  } catch (err: any) {
    logger.error(`[admin/passengers/trips] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to load passenger trips' });
  }
});

adminRouter.post("/passengers/:id/suspend", async (req: Request, res: Response) => {
  try {
    const { reason, suspendedUntil } = req.body || {};
    const { data, error } = await supabaseAdmin.from('profiles')
      .update({
        account_status: 'suspended',
        status_reason: reason || 'Suspended by admin',
        ...(suspendedUntil ? { suspension_until: suspendedUntil } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id).eq('role', 'passenger')
      .select('email, first_name, last_name').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Passenger not found' });

    const aviso = await enviarAvisoSuspension(
      { email: data.email, name: [data.first_name, data.last_name].filter(Boolean).join(' ') },
      { reason, suspendedUntil },
    );
    res.json({ success: true, passengerId: req.params.id, action: 'suspended', reason, notification: aviso });
  } catch (err: any) {
    logger.error(`[admin/passengers/suspend] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to suspend passenger' });
  }
});

adminRouter.post("/passengers/:id/reactivate", async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin.from('profiles')
      .update({ account_status: 'active', status_reason: null, suspension_until: null, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('role', 'passenger')
      .select('email, first_name, last_name').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Passenger not found' });

    const aviso = await enviarAvisoReactivacion({
      email: data.email,
      name: [data.first_name, data.last_name].filter(Boolean).join(' '),
    });
    res.json({ success: true, passengerId: req.params.id, action: 'reactivated', notification: aviso });
  } catch (err: any) {
    logger.error(`[admin/passengers/reactivate] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to reactivate passenger' });
  }
});

// ─── Documents ───────────────────────────────────────────────────────────────

adminRouter.get("/documents", async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('driver_documents')
      .select('id, driver_id, doc_key, document_type, status, storage_url, file_name, driver_name, created_at, updated_at')
      .order('created_at', { ascending: false });
    if (error) return res.json({ documents: [] });
    const docs = (data || []).map((d: Record<string, unknown>) => ({
      id: d.id,
      driverId: d.driver_id,
      driverName: d.driver_name || 'Unknown Driver',
      type: d.doc_key || d.document_type || 'document',
      fileName: d.file_name || 'document',
      status: d.status || 'pending',
      imageUrl: d.storage_url || null,
      uploadDate: d.created_at,
      updatedAt: d.updated_at,
      expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    }));
    return res.json({ documents: docs });
  } catch {
    return res.json({ documents: [] });
  }
});

adminRouter.post("/documents/:id/approve", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { notes } = req.body as { notes?: string };
  try {
    // Se escribía 'valid' aquí pero había documentos guardados como 'approved',
    // y el conteo de abajo solo miraba 'valid': un conductor con los once
    // revisados podía no aprobarse nunca. Ahora se escribe una sola palabra y
    // el estado del conductor lo decide `recalcularVerificacion`, que compara
    // contra los tipos requeridos y exige vehículo.
    const { data: doc, error: docError } = await supabaseAdmin
      .from('driver_documents').update({ status: 'approved', updated_at: new Date().toISOString() })
      .eq('id', id).select().single();
    if (docError || !doc) return res.status(404).json({ error: 'Document not found.' });
    const driverId = String((doc as Record<string, unknown>).driver_id);
    await recalcularVerificacion(driverId);
    void notes;
    return res.json({ success: true, document: { id, status: 'approved', driverName: (doc as Record<string, unknown>).driver_name || 'Driver', type: (doc as Record<string, unknown>).doc_key || 'document', fileName: (doc as Record<string, unknown>).file_name || 'document', uploadDate: (doc as Record<string, unknown>).created_at, expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), imageUrl: (doc as Record<string, unknown>).storage_url || null, updatedAt: new Date().toISOString() } });
  } catch {
    return res.status(500).json({ error: 'Failed to approve document.' });
  }
});

adminRouter.post("/documents/:id/reject", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { notes } = req.body as { notes?: string };
  try {
    const { data: doc, error: docError } = await supabaseAdmin
      .from('driver_documents').update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', id).select().single();
    if (docError || !doc) return res.status(404).json({ error: 'Document not found.' });
    const driverId = String((doc as Record<string, unknown>).driver_id);
    await recalcularVerificacion(driverId);
    if (notes) {
      await supabaseAdmin.from('profiles').update({ rejection_reason: notes, updated_at: new Date().toISOString() }).eq('id', driverId);
    }
    return res.json({ success: true, document: { id, status: 'rejected', driverName: (doc as Record<string, unknown>).driver_name || 'Driver', type: (doc as Record<string, unknown>).doc_key || 'document', fileName: (doc as Record<string, unknown>).file_name || 'document', uploadDate: (doc as Record<string, unknown>).created_at, expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), imageUrl: (doc as Record<string, unknown>).storage_url || null, updatedAt: new Date().toISOString() } });
  } catch {
    return res.status(500).json({ error: 'Failed to reject document.' });
  }
});

adminRouter.post("/documents/:id/request-reupload", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { reason } = req.body as { reason?: string };
  try {
    const { data: doc } = await supabaseAdmin.from('driver_documents').update({ status: 'pending', updated_at: new Date().toISOString() }).eq('id', id).select().single();
    if (doc) {
      const driverId = String((doc as Record<string, unknown>).driver_id);
      await recalcularVerificacion(driverId);
      if (reason) {
        await supabaseAdmin.from('profiles').update({ rejection_reason: reason, updated_at: new Date().toISOString() }).eq('id', driverId);
      }
    }
    return res.json({ success: true, document: { id, status: 'pending' } });
  } catch {
    return res.status(500).json({ error: 'Failed to request re-upload.' });
  }
});

// ─── Fares (DB-persisted) ─────────────────────────────────────────────────────

adminRouter.get("/fares", async (_req: Request, res: Response) => {
  const fares = await getFaresFromDB();
  // Las políticas (espera, no-show, cancelación) viajan con las tarifas para que
  // la pantalla las muestre sin una segunda petición. Son de sólo lectura: se
  // cambian en código.
  res.json({ fares, pricingPolicy: getPricingPolicy() });
});

adminRouter.put("/fares", async (req: Request, res: Response) => {
  const { vehicleClass, updates } = req.body;
  const fares = await getFaresFromDB();
  if (!vehicleClass || !fares[vehicleClass]) {
    return res.status(400).json({ error: "Invalid vehicle class" });
  }
  // Campos que el motor de cobro aplica de verdad.
  //
  // Con las tarifas del cliente el precio por milla pasa a tres tramos y la
  // espera tiene tarifa propia. `includedMiles`, `perMile` y `cancellationFee`
  // salen: ya no los aplica ningún cálculo. Quedan fuera A PROPÓSITO y vuelven en
  // `rejected` — un panel sin actualizar que siga mandando `perMile` no puede
  // pisar los tramos, y la pantalla ya avisa de lo que el servidor descartó.
  const allowed = [
    'minFare', 'perMileTier1', 'perMileTier2', 'perMileTier3',
    'perMin', 'waitPerMin', 'serviceFee', 'perHour', 'minHours',
  ] as const satisfies readonly (keyof FareClass)[];

  const applied: Record<string, number> = {};
  const actualizada: FareClass = { ...fares[vehicleClass] };
  for (const key of allowed) {
    if (updates[key] === undefined) continue;
    const val = parseFloat(updates[key]);
    if (!isNaN(val) && val >= 0) {
      actualizada[key] = val;
      applied[key] = val;
    }
  }
  fares[vehicleClass] = actualizada;

  // Lo que el panel mandó y no se guardó, para que pueda avisarlo en vez de dar
  // por hecho que se aplicó todo.
  const permitidos: readonly string[] = allowed;
  const rejected = Object.keys(updates ?? {}).filter(k => !permitidos.includes(k));

  try {
    await saveFaresToDB(fares);
    // Sin esto el cambio no surte efecto hasta el próximo arranque.
    await invalidateFares();
  } catch (e) {
    logger.warn({ err: e }, '[admin/fares] DB persist failed, using memory');
  }

  // Quién cambió qué precio. Mover las tarifas a la base les quita la revisión de
  // código y el historial de git, así que el rastro tiene que quedar en algún lado.
  //
  // OJO: `GET /api/admin/audit-logs` hoy lee `ride_logs`, no esta tabla, así que
  // el cambio queda registrado pero todavía no se ve en el panel. Exponerlo es un
  // pendiente aparte.
  const detalle = Object.entries(applied).map(([k, v]) => `${k}=${v}`).join(', ') || 'sin cambios';
  try {
    await pgPool.query(
      `INSERT INTO audit_logs (admin_name, action, target, ip) VALUES ($1, $2, $3, $4)`,
      [
        req.adminUser?.name || req.adminUser?.email || 'desconocido',
        'fares.update',
        `${vehicleClass} → ${detalle}`,
        req.ip ?? null,
      ],
    );
  } catch (e) {
    // Un fallo de auditoría no debe tumbar el cambio de tarifa, pero sí verse.
    logger.warn({ err: errMsg(e), vehicleClass, applied }, '[admin/fares] no se pudo registrar en audit_logs');
  }

  res.json({ success: true, fares, updatedClass: vehicleClass, applied, rejected, timestamp: new Date().toISOString() });
});

// ─── Rides ───────────────────────────────────────────────────────────────────

adminRouter.get("/rides", async (req: Request, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || '200');
    const status = req.query.status as string | undefined;

    // Explicit column list rather than `*`, for two reasons:
    //
    // 1. The table still carries a legacy `status` column that nothing writes
    //    any more — every row reads "completed" while `ride_status` holds the
    //    real value. Selecting `*` handed both to the panel, which picked the
    //    stale one and reported 66 completed rides when 56 were cancelled.
    //    Leaving it out makes the wrong field unreachable.
    //
    // 2. `passenger_name` / `driver_name` exist but were never populated
    //    (0 of 66 rows), so the names have to come from a join.
    let query = supabaseAdmin
      .from('rides')
      .select(`
        id, created_at, ride_status, booking_type, scheduled_at,
        started_at, completed_at, cancelled_at, cancel_reason,
        pickup, dropoff, pickup_address, dropoff_address,
        stops, distance_miles, duration_minutes,
        fare, tip_amount, promo_discount, total_price, cancellation_fee,
        payment_status, payment_method, payment_intent_id,
        vehicle_type, surge_multiplier, rating, passenger_rating,
        passenger_id, driver_id,
        passenger:profiles!rides_passenger_id_fkey(id, first_name, last_name, email, phone),
        driver:profiles!rides_driver_id_fkey(id, first_name, last_name, email, phone)
      `)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status && status !== 'all') query = query.eq('ride_status', status);
    const { data, error } = await query;
    if (error) throw error;

    // El nombre es solo el nombre. La mayoría de pasajeros entra por login
    // telefónico y nunca completa el perfil (58 de 66 viajes), así que aquí sale
    // null y el teléfono viaja en su propio campo: mezclarlos hacía que el panel
    // pintara un número donde dice "nombre".
    const nombre = (p: unknown) => {
      const x = p as { first_name?: string; last_name?: string } | null;
      if (!x) return null;
      return `${x.first_name || ''} ${x.last_name || ''}`.trim() || null;
    };
    const telefono = (p: unknown) => (p as { phone?: string } | null)?.phone || null;
    const correo   = (p: unknown) => (p as { email?: string } | null)?.email || null;

    // La dirección viaja en la columna JSONB, con el TEXT como respaldo: hay
    // filas donde una de las dos está vacía.
    const direccion = (json: unknown, texto: unknown) => {
      const j = json as { address?: string } | string | null;
      if (typeof j === 'string' && j) return j;
      if (j && typeof j === 'object' && j.address) return j.address;
      return (texto as string) || null;
    };

    // El panel lee `status`, `origin`, `destination`, `distance` y `duration`,
    // pero esas cinco columnas están muertas (0 de 66 filas con dato, igual que
    // `status`). Se derivan aquí de las columnas que sí se escriben para que la
    // vista quede completa sin tocar el frontend.
    const rides = (data ?? []).map((row: Record<string, unknown>) => {
      const millas = row.distance_miles as number | null;
      const minutos = row.duration_minutes as number | null;
      return {
        ...row,
        status:        row.ride_status,
        origin:         direccion(row.pickup, row.pickup_address),
        destination:    direccion(row.dropoff, row.dropoff_address),
        pickupAddress:  direccion(row.pickup, row.pickup_address),
        dropoffAddress: direccion(row.dropoff, row.dropoff_address),
        distance:      millas  != null ? `${Number(millas).toFixed(1)} mi` : null,
        duration:      minutos != null ? `${minutos} min` : null,
        vehicleClass:  row.vehicle_type,
        paymentMethod: row.payment_method,
        cancelReason:  row.cancel_reason,
        date:          row.created_at,
        // null = el perfil no tiene nombre; el panel decide si cae al teléfono.
        passenger:      nombre(row.passenger),
        passengerName:  nombre(row.passenger),
        passengerPhone: telefono(row.passenger),
        passengerEmail: correo(row.passenger),
        // driverName null = viaje aún sin conductor asignado.
        driver:      nombre(row.driver),
        driverName:  nombre(row.driver),
        driverPhone: telefono(row.driver),
        driverEmail: correo(row.driver),
        hasDriver:   row.driver_id != null,
      };
    });

    // Quién canceló cada viaje cancelado, según driver_ride_events: el conductor
    // (con su motivo) o el sistema al reasignarlo. Si además el viaje perdió su
    // driver_id —salía "Sin asignar"— se muestra el conductor que lo soltó.
    // `hasDriver` sigue en false: no tiene conductor actual.
    const filas = rides as Record<string, unknown>[];
    const canceladas = filas.filter((r) => r.ride_status === 'cancelled').map((r) => String(r.id));
    const liberaciones = canceladas.length ? await loadReleasedDrivers(canceladas) : new Map();
    if (liberaciones.size) {
      const idsConductores = [...new Set([...liberaciones.values()].map((l) => l.driver_id))];
      const { data: perfiles } = await supabaseAdmin
        .from('profiles').select('id, first_name, last_name, email, phone').in('id', idsConductores);
      const perfilPorId = new Map(((perfiles ?? []) as Record<string, unknown>[]).map((p) => [String(p.id), p]));
      for (const r of filas) {
        const l = liberaciones.get(String(r.id));
        if (!l) continue;
        Object.assign(r, {
          releasedByDriverId: l.driver_id,
          cancelledBy:        l.event === 'driver_cancelled' ? 'driver' : 'system',
          driverCancelReason: l.reason,
        });
        if (!r.hasDriver) {
          const p = perfilPorId.get(l.driver_id) ?? null;
          Object.assign(r, {
            driver:      nombre(p),
            driverName:  nombre(p),
            driverPhone: telefono(p),
            driverEmail: correo(p),
          });
        }
      }
    }

    res.json({ rides });
  } catch (err: any) {
    logger.error(`[admin/rides] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to load rides' });
  }
});

adminRouter.post("/rides/:id/refund", async (req: Request, res: Response) => {
  const { amount, reason } = req.body || {};
  const stripe = getStripeAdmin();
  if (!stripe) {
    return res.status(503).json({
      error: 'Stripe not configured on this server. Please process the refund manually at dashboard.stripe.com.',
      manual: true,
    });
  }
  try {
    const { data: ride } = await supabaseAdmin.from('rides').select('*').eq('id', req.params.id).single();
    if (!ride) return res.status(404).json({ error: 'Ride not found.' });
    const paymentIntentId = (ride as Record<string, unknown>).payment_intent_id;
    if (!paymentIntentId) {
      return res.status(400).json({ error: 'No Stripe payment recorded for this ride. It may have been a demo or cash payment.' });
    }
    const refundParams: Stripe.RefundCreateParams = {
      payment_intent: paymentIntentId as string,
      reason: 'requested_by_customer',
      metadata: { admin_reason: reason || '', ride_id: req.params.id },
    };
    if (amount && !isNaN(parseFloat(String(amount)))) {
      refundParams.amount = Math.round(parseFloat(String(amount)) * 100);
    }
    const refund = await stripe.refunds.create(refundParams);
    await supabaseAdmin.from('rides').update({ ride_status: 'refunded', updated_at: new Date().toISOString() }).eq('id', req.params.id);
    res.json({ success: true, refundId: refund.id, amount: refund.amount / 100, status: refund.status, rideId: req.params.id });
  } catch (err: any) {
    logger.error(`[admin/refund] ${errMsg(err)}`);
    res.status(500).json({ error: `Refund failed: ${errMsg(err)}` });
  }
});

adminRouter.patch("/rides/:id/status", async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const { error } = await supabaseAdmin.from('rides').update({ ride_status: status, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true, rideId: req.params.id, status });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update ride status' });
  }
});

// ─── Revenue (real analytics) ─────────────────────────────────────────────────

adminRouter.get("/revenue", async (_req: Request, res: Response) => {
  try {
    const [allRidesRes, dailyRes, byClassRes, recentTxRes, hourlyRes, topDriversRes, prevWeekRes] = await Promise.all([
      supabaseAdmin.from('rides').select('fare, created_at, vehicle_type, ride_status, payment_status'),
      pgPool.query(`
        SELECT DATE(created_at) AS day,
          COALESCE(SUM(fare), 0)::float AS total,
          COUNT(*) AS count
        FROM rides
        WHERE ride_status = 'completed' AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at) ORDER BY day ASC
      `).catch(() => ({ rows: [] as Record<string, unknown>[] })),
      pgPool.query(`
        SELECT vehicle_type,
          COALESCE(SUM(fare), 0)::float AS amount,
          COUNT(*) AS rides
        FROM rides WHERE ride_status = 'completed'
        GROUP BY vehicle_type ORDER BY amount DESC
      `).catch(() => ({ rows: [] as unknown[] })),
      // Dos joins a profiles: uno por el pasajero y otro por el chofer. Antes
      // sólo estaba el del pasajero, así que la columna Conductor del panel
      // mostraba siempre «—» aunque el dato estuviera en la fila del viaje.
      // Los nombres se arman con COALESCE por cada parte: en SQL, concatenar algo
      // con NULL anula la expresión entera, así que quien tenga nombre pero no
      // apellido se mostraría como 'Passenger'. Hay un perfil así en producción.
      pgPool.query(`
        SELECT r.id, r.fare, r.created_at, r.vehicle_type,
          COALESCE(NULLIF(TRIM(COALESCE(pp.first_name,'') || ' ' || COALESCE(pp.last_name,'')), ''), 'Passenger') AS passenger_name,
          COALESCE(NULLIF(TRIM(COALESCE(dp.first_name,'') || ' ' || COALESCE(dp.last_name,'')), ''), '')          AS driver_name
        FROM rides r
        LEFT JOIN profiles pp ON r.passenger_id = pp.id
        LEFT JOIN profiles dp ON r.driver_id    = dp.id
        WHERE r.ride_status = 'completed' AND r.fare IS NOT NULL
        ORDER BY r.created_at DESC LIMIT 30
      `).catch(() => ({ rows: [] as unknown[] })),
      // Hourly revenue heatmap — last 30 days grouped by hour of day (0–23)
      pgPool.query(`
        SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/New_York') AS hour,
          COALESCE(SUM(fare), 0)::float AS total,
          COUNT(*) AS count
        FROM rides
        WHERE ride_status = 'completed' AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY hour ORDER BY hour ASC
      `).catch(() => ({ rows: [] as unknown[] })),
      // Mejores conductores por ingreso. El panel ya tenía la tabla montada
      // (revenue/page.tsx:245) pero el endpoint nunca devolvía `topDrivers`, así
      // que se mostraba vacía con su mensaje de «sin datos».
      pgPool.query(`
        SELECT p.id,
               COALESCE(NULLIF(TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')), ''), 'Driver') AS name,
               COUNT(*)                        AS rides,
               COALESCE(SUM(r.fare), 0)::float AS revenue,
               COALESCE(p.rating, 0)::float    AS rating
        FROM rides r
        JOIN profiles p ON r.driver_id = p.id
        WHERE r.ride_status = 'completed'
        GROUP BY p.id, p.first_name, p.last_name, p.rating
        ORDER BY revenue DESC
        LIMIT 10
      `).catch(() => ({ rows: [] as unknown[] })),
      // Previous week revenue for week-over-week comparison
      pgPool.query(`
        SELECT COALESCE(SUM(fare), 0)::float AS total
        FROM rides
        WHERE ride_status = 'completed'
          AND created_at >= NOW() - INTERVAL '14 days'
          AND created_at < NOW() - INTERVAL '7 days'
      `).catch(() => ({ rows: [] as unknown[] })),
    ]);

    const all = (allRidesRes.data ?? []) as Record<string, unknown>[];
    const completed = all.filter(r => r.ride_status === 'completed');
    const sum = (arr: Record<string, unknown>[]) => arr.reduce((s: number, r: Record<string, unknown>) => s + (parseFloat(String(r.fare)) || 0), 0);

    // Un viaje completado no es un viaje cobrado: solo cuenta como cobrado si
    // `payment_status` llegó a 'paid'. Antes todo lo completado se reportaba como
    // ingreso, de modo que un cobro no confirmado inflaba las cifras del panel.
    const collected = completed.filter(r => r.payment_status === 'paid');
    const uncollected = completed.filter(r => r.payment_status !== 'paid');

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const yesterdayStart = new Date(todayStart.getTime() - 86400000);
    const weekStart = new Date(Date.now() - 7 * 86400000);
    const prevWeekStart = new Date(Date.now() - 14 * 86400000);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const lastMonthStart = new Date(monthStart); lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);
    const totalAllTime = sum(completed);

    const todayRevenue   = Math.round(sum(completed.filter(r => new Date(r.created_at as string) >= todayStart)) * 100) / 100;
    const yesterdayRevenue = Math.round(sum(completed.filter(r => new Date(r.created_at as string) >= yesterdayStart && new Date(r.created_at as string) < todayStart)) * 100) / 100;
    const thisWeekRevenue  = Math.round(sum(completed.filter(r => new Date(r.created_at as string) >= weekStart)) * 100) / 100;
    const prevWeekRevenue  = Math.round(parseFloat(String((prevWeekRes.rows[0] as Record<string, unknown>)?.total ?? '0')) * 100) / 100;
    const thisMonthRevenue = Math.round(sum(completed.filter(r => new Date(r.created_at as string) >= monthStart)) * 100) / 100;
    const lastMonthRevenue = Math.round(sum(completed.filter(r => new Date(r.created_at as string) >= lastMonthStart && new Date(r.created_at as string) < monthStart)) * 100) / 100;

    const growthPct = (current: number, previous: number) =>
      previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;

    // Importes a dos decimales, no a dólares enteros: un día de $31.90 se
    // reportaba como $32, y esa diferencia se acumula a lo largo del gráfico.
    const byVehicleClass = (byClassRes.rows as Record<string, unknown>[]).map((r: Record<string, unknown>) => ({
      vehicleClass: r.vehicle_type || 'Unknown',
      amount: Math.round((parseFloat(String(r.amount)) || 0) * 100) / 100,
      rides: parseInt(String(r.rides)),
      percentage: totalAllTime > 0 ? Math.round((parseFloat(String(r.amount)) / totalAllTime) * 100) : 0,
    }));

    const dailyRevenue = (dailyRes.rows as Record<string, unknown>[]).map((r: Record<string, unknown>) => ({
      day: new Date(r.day as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      amount: Math.round((parseFloat(String(r.total)) || 0) * 100) / 100,
      count: parseInt(String(r.count)),
    }));

    // Build full 24-hour heatmap array (hours 0–23), filling missing hours with 0
    const hourlyMap: Record<number, { total: number; count: number }> = {};
    for (const row of (hourlyRes.rows as Record<string, unknown>[])) {
      const h = parseInt(String(row.hour));
      hourlyMap[h] = { total: Math.round(parseFloat(String(row.total)) || 0), count: parseInt(String(row.count)) };
    }
    const hourlyRevenue = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      total: hourlyMap[h]?.total ?? 0,
      count: hourlyMap[h]?.count ?? 0,
    }));

    const recentTransactions = (recentTxRes.rows as Record<string, unknown>[]).map((r: Record<string, unknown>) => ({
      id: r.id,
      passenger: r.passenger_name || 'Passenger',
      driverName: String(r.driver_name ?? '').trim(),
      amount: parseFloat(String(r.fare)) || 0,
      type: 'ride_fare',
      rideId: (r.id as string)?.slice(-8).toUpperCase(),
      date: r.created_at,
      vehicleType: r.vehicle_type,
    }));

    const topDrivers = (topDriversRes.rows as Record<string, unknown>[]).map((r: Record<string, unknown>) => ({
      id: r.id,
      name: r.name,
      rides: parseInt(String(r.rides)) || 0,
      revenue: Math.round((parseFloat(String(r.revenue)) || 0) * 100) / 100,
      rating: Math.round((parseFloat(String(r.rating)) || 0) * 10) / 10,
    }));

    // Cuántos de los viajes creados llegaron a completarse. El panel lo pinta con
    // `.toFixed(1)`, así que se devuelve ya redondeado a un decimal.
    const completionRate = all.length > 0
      ? Math.round((completed.length / all.length) * 1000) / 10
      : 0;

    res.json({
      today: todayRevenue,
      yesterday: yesterdayRevenue,
      todayGrowth: growthPct(todayRevenue, yesterdayRevenue),
      thisWeek: thisWeekRevenue,
      prevWeek: prevWeekRevenue,
      weekGrowth: growthPct(thisWeekRevenue, prevWeekRevenue),
      thisMonth: thisMonthRevenue,
      lastMonth: lastMonthRevenue,
      monthGrowth: growthPct(thisMonthRevenue, lastMonthRevenue),
      totalAllTime: Math.round(totalAllTime * 100) / 100,
      // Ojo: el promedio es sobre lo FACTURADO, no sobre lo cobrado. Con
      // `uncollectedRides` a la vista se puede contrastar cuánto de eso entró.
      avgFare: completed.length > 0 ? Math.round(sum(completed) / completed.length * 100) / 100 : 0,
      totalCompletedRides: completed.length,
      completionRate,
      // Facturado vs cobrado. `totalAllTime` sigue siendo lo facturado para no
      // romper el panel; estos campos dicen cuánto de eso entró de verdad.
      billedAllTime: Math.round(totalAllTime * 100) / 100,
      collectedAllTime: Math.round(sum(collected) * 100) / 100,
      uncollectedAllTime: Math.round(sum(uncollected) * 100) / 100,
      uncollectedRides: uncollected.length,
      byVehicleClass,
      dailyRevenue,
      hourlyRevenue,
      topDrivers,
      recentTransactions,
    });
  } catch (err: any) {
    logger.error(`[admin/revenue] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to load revenue' });
  }
});

// ─── Incidents (connected to real DB) ────────────────────────────────────────

adminRouter.get("/incidents", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(`
      SELECT i.*,
        COALESCE(pr.first_name || ' ' || pr.last_name, i.reporter_name, 'Unknown') AS "reporterName",
        COALESCE(dr.first_name || ' ' || dr.last_name, 'N/A') AS "driverName",
        COALESCE(ps.first_name || ' ' || ps.last_name, 'N/A') AS "passengerName"
      FROM incidents i
      LEFT JOIN profiles pr ON i.reported_by_id = pr.id
      LEFT JOIN profiles dr ON i.driver_id = dr.id
      LEFT JOIN profiles ps ON i.passenger_id = ps.id
      ORDER BY
        CASE i.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END ASC,
        i.created_at DESC
      LIMIT 500
    `);
    // Las fotos viven en un bucket privado: se firman al pedir la lista, con una
    // hora de validez, para que el panel pueda mostrarlas sin hacerlas públicas.
    const firmar = async (adjuntos: unknown) => {
      const lista = Array.isArray(adjuntos) ? (adjuntos as Array<{ path?: string; mimeType?: string }>) : [];
      const urls = await Promise.all(lista.map(async (f) => {
        if (!f?.path) return null;
        const { data } = await supabaseAdmin.storage.from('incident-photos').createSignedUrl(f.path, 3600);
        return data?.signedUrl ? { url: data.signedUrl, mimeType: f.mimeType ?? null } : null;
      }));
      return urls.filter((u) => u !== null);
    };

    const incidents = await Promise.all(rows.map(async (r: Record<string, unknown>) => ({
      id: r.id,
      rideId: r.ride_id,
      driverName: r.driverName,
      passengerName: r.passengerName,
      reportedBy: r.reporterName,
      reporterRole: r.reporter_role ?? null,
      type: r.incid_type,
      severity: r.severity || 'low',
      status: r.incid_status || 'open',
      location: r.location,
      lat: r.lat != null ? Number(r.lat) : null,
      lng: r.lng != null ? Number(r.lng) : null,
      occurredAt: r.occurred_at ?? null,
      photos: await firmar(r.attachments),
      description: r.description,
      notes: r.notes,
      resolution: r.resolution,
      date: r.created_at,
      updatedAt: r.updated_at,
    })));
    res.json({ incidents });
  } catch (err: any) {
    logger.error(`[admin/incidents] ${errMsg(err)}`);
    res.json({ incidents: [] });
  }
});

adminRouter.post("/incidents/:id/update", async (req: Request, res: Response) => {
  const { status, notes, resolution } = req.body || {};
  try {
    const { rows } = await pgPool.query(
      `UPDATE incidents SET incid_status = $1, notes = $2, resolution = $3, updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [status || 'open', notes || null, resolution || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Incident not found' });
    const r = rows[0];
    res.json({
      success: true,
      incident: { id: r.id, rideId: r.ride_id, type: r.incid_type, severity: r.severity, status: r.incid_status, description: r.description, notes: r.notes, resolution: r.resolution, date: r.created_at, updatedAt: r.updated_at }
    });
  } catch (err: any) {
    logger.error(`[admin/incidents/update] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to update incident' });
  }
});

adminRouter.post("/incidents", async (req: Request, res: Response) => {
  const { rideId, driverId, passengerId, reportedById, reporterRole, reporterName, incidType, severity, location, description } = req.body;
  try {
    const { rows } = await pgPool.query(
      `INSERT INTO incidents (ride_id, driver_id, passenger_id, reported_by_id, reporter_role, reporter_name, incid_type, severity, location, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [rideId || null, driverId || null, passengerId || null, reportedById || null, reporterRole || 'admin', reporterName || 'Admin', incidType || 'other', severity || 'low', location || null, description || null]
    );
    res.json({ success: true, incident: rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create incident' });
  }
});

// ─── Complaints (connected to real DB) ───────────────────────────────────────

adminRouter.get("/complaints", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(`
      SELECT c.*,
        COALESCE(p.first_name || ' ' || p.last_name, c.user_name, 'User') AS "displayUserName",
        COALESCE(d.first_name || ' ' || d.last_name, 'N/A') AS "displayDriverName"
      FROM complaints c
      LEFT JOIN profiles p ON c.user_id = p.id
      LEFT JOIN profiles d ON c.driver_id = d.id
      ORDER BY
        CASE c.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 ELSE 3 END ASC,
        c.created_at DESC
      LIMIT 500
    `);
    res.json({
      complaints: rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        rideId: r.ride_id,
        userId: r.user_id,
        userName: r.displayUserName,
        driverName: r.displayDriverName,
        userType: r.user_type || 'passenger',
        type: r.complaint_type,
        status: r.comp_status || 'open',
        priority: r.priority || 'normal',
        description: r.description,
        resolution: r.resolution,
        adminNotes: r.admin_notes,
        date: r.created_at,
        resolvedAt: r.resolved_at,
      }))
    });
  } catch (err: any) {
    logger.error(`[admin/complaints] ${errMsg(err)}`);
    res.json({ complaints: [] });
  }
});

adminRouter.post("/complaints", async (req: Request, res: Response) => {
  const { rideId, userId, driverId, userName, userType, complaintType, priority, description } = req.body;
  try {
    const { rows } = await pgPool.query(
      `INSERT INTO complaints (ride_id, user_id, driver_id, user_name, user_type, complaint_type, priority, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [rideId || null, userId || null, driverId || null, userName || null, userType || 'passenger', complaintType || 'other', priority || 'normal', description || null]
    );
    res.json({ success: true, complaint: rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create complaint' });
  }
});

adminRouter.post("/complaints/:id/resolve", async (req: Request, res: Response) => {
  const { resolution } = req.body || {};
  try {
    const { rows } = await pgPool.query(
      `UPDATE complaints SET comp_status = 'resolved', resolution = $1, resolved_at = NOW(), updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [resolution || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Complaint not found' });
    const r = rows[0];
    res.json({ success: true, complaint: { id: r.id, status: r.comp_status, resolution: r.resolution, resolvedAt: r.resolved_at } });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to resolve complaint' });
  }
});

adminRouter.post("/complaints/:id/investigate", async (req: Request, res: Response) => {
  const { notes } = req.body || {};
  try {
    const { rows } = await pgPool.query(
      `UPDATE complaints SET comp_status = 'investigating', admin_notes = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [notes || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Complaint not found' });
    const r = rows[0];
    res.json({ success: true, complaint: { id: r.id, status: r.comp_status, adminNotes: r.admin_notes } });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update complaint' });
  }
});

// ─── Support Tickets (connected to real DB) ───────────────────────────────────

adminRouter.get("/support", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(`
      SELECT st.*,
        COALESCE(p.first_name || ' ' || p.last_name, st.user_name, 'User') AS "displayName"
      FROM support_tickets st
      LEFT JOIN profiles p ON st.user_id = p.id
      ORDER BY
        CASE st.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END ASC,
        st.created_at DESC
      LIMIT 500
    `);
    res.json({
      tickets: rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        userId: r.user_id,
        rideId: r.ride_id,
        userName: r.displayName,
        userPhone: r.user_phone,
        userType: r.user_type || 'passenger',
        category: r.category || 'other',
        subject: r.subject,
        description: r.description,
        status: r.status || 'open',
        priority: r.priority || 'normal',
        assignedTo: r.assigned_to,
        adminNotes: r.admin_notes,
        messages: Array.isArray(r.messages) ? r.messages : (typeof r.messages === 'string' ? JSON.parse(r.messages) : []),
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
      }))
    });
  } catch (err: any) {
    logger.error(`[admin/support] ${errMsg(err)}`);
    res.json({ tickets: [] });
  }
});

adminRouter.post("/support", async (req: Request, res: Response) => {
  const { userId, rideId, userName, userPhone, userType, category, subject, description, priority } = req.body;
  if (!subject) return res.status(400).json({ error: 'Subject is required' });
  try {
    const { rows } = await pgPool.query(
      `INSERT INTO support_tickets (user_id, ride_id, user_name, user_phone, user_type, category, subject, description, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [userId || null, rideId || null, userName || null, userPhone || null, userType || 'passenger', category || 'other', subject, description || null, priority || 'normal']
    );
    res.json({ success: true, ticket: rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

adminRouter.post("/support/:id/reply", async (req: Request, res: Response) => {
  const { message } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
  try {
    const { rows: current } = await pgPool.query(`SELECT messages FROM support_tickets WHERE id = $1`, [req.params.id]);
    if (!current[0]) return res.status(404).json({ error: 'Ticket not found' });
    const messages = Array.isArray(current[0].messages) ? current[0].messages : [];
    messages.push({ sender: 'Admin', content: message, isAdmin: true, timestamp: new Date().toISOString() });
    const { rows } = await pgPool.query(
      `UPDATE support_tickets SET messages = $1, status = CASE WHEN status = 'open' THEN 'pending' ELSE status END, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify(messages), req.params.id]
    );
    const r = rows[0];
    res.json({ success: true, ticket: { id: r.id, status: r.status, messages } });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

adminRouter.post("/support/:id/close", async (req: Request, res: Response) => {
  const { message } = req.body || {};
  try {
    const { rows: current } = await pgPool.query(`SELECT messages FROM support_tickets WHERE id = $1`, [req.params.id]);
    const messages = Array.isArray(current[0]?.messages) ? current[0].messages : [];
    if (message) messages.push({ sender: 'Admin', content: message, isAdmin: true, timestamp: new Date().toISOString() });
    const { rows } = await pgPool.query(
      `UPDATE support_tickets SET status = 'closed', resolved_at = NOW(), messages = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify(messages), req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ success: true, ticket: { id: rows[0].id, status: 'closed', resolvedAt: rows[0].resolved_at } });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to close ticket' });
  }
});

adminRouter.post("/support/:id/escalate", async (req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(
      `UPDATE support_tickets SET priority = 'urgent', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ success: true, ticket: { id: rows[0].id, priority: 'urgent' } });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to escalate ticket' });
  }
});

adminRouter.patch("/support/:id", async (req: Request, res: Response) => {
  const allowed = ['status', 'priority', 'assigned_to', 'admin_notes'];
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
  try {
    const { rows } = await pgPool.query(
      `UPDATE support_tickets SET ${setClauses} WHERE id = $1 RETURNING *`,
      [req.params.id, ...Object.values(updates)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ success: true, ticket: rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});

// ─── System ───────────────────────────────────────────────────────────────────

adminRouter.get("/system", async (_req: Request, res: Response) => {
  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);

  const [memory, cpu, database, supabase, redis] = await Promise.all([
    getMemory(), getCpu(), checkDatabase(), checkSupabase(), checkRedis(),
  ]);

  // Stripe, Maps, Firebase, Twilio y correo se verificaron de verdad al arrancar
  // y el resultado quedó guardado: no se pueden repetir en cada consulta porque
  // esta pantalla refresca cada 15 s y una llamada a Maps se factura.
  // Ver server/services/integrationChecks.ts.
  const checks = getIntegrationChecks();
  const todas = { database, supabase, redis, ...checks };

  res.json({
    uptime: uptimeSeconds,
    uptimeFormatted: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`,

    memory: {
      // Share of the container limit — the number worth showing on a dashboard.
      usedMb:  memory.usedMb,
      limitMb: memory.limitMb,
      percent: memory.percent,
      // V8 heap. Diagnostic only: heapUsed/heapTotal sits near 90% by design
      // because V8 grows the heap on demand, so it is not a capacity signal.
      heapUsedMb:  memory.heapUsedMb,
      heapTotalMb: memory.heapTotalMb,
      // Legacy keys, kept so the existing panel does not break.
      rss:       memory.usedMb,
      heapUsed:  memory.heapUsedMb,
      heapTotal: memory.heapTotalMb,
    },

    cpu: {
      // Percentage of the allocated vCPU. Null until a second sample exists.
      percent: cpu.percent,
      vcpu:    cpu.vcpu,
    },

    nodeVersion: process.version,
    environment: process.env.NODE_ENV || 'development',

    // Estado de cada dependencia. Mismo conjunto de claves que `integrations`.
    apiStatus: Object.fromEntries(
      Object.entries(todas).map(([k, v]) => [k, v.status]),
    ),

    // Detalle completo de cada comprobación, para que el panel muestre al pasar
    // el cursor qué se validó, cómo y cuánto tardó.
    integrations: todas,

    // Atajos planos, para renderizar la tarjeta sin recorrer el objeto.
    verifiedAt: Object.fromEntries(
      Object.entries(todas).map(([k, v]) => [k, v.verifiedAt]),
    ),
    checkDetail: Object.fromEntries(
      Object.entries(todas).map(([k, v]) => [k, v.summary ?? null]),
    ),
  });
});

// ─── Audit Logs (real ride_logs table) ──────────────────────────────────────

adminRouter.get("/audit-logs", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(`
      SELECT
        rl.id, rl.ride_id, rl.old_status, rl.new_status,
        rl.changed_by_role, rl.created_at, rl.metadata,
        r.vehicle_type,
        COALESCE(p.first_name || ' ' || p.last_name, 'System') AS actor_name
      FROM ride_logs rl
      LEFT JOIN rides r ON rl.ride_id = r.id
      LEFT JOIN profiles p ON rl.changed_by_id = p.id
      ORDER BY rl.created_at DESC
      LIMIT 500
    `);
    res.json({ logs: rows });
  } catch (err: any) {
    logger.error(`[admin/audit-logs] ${errMsg(err)}`);
    res.json({ logs: [], error: errMsg(err) });
  }
});

// ─── Feedback ─────────────────────────────────────────────────────────────────

adminRouter.get("/feedback", async (_req: Request, res: Response) => {
  try {
    // Las calificaciones de viaje nunca llegaban aquí: `POST /api/rides/:id/rating`
    // las guarda en `rides.rating` y esta ruta sólo leía `client_feedback`, que se
    // llena con sugerencias y reclamos. Se unen ambas en la forma de fila que ya
    // lee el panel. Sólo entra la calificación del pasajero al conductor: la del
    // conductor al pasajero (`passenger_rating`) mezclaría el promedio de conductores.
    const [ridesRes, feedbackRows] = await Promise.all([
      supabaseAdmin
        .from('rides')
        .select(`
          id, rating, passenger_review_comment, passenger_review_tags,
          created_at, completed_at, passenger_id, driver_id,
          passenger:profiles!rides_passenger_id_fkey(first_name, last_name, phone),
          driver:profiles!rides_driver_id_fkey(first_name, last_name, phone)
        `)
        .not('rating', 'is', null)
        .order('completed_at', { ascending: false })
        .limit(500),
      pgPool.query(
        `SELECT id, user_id, type, category, rating, area_ratings, comment,
                chauffeur_id, trip_id, is_anonymous, created_at
         FROM client_feedback
         ORDER BY created_at DESC
         LIMIT 500`
      ).then(
        (r) => r.rows as Record<string, unknown>[],
        (err: unknown) => {
          logger.error(`[admin/feedback] client_feedback: ${errMsg(err)}`);
          return [] as Record<string, unknown>[];
        },
      ),
    ]);
    if (ridesRes.error) throw ridesRes.error;

    const nombre = (p: unknown) => {
      const x = p as { first_name?: string; last_name?: string; phone?: string } | null;
      if (!x) return null;
      return `${x.first_name || ''} ${x.last_name || ''}`.trim() || x.phone || null;
    };

    const deViajes = ((ridesRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: `ride-${r.id}`,
      user_id: r.passenger_id,
      user_name: nombre(r.passenger),
      type: 'trip_review',
      category: null,
      rating: Number(r.rating),
      area_ratings: null,
      comment: r.passenger_review_comment ?? null,
      tags: r.passenger_review_tags ?? null,
      chauffeur_id: r.driver_id,
      chauffeur_name: nombre(r.driver),
      trip_id: r.id,
      is_anonymous: false,
      created_at: r.completed_at ?? r.created_at,
      source: 'ride_rating',
    }));

    // Una reseña de `client_feedback` del mismo viaje ya calificado no se cuenta dos veces.
    const viajesCalificados = new Set(deViajes.map((f) => String(f.trip_id)));
    const filasFeedback = feedbackRows.filter(
      (f) => !(f.trip_id && f.rating != null && viajesCalificados.has(String(f.trip_id))),
    );

    // `client_feedback` sólo trae ids: el panel pintaba el UUID donde dice pasajero y conductor.
    const ids = [...new Set(filasFeedback.flatMap((f) => [f.user_id, f.chauffeur_id]).filter(Boolean).map(String))];
    const nombres = new Map<string, string | null>();
    if (ids.length) {
      const { data: perfiles } = await supabaseAdmin
        .from('profiles').select('id, first_name, last_name, phone').in('id', ids);
      for (const p of (perfiles ?? []) as Record<string, unknown>[]) nombres.set(String(p.id), nombre(p));
    }
    const deFeedback = filasFeedback.map((f) => ({
      ...f,
      user_name: f.user_id ? nombres.get(String(f.user_id)) ?? null : null,
      chauffeur_name: f.chauffeur_id ? nombres.get(String(f.chauffeur_id)) ?? null : null,
      source: 'client_feedback',
    }));

    const feedback = ([...deViajes, ...deFeedback] as Record<string, unknown>[])
      .sort((a, b) => new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime())
      .slice(0, 500);
    res.json({ feedback });
  } catch (err: any) {
    logger.error(`[admin/feedback] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to load feedback', feedback: [] });
  }
});

// ─── App Config ───────────────────────────────────────────────────────────────

// ─── Zonas de servicio ───────────────────────────────────────────────────────
//
// Dónde opera Urbont. Antes era un círculo hardcodeado en rides/create.ts y abrir
// una ciudad exigía un despliegue; ahora es una fila en `service_zones`.
//
// Cada escritura llama a `invalidateZones()`: sin eso el cambio no surtiría
// efecto hasta el próximo arranque, que fue justo el bug del editor de tarifas.

/** Registra en audit_logs quién tocó el área de servicio. */
async function auditarZona(req: Request, accion: string, detalle: string): Promise<void> {
  try {
    await pgPool.query(
      `INSERT INTO audit_logs (admin_name, action, target, ip) VALUES ($1, $2, $3, $4)`,
      [req.adminUser?.name || req.adminUser?.email || 'desconocido', accion, detalle, req.ip ?? null],
    );
  } catch (e) {
    logger.warn({ err: errMsg(e), accion, detalle }, '[admin/zones] no se pudo registrar en audit_logs');
  }
}

adminRouter.get("/zones", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(`
      SELECT id, name, active, timezone, center_lat, center_lng, radius_km,
             country_code, false AS has_boundary, updated_at
        FROM service_zones ORDER BY active DESC, name ASC
    `);
    res.json({ zones: rows });
  } catch (err: unknown) {
    logger.error(`[admin/zones] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to load service zones' });
  }
});

adminRouter.post("/zones", async (req: Request, res: Response) => {
  const { id, name, centerLat, centerLng, radiusKm, timezone, countryCode } = req.body as Record<string, unknown>;

  const slug = String(id ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const lat = Number(centerLat), lng = Number(centerLng), radio = Number(radiusKm);
  // ISO 3166-1 alpha-2. Sale de la ciudad elegida en el panel; 'US' cuando la
  // zona se crea a mano con coordenadas, que es como se hacía hasta ahora.
  const pais = String(countryCode ?? 'US').trim().toUpperCase().slice(0, 2) || 'US';

  if (!slug) return res.status(400).json({ error: 'id is required (letters, digits, - and _).' });
  if (!String(name ?? '').trim()) return res.status(400).json({ error: 'name is required.' });
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return res.status(400).json({ error: 'centerLat must be between -90 and 90.' });
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return res.status(400).json({ error: 'centerLng must be between -180 and 180.' });
  if (!Number.isFinite(radio) || radio <= 0) return res.status(400).json({ error: 'radiusKm must be greater than 0.' });

  try {
    // Nace DESACTIVADA, aunque la columna venga con default true.
    //
    // Crear una zona es escribir unas coordenadas a mano. Un dígito de más en la
    // latitud abriría servicio en mitad del océano sin que nadie lo mirara, y la
    // plataforma empezaría a aceptar viajes ahí de inmediato. Se crea, se revisa
    // en el mapa de la pantalla, y sólo entonces se activa.
    const { rows } = await pgPool.query(
      `INSERT INTO service_zones (id, name, timezone, center_lat, center_lng, radius_km, country_code, active)
       VALUES ($1, $2, COALESCE($3,'America/New_York'), $4, $5, $6, $7, false)
       RETURNING id, name, active, timezone, center_lat, center_lng, radius_km, country_code`,
      [slug, String(name).trim(), timezone ? String(timezone) : null, lat, lng, radio, pais],
    );
    await invalidateZones();
    await auditarZona(req, 'zones.create', `${slug} (${pais}) → ${lat},${lng} r=${radio}km`);
    res.json({ success: true, zone: rows[0] });
  } catch (err: unknown) {
    if (String(errMsg(err)).includes('duplicate key')) {
      return res.status(409).json({ error: `Zone '${slug}' already exists.` });
    }
    logger.error(`[admin/zones] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to create service zone' });
  }
});

adminRouter.patch("/zones/:id", async (req: Request, res: Response) => {
  const { name, centerLat, centerLng, radiusKm, timezone } = req.body as Record<string, unknown>;

  const sets: string[] = [];
  const vals: unknown[] = [];
  const applied: Record<string, unknown> = {};
  const add = (col: string, key: string, v: unknown) => {
    sets.push(`${col} = $${vals.length + 1}`); vals.push(v); applied[key] = v;
  };

  if (name !== undefined && String(name).trim()) add('name', 'name', String(name).trim());
  if (timezone !== undefined && String(timezone).trim()) add('timezone', 'timezone', String(timezone).trim());
  if (centerLat !== undefined) {
    const v = Number(centerLat);
    if (!Number.isFinite(v) || v < -90 || v > 90) return res.status(400).json({ error: 'centerLat must be between -90 and 90.' });
    add('center_lat', 'centerLat', v);
  }
  if (centerLng !== undefined) {
    const v = Number(centerLng);
    if (!Number.isFinite(v) || v < -180 || v > 180) return res.status(400).json({ error: 'centerLng must be between -180 and 180.' });
    add('center_lng', 'centerLng', v);
  }
  if (radiusKm !== undefined) {
    const v = Number(radiusKm);
    // Un radio de 0 dejaría la zona sin cubrir nada, desde una pantalla que no
    // avisa de ello. Se rechaza en vez de aceptarlo en silencio.
    if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'radiusKm must be greater than 0.' });
    add('radius_km', 'radiusKm', v);
  }

  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update.' });

  try {
    vals.push(req.params.id);
    const { rows } = await pgPool.query(
      `UPDATE service_zones SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${vals.length}
        RETURNING id, name, active, timezone, center_lat, center_lng, radius_km`,
      vals,
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Zone not found.' });

    await invalidateZones();
    await auditarZona(req, 'zones.update', `${req.params.id} → ${Object.entries(applied).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    res.json({ success: true, zone: rows[0], applied });
  } catch (err: unknown) {
    logger.error(`[admin/zones] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to update service zone' });
  }
});

adminRouter.patch("/zones/:id/active", async (req: Request, res: Response) => {
  const { active } = req.body as { active?: boolean };
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active must be a boolean.' });

  try {
    // Desactivar la última zona activa dejaría a la plataforma sin poder aceptar
    // un solo viaje. Se comprueba antes de escribir, no después.
    if (!active) {
      const { rows: activas } = await pgPool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM service_zones WHERE active AND id <> $1`, [req.params.id],
      );
      if (parseInt(activas[0]?.n ?? '0', 10) === 0) {
        return res.status(409).json({
          error: 'Cannot deactivate the last active zone — nobody would be able to book a ride.',
        });
      }
    }

    const { rows } = await pgPool.query(
      `UPDATE service_zones SET active = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, name, active`,
      [active, req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Zone not found.' });

    await invalidateZones();
    await auditarZona(req, active ? 'zones.activate' : 'zones.deactivate', String(req.params.id));
    res.json({ success: true, zone: rows[0] });
  } catch (err: unknown) {
    logger.error(`[admin/zones] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to change zone status' });
  }
});

/**
 * Borra una zona. Existe para deshacer un alta equivocada, no para retirar una
 * ciudad — eso es desactivarla.
 *
 * Dos guardas, porque `rides.zone_id` es TEXT sin clave foránea a propósito (el
 * viaje guarda la zona como etiqueta histórica) y por tanto la base no impediría
 * nada por sí sola:
 *
 *  - Una zona activa no se borra. Primero se desactiva, que ya avisa si es la
 *    última y dejaría la plataforma sin poder aceptar viajes.
 *  - Una zona con viajes no se borra nunca. Su id es lo único que dice dónde
 *    ocurrieron, y sin la fila queda un identificador huérfano que ya no se puede
 *    interpretar.
 */
adminRouter.delete("/zones/:id", async (req: Request, res: Response) => {
  try {
    const { rows: zona } = await pgPool.query<{ name: string; active: boolean }>(
      `SELECT name, active FROM service_zones WHERE id = $1`, [req.params.id],
    );
    if (zona.length === 0) return res.status(404).json({ error: 'Zone not found.' });

    if (zona[0].active) {
      return res.status(409).json({
        error: 'Deactivate the zone before deleting it.',
        errorCode: 'ZONE_ACTIVE',
      });
    }

    const { rows: usos } = await pgPool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM rides WHERE zone_id = $1`, [req.params.id],
    );
    const viajes = parseInt(usos[0]?.n ?? '0', 10);
    if (viajes > 0) {
      return res.status(409).json({
        error: `Cannot delete: ${viajes} ride(s) belong to this zone. Leave it deactivated instead.`,
        errorCode: 'ZONE_HAS_RIDES',
        rides: viajes,
      });
    }

    await pgPool.query(`DELETE FROM service_zones WHERE id = $1`, [req.params.id]);
    await invalidateZones();
    await auditarZona(req, 'zones.delete', `${req.params.id} (${zona[0].name})`);
    res.json({ success: true, deleted: req.params.id });
  } catch (err: unknown) {
    logger.error(`[admin/zones] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to delete service zone' });
  }
});

/* ── Catálogo de ciudades ──────────────────────────────────────────────────
 *
 * Existe para que el panel deje de pedir coordenadas. No participa en la
 * geocerca: la resolución sigue siendo lat/lng contra los círculos de
 * `service_zones`, en memoria y sin tocar la base.
 *
 * La tabla se llena con scripts/import-cities.mjs. Si nadie lo corrió, estas
 * rutas devuelven listas vacías y el panel sigue aceptando coordenadas a mano.
 */

interface CityRow {
  geoname_id: number;
  name: string;
  country_code: string;
  admin1: string | null;
  lat: string;
  lng: string;
  population: number;
  timezone: string;
}

const aCiudad = (r: CityRow) => ({
  id:         r.geoname_id,
  name:       r.name,
  country:    r.country_code,
  admin1:     r.admin1,
  lat:        Number(r.lat),
  lng:        Number(r.lng),
  population: r.population,
  timezone:   r.timezone,
});

/** Quita acentos para que «Bogota» encuentre «Bogotá». */
const sinAcentos = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * GET /api/admin/cities
 *
 * Dos usos en una sola ruta, y no por gusto: `/cities` estaba **declarado dos
 * veces** —aquí el buscador del catálogo, y más abajo la lista de ciudades de
 * servicio de la pantalla del panel—. Express se queda con la primera, así que la
 * segunda era código muerto: la pantalla Ciudades pedía `/cities` sin `q`, el
 * buscador respondía `{ cities: [] }` por exigir dos caracteres, y la pantalla se
 * veía vacía sin que nadie viera un error.
 *
 * Se resuelve por parámetro en vez de separando rutas para no tener que desplegar
 * el panel a la vez: con `q` busca en el catálogo, sin `q` devuelve la pantalla.
 * Ambos llamadores siguen funcionando tal cual están hoy.
 *
 *   · con `q`  → catálogo geonames:  `?q=bogo[&country=CO]`
 *   · sin `q`  → ciudades de servicio + plan de expansión
 *
 * `/cities/search` hace lo primero de forma explícita, para código nuevo.
 */
adminRouter.get("/cities", async (req: Request, res: Response) => {
  if (!String(req.query.q ?? '').trim()) return ciudadesDeServicio(res);
  return buscarCiudades(req, res);
});

// GET /api/admin/cities/search?q=bogo[&country=CO]
adminRouter.get("/cities/search", buscarCiudades);

async function buscarCiudades(req: Request, res: Response) {
  const q = sinAcentos(String(req.query.q ?? '').trim().toLowerCase());
  if (q.length < 2) return res.json({ cities: [] });

  const pais = String(req.query.country ?? '').trim().toUpperCase();

  try {
    // Orden por población descendente, y no es un detalle estético: hay dos
    // Madrid en el catálogo, la de España (3.255.944) y la de Colombia
    // (135.000). Sin este ORDER BY el panel ofrece primero la equivocada y
    // alguien abre servicio en el sitio que no era.
    const { rows } = await pgPool.query<CityRow>(
      `SELECT geoname_id, name, country_code, admin1, lat, lng, population, timezone
         FROM cities
        WHERE lower(ascii_name) LIKE $1
          ${pais ? 'AND country_code = $3' : ''}
        ORDER BY population DESC
        LIMIT $2`,
      pais ? [`${q}%`, 12, pais] : [`${q}%`, 12],
    );
    res.json({ cities: rows.map(aCiudad) });
  } catch (err: unknown) {
    logger.error(`[admin/cities] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to search cities' });
  }
}

// GET /api/admin/cities/near?lat=&lng=&radiusKm=
adminRouter.get("/cities/near", async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'lat and lng are required numbers.' });
  }

  // El radio que pida el panel, con margen: la pantalla necesita también las
  // ciudades de FUERA más cercanas, que son las que informan si conviene
  // ampliar. Se piden una vez por centro y el panel recalcula al mover el radio.
  const radioKm = Math.min(2000, Math.max(1, Number(req.query.radiusKm) || 150));
  const alcance = radioKm * 1.6;

  // Misma caja envolvente que serviceZones.ts, aquí para que el índice
  // (lat, lng) haga el trabajo en vez de recorrer la tabla entera.
  const dLat = alcance / 111;
  const cos  = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const dLng = alcance / (111 * cos);

  try {
    const { rows } = await pgPool.query<CityRow>(
      `SELECT geoname_id, name, country_code, admin1, lat, lng, population, timezone
         FROM cities
        WHERE lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4
        ORDER BY population DESC
        LIMIT 300`,
      [lat - dLat, lat + dLat, lng - dLng, lng + dLng],
    );
    res.json({ cities: rows.map(aCiudad) });
  } catch (err: unknown) {
    logger.error(`[admin/cities/near] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to load nearby cities' });
  }
});

adminRouter.get("/config", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pgPool.query(`SELECT key, value, updated_at FROM app_config ORDER BY key`);
    const config: Record<string, unknown> = {};
    for (const row of rows) {
      try { config[row.key] = JSON.parse(row.value); } catch { config[row.key] = row.value; }
    }
    res.json({ config });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load config' });
  }
});

adminRouter.put("/config/:key", async (req: Request, res: Response) => {
  const { value } = req.body;
  // `service_area_km` salió de esta lista: el área de servicio vive en
  // `service_zones` y se edita desde /zones. Seguir aceptándola aquí dejaba una
  // perilla que se guardaba, no fallaba, y no cambiaba absolutamente nada.
  const safeKeys = ['maintenance_mode', 'min_version', 'surge_multiplier', 'surge_reason'];
  if (!safeKeys.includes(req.params.key)) return res.status(400).json({ error: 'Config key not editable' });
  try {
    await pgPool.query(
      `INSERT INTO app_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [req.params.key, String(value)]
    );
    res.json({ success: true, key: req.params.key, value });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// ─── Demo Driver Setup ────────────────────────────────────────────────────────

adminRouter.post('/setup-demo-driver', async (req: Request, res: Response) => {
  const DEMO_EMAIL = 'driver@urbont.com';
  const DEMO_PASSWORD = (req.body as { password?: string }).password || 'Urbont2025!';

  try {
    let userId: string | null = null;
    const { data: existingList } = await supabaseAdmin.auth.admin.listUsers();
    const existingAuthUser = (existingList?.users as Array<{ id: string; email?: string }> | undefined)?.find(u => u.email === DEMO_EMAIL);

    if (existingAuthUser) {
      userId = existingAuthUser.id;
      await supabaseAdmin.auth.admin.updateUserById(userId, { password: DEMO_PASSWORD, email_confirm: true });
    } else {
      const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: DEMO_EMAIL, password: DEMO_PASSWORD, email_confirm: true,
      });
      if (createErr || !newUser?.user?.id) throw new Error(createErr?.message || 'Failed to create auth user');
      userId = newUser.user.id;
    }

    const profileData = {
      id: userId, email: DEMO_EMAIL, phone: '+17865550001',
      first_name: 'Carlos', last_name: 'Urbont', role: 'chauffeur',
      verification_status: 'approved', operating_city: 'Miami',
    };

    const { error: upsertErr } = await supabaseAdmin.from('profiles').upsert(profileData, { onConflict: 'id' });
    if (upsertErr) throw new Error(upsertErr.message);

    return res.json({ success: true, message: 'Demo driver account ready.', email: DEMO_EMAIL, password: DEMO_PASSWORD, userId, verificationStatus: 'approved' });
  } catch (err: any) {
    logger.error(`[admin/setup-demo-driver] ${errMsg(err)}`);
    return res.status(500).json({ error: errMsg(err) || 'Failed to set up demo driver.' });
  }
});

// ─── Vehicles ─────────────────────────────────────────────────────────────────

adminRouter.get("/vehicles", async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, first_name, last_name, vehicle, operating_city')
      .in('role', ['chauffeur', 'driver'])
      .order('created_at', { ascending: false });
    if (error) throw error;
    const vehicles = (data ?? [])
      .filter((d: Record<string, unknown>) => d.vehicle)
      .map((d: Record<string, unknown>) => ({
        driverId: d.id,
        driverName: [d.first_name, d.last_name].filter(Boolean).join(' ') || 'Unnamed',
        make: (d.vehicle as Record<string, unknown>)?.make as string || '',
        model: (d.vehicle as Record<string, unknown>)?.model as string || '',
        year: (d.vehicle as Record<string, unknown>)?.year as string || '',
        color: (d.vehicle as Record<string, unknown>)?.color as string || '',
        plate: (d.vehicle as Record<string, unknown>)?.plate as string || '',
        vin: (d.vehicle as Record<string, unknown>)?.vin as string || '',
        seats: (d.vehicle as Record<string, unknown>)?.seats as string || '',
        vehicleClass: (d.vehicle as Record<string, unknown>)?.vehicleClass as string || (d.vehicle as Record<string, unknown>)?.class as string || 'businessClass',
        vehicleStatus: (d.vehicle as Record<string, unknown>)?.vehicleStatus as string || 'approved',
        inspectionExpiry: (d.vehicle as Record<string, unknown>)?.inspectionExpiry as string || null,
        city: d.operating_city || '',
      }));
    res.json({ vehicles });
  } catch (err: any) {
    logger.error(`[admin/vehicles] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to load vehicles', vehicles: [] });
  }
});

adminRouter.post("/vehicles/:driverId/approve", async (req: Request, res: Response) => {
  try {
    const { data: current } = await supabaseAdmin.from('profiles').select('vehicle').eq('id', req.params.driverId).single();
    const vehicle = { ...(current?.vehicle || {}), vehicleStatus: 'approved' };
    const { error } = await supabaseAdmin.from('profiles').update({ vehicle, updated_at: new Date().toISOString() }).eq('id', req.params.driverId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to approve vehicle' });
  }
});

adminRouter.post("/vehicles/:driverId/reject", async (req: Request, res: Response) => {
  try {
    const { reason } = req.body || {};
    const { data: current } = await supabaseAdmin.from('profiles').select('vehicle').eq('id', req.params.driverId).single();
    const vehicle = { ...(current?.vehicle || {}), vehicleStatus: 'rejected', vehicleRejectionReason: reason || 'Rejected by admin' };
    const { error } = await supabaseAdmin.from('profiles').update({ vehicle, updated_at: new Date().toISOString() }).eq('id', req.params.driverId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to reject vehicle' });
  }
});

// ─── Cities ───────────────────────────────────────────────────────────────────

/**
 * Ciudades de servicio de la pantalla del panel. Vivía en una segunda ruta
 * `GET /cities` que Express nunca alcanzaba, porque la del catálogo se declara
 * antes. Ahora la llama esa misma ruta cuando la petición no trae `q`.
 */
async function ciudadesDeServicio(res: Response) {
  try {
    const { rows } = await pgPool.query(`SELECT value FROM app_config WHERE key = 'service_cities'`).catch(() => ({ rows: [] }));
    let cities = rows[0]?.value ? JSON.parse(rows[0].value) : [];
    if (!Array.isArray(cities) || cities.length === 0) {
      cities = [
        { id: 'miami-fl', name: 'Miami', state: 'FL', country: 'USA', active: true, status: 'live', driverCount: 0, rideCount: 0, revenueTotal: 0, airportService: true, launchDate: '2024-01-01' },
        { id: 'fort-lauderdale-fl', name: 'Fort Lauderdale', state: 'FL', country: 'USA', active: true, status: 'beta', driverCount: 0, rideCount: 0, revenueTotal: 0, airportService: true },
        { id: 'miami-beach-fl', name: 'Miami Beach', state: 'FL', country: 'USA', active: true, status: 'live', driverCount: 0, rideCount: 0, revenueTotal: 0, airportService: false },
        { id: 'brickell-fl', name: 'Brickell / Downtown', state: 'FL', country: 'USA', active: true, status: 'live', driverCount: 0, rideCount: 0, revenueTotal: 0, airportService: false },
        { id: 'coral-gables-fl', name: 'Coral Gables', state: 'FL', country: 'USA', active: false, status: 'planned', driverCount: 0, rideCount: 0, revenueTotal: 0, airportService: false },
      ];
    }
    const expansion = [
      { name: 'Orlando', country: 'USA', status: 'planned', estimatedLaunch: 'Q3 2025' },
      { name: 'Tampa', country: 'USA', status: 'planned', estimatedLaunch: 'Q4 2025' },
      { name: 'Bogotá', country: 'Colombia', status: 'planned', estimatedLaunch: '2026' },
    ];
    res.json({ cities, expansion });
  } catch (err: any) {
    logger.error(`[admin/cities] ${errMsg(err)}`);
    res.json({ cities: [], expansion: [] });
  }
}

adminRouter.post("/cities", async (req: Request, res: Response) => {
  try {
    const { rows: current } = await pgPool.query(`SELECT value FROM app_config WHERE key = 'service_cities'`).catch(() => ({ rows: [] }));
    let cities = current[0]?.value ? JSON.parse(current[0].value) : [];
    const newCity = { id: `${req.body.name?.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`, driverCount: 0, rideCount: 0, revenueTotal: 0, ...req.body };
    cities = [...cities, newCity];
    await pgPool.query(`INSERT INTO app_config (key, value) VALUES ('service_cities', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`, [JSON.stringify(cities)]);
    res.json({ success: true, city: newCity });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to add city' });
  }
});

adminRouter.patch("/cities/:id", async (req: Request, res: Response) => {
  try {
    const { rows: current } = await pgPool.query(`SELECT value FROM app_config WHERE key = 'service_cities'`).catch(() => ({ rows: [] }));
    let cities = current[0]?.value ? JSON.parse(current[0].value) : [];
    cities = cities.map((c: Record<string, unknown>) => c.id === req.params.id ? { ...c, ...(req.body as Record<string, unknown>) } : c);
    await pgPool.query(`INSERT INTO app_config (key, value) VALUES ('service_cities', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`, [JSON.stringify(cities)]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update city' });
  }
});

// ─── Roles & Staff ─────────────────────────────────────────────────────────────

adminRouter.get("/roles", async (_req: Request, res: Response) => {
  try {
    const { rows: current } = await pgPool.query(`SELECT value FROM app_config WHERE key = 'admin_staff'`).catch(() => ({ rows: [] }));
    const staff = current[0]?.value ? JSON.parse(current[0].value) : [];
    const departments = ['Operations', 'Finance', 'Customer Support', 'Technology', 'Legal & Compliance', 'Marketing'];
    res.json({ staff, departments });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to load roles' });
  }
});

adminRouter.post("/roles/invite", async (req: Request, res: Response) => {
  const { email, role, department } = req.body || {};
  if (!email || !role) return res.status(400).json({ error: 'Email and role required' });
  try {
    const { rows: current } = await pgPool.query(`SELECT value FROM app_config WHERE key = 'admin_staff'`).catch(() => ({ rows: [] }));
    let staff = current[0]?.value ? JSON.parse(current[0].value) : [];
    const newMember = { id: `staff-${Date.now()}`, email, role, department: department || 'Operations', name: email.split('@')[0], active: true, permissions: [], createdAt: new Date().toISOString() };
    staff = [...staff, newMember];
    await pgPool.query(`INSERT INTO app_config (key, value) VALUES ('admin_staff', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`, [JSON.stringify(staff)]);
    res.json({ success: true, member: newMember });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to invite staff' });
  }
});

adminRouter.patch("/roles/:id", async (req: Request, res: Response) => {
  try {
    const { rows: current } = await pgPool.query(`SELECT value FROM app_config WHERE key = 'admin_staff'`).catch(() => ({ rows: [] }));
    let staff = current[0]?.value ? JSON.parse(current[0].value) : [];
    staff = staff.map((s: Record<string, unknown>) => s.id === req.params.id ? { ...s, ...req.body } : s);
    await pgPool.query(`INSERT INTO app_config (key, value) VALUES ('admin_staff', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`, [JSON.stringify(staff)]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update role' });
  }
});

adminRouter.post("/roles/:id/deactivate", async (req: Request, res: Response) => {
  try {
    const { rows: current } = await pgPool.query(`SELECT value FROM app_config WHERE key = 'admin_staff'`).catch(() => ({ rows: [] }));
    let staff = current[0]?.value ? JSON.parse(current[0].value) : [];
    staff = staff.map((s: Record<string, unknown>) => s.id === req.params.id ? { ...s, active: false } : s);
    await pgPool.query(`INSERT INTO app_config (key, value) VALUES ('admin_staff', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`, [JSON.stringify(staff)]);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to deactivate staff' });
  }
});

// ─── Promos ───────────────────────────────────────────────────────────────────

adminRouter.get("/promos", async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabaseAdmin.from('promo_codes').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    const promos = (data ?? []).map((p: Record<string, unknown>) => ({
      id: p.id, code: p.code, discountType: p.discount_type || 'percent',
      discountValue: p.discount_value || 0, description: p.description || '',
      active: p.is_active ?? true, maxUses: p.max_uses || 100,
      usedCount: p.used_count || 0, minRideFare: p.min_ride_amount || 0,
      expiresAt: p.expires_at, vehicleClass: p.vehicle_class || 'all',
      createdAt: p.created_at,
    }));
    res.json({ promos });
  } catch (err: any) {
    logger.error(`[admin/promos] ${errMsg(err)}`);
    res.json({ promos: [] });
  }
});

adminRouter.post("/promos", async (req: Request, res: Response) => {
  const { code, discountType, discountValue, description, maxUses, minRideFare, expiresAt, vehicleClass } = req.body || {};
  if (!code || !discountValue) return res.status(400).json({ error: 'Code and discount value required' });
  try {
    const { data, error } = await supabaseAdmin.from('promo_codes').insert({
      code: String(code).toUpperCase().trim(),
      discount_type: discountType || 'percent',
      discount_value: Number(discountValue),
      description: description || null,
      max_uses: Number(maxUses) || 100,
      used_count: 0,
      min_ride_amount: Number(minRideFare) || 0,
      expires_at: expiresAt || null,
      vehicle_class: vehicleClass || 'all',
      is_active: true,
    }).select().single();
    if (error) throw error;
    res.json({ success: true, promo: { id: data.id, code: data.code, discountType: data.discount_type, discountValue: data.discount_value, description: data.description, active: data.is_active, maxUses: data.max_uses, usedCount: 0, minRideFare: data.min_ride_amount, expiresAt: data.expires_at, vehicleClass: data.vehicle_class, createdAt: data.created_at } });
  } catch (err: any) {
    logger.error(`[admin/promos POST] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to create promo code' });
  }
});

adminRouter.post("/promos/:id/disable", async (req: Request, res: Response) => {
  try {
    const { error } = await supabaseAdmin.from('promo_codes').update({ is_active: false }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to disable promo' });
  }
});

adminRouter.post("/promos/:id/enable", async (req: Request, res: Response) => {
  try {
    const { error } = await supabaseAdmin.from('promo_codes').update({ is_active: true }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to enable promo' });
  }
});
