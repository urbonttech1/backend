import { Router, Request, Response } from "express";
import Stripe from "stripe";
import { requireAdminJWT } from "./admin-auth";
import { supabaseAdmin } from "../db/client";
import { pool as pgPool } from "../db/pool";
import { logger } from '../lib/logger';
import { getMemory, getCpu } from '../services/systemMetrics';
import { getIntegrationChecks, checkDatabase, checkSupabase, checkRedis } from '../services/integrationChecks';
import { recalcularVerificacion, normalizarEstadoDoc, ACCEPTED_DOC_KEYS } from '../services/driverVerification';

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
const DEFAULT_FARES: Record<string, unknown> = {
  businessClass: { name: "Standard (Sedan)", baseFare: 25, perMile: 4.00, perMin: 1.00, minFare: 25, includedMiles: 3, serviceFee: 2.50, cancellationFee: 10, peakMultiplier: 1.35, airportSurcharge: 4, nightSurcharge: 0 },
  suv: { name: "Premier (SUV)", baseFare: 38, perMile: 5.50, perMin: 1.25, minFare: 38, includedMiles: 3, serviceFee: 2.50, cancellationFee: 10, peakMultiplier: 1.35, airportSurcharge: 4, nightSurcharge: 0 },
  van: { name: "Executive Van", baseFare: 65, perMile: 8.00, perMin: 1.75, minFare: 65, includedMiles: 3, serviceFee: 2.50, cancellationFee: 10, peakMultiplier: 1.35, airportSurcharge: 4, nightSurcharge: 0 },
  concierge: { name: "Front Desk Surcharge", baseFare: 10, perHour: 0, minHours: 0, serviceFee: 0, cancellationFee: 10, peakMultiplier: 1.0, airportSurcharge: 0, nightSurcharge: 0 },
  valet: { name: "Valet Parking", baseFare: 35, perHour: 35, minHours: 1, serviceFee: 0, cancellationFee: 20, peakMultiplier: 1.0, airportSurcharge: 0, nightSurcharge: 0 }
};

async function getFaresFromDB(): Promise<Record<string, unknown>> {
  try {
    const { rows } = await pgPool.query(`SELECT value FROM app_config WHERE key = 'fares_config'`);
    if (rows[0]?.value) {
      const stored = JSON.parse(rows[0].value);
      // Heal legacy rows that used per-km / inflated base fares (pre-audit schema).
      // Detected by presence of `perKm` on the standard class or missing `van`.
      const needsReset =
        stored?.businessClass?.perKm !== undefined ||
        stored?.businessClass?.baseFare > 30  ||  // old inflated pre-v1 fares
        stored?.businessClass?.baseFare < 25  ||  // old underpriced fares (pre-audit fix; correct is $25)
        stored?.suv?.baseFare < 38            ||  // suv was $20, now $38
        stored?.van?.baseFare < 65            ||  // van was $38, now $65
        !stored?.van;
      if (needsReset) {
        await saveFaresToDB(DEFAULT_FARES).catch(() => {});
        return { ...DEFAULT_FARES };
      }
      return stored;
    }
  } catch {}
  return { ...DEFAULT_FARES };
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

      const millas = v.distance_miles as number | null;
      c.viajes.push({
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
        distanceMiles: millas,
        durationMinutes: v.duration_minutes,
        vehicleType: v.vehicle_type,
        paymentMethod: v.payment_method,
        paymentStatus: v.payment_status,
        rating: v.rating,
        cancelReason: v.cancel_reason,
      });
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
    const { reason } = req.body || {};
    const { error } = await supabaseAdmin.from('profiles')
      .update({ account_status: 'suspended', status_val: 'offline', status_reason: reason || 'Suspended by admin', updated_at: new Date().toISOString() })
      .eq('id', req.params.id).in('role', ['chauffeur', 'driver']);
    if (error) throw error;
    res.json({ success: true, driverId: req.params.id, action: 'suspended', reason, timestamp: new Date().toISOString() });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to suspend driver' });
  }
});

adminRouter.post("/drivers/:id/reactivate", async (_req: Request, res: Response) => {
  try {
    const { error } = await supabaseAdmin.from('profiles')
      .update({ account_status: 'active', status_val: 'offline', status_reason: null, updated_at: new Date().toISOString() })
      .eq('id', _req.params.id).in('role', ['chauffeur', 'driver']);
    if (error) throw error;
    res.json({ success: true, driverId: _req.params.id, action: 'reactivated', timestamp: new Date().toISOString() });
  } catch (err: any) {
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
    const passengers = (data ?? []).map((p: Record<string, unknown>) => ({
      id: p.id,
      name: [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Unnamed Passenger',
      phone: p.phone || '',
      email: p.email || '',
      status: p.account_status || 'active',
      totalRides: p.total_rides || 0,
      rating: p.rating || 0,
      membership: p.membership || 'standard',
      joinedDate: (p.created_at as string | undefined)?.split('T')[0] || '',
      stripeCustomerId: p.stripe_customer_id || null,
      infractionCount: p.infraction_count || 0,
    }));
    res.json({ passengers });
  } catch (err: any) {
    logger.error(`[admin/passengers] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to load passengers' });
  }
});

adminRouter.post("/passengers/:id/suspend", async (req: Request, res: Response) => {
  try {
    const { reason } = req.body || {};
    const { error } = await supabaseAdmin.from('profiles')
      .update({ account_status: 'suspended', status_reason: reason || 'Suspended by admin', updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('role', 'passenger');
    if (error) throw error;
    res.json({ success: true, passengerId: req.params.id, action: 'suspended', reason });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to suspend passenger' });
  }
});

adminRouter.post("/passengers/:id/reactivate", async (req: Request, res: Response) => {
  try {
    const { error } = await supabaseAdmin.from('profiles')
      .update({ account_status: 'active', status_reason: null, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('role', 'passenger');
    if (error) throw error;
    res.json({ success: true, passengerId: req.params.id, action: 'reactivated' });
  } catch (err: any) {
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
  res.json({ fares });
});

adminRouter.put("/fares", async (req: Request, res: Response) => {
  const { vehicleClass, updates } = req.body;
  const fares = await getFaresFromDB();
  if (!vehicleClass || !fares[vehicleClass]) {
    return res.status(400).json({ error: "Invalid vehicle class" });
  }
  const allowed = ['baseFare', 'perKm', 'perMin', 'perHour', 'minFare', 'minHours', 'serviceFee', 'cancellationFee', 'peakMultiplier', 'airportSurcharge', 'nightSurcharge'];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      const val = parseFloat(updates[key]);
      if (!isNaN(val) && val >= 0) fares[vehicleClass][key] = val;
    }
  }
  try {
    await saveFaresToDB(fares);
  } catch (e) {
    logger.warn({ err: e }, '[admin/fares] DB persist failed, using memory');
  }
  res.json({ success: true, fares, updatedClass: vehicleClass, timestamp: new Date().toISOString() });
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
    const [allRidesRes, dailyRes, byClassRes, recentTxRes, hourlyRes, prevWeekRes] = await Promise.all([
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
      pgPool.query(`
        SELECT r.id, r.fare, r.created_at, r.vehicle_type,
          COALESCE(p.first_name || ' ' || p.last_name, 'Passenger') AS passenger_name
        FROM rides r
        LEFT JOIN profiles p ON r.passenger_id = p.id
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

    const byVehicleClass = (byClassRes.rows as Record<string, unknown>[]).map((r: Record<string, unknown>) => ({
      vehicleClass: r.vehicle_type || 'Unknown',
      amount: Math.round(parseFloat(String(r.amount)) || 0),
      rides: parseInt(String(r.rides)),
      percentage: totalAllTime > 0 ? Math.round((parseFloat(String(r.amount)) / totalAllTime) * 100) : 0,
    }));

    const dailyRevenue = (dailyRes.rows as Record<string, unknown>[]).map((r: Record<string, unknown>) => ({
      day: new Date(r.day as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      amount: Math.round(parseFloat(String(r.total)) || 0),
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
      amount: parseFloat(String(r.fare)) || 0,
      type: 'ride_fare',
      rideId: (r.id as string)?.slice(-8).toUpperCase(),
      date: r.created_at,
      vehicleType: r.vehicle_type,
    }));

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
      avgFare: completed.length > 0 ? Math.round(sum(completed) / completed.length * 100) / 100 : 0,
      totalCompletedRides: completed.length,
      // Facturado vs cobrado. `totalAllTime` sigue siendo lo facturado para no
      // romper el panel; estos campos dicen cuánto de eso entró de verdad.
      billedAllTime: Math.round(totalAllTime * 100) / 100,
      collectedAllTime: Math.round(sum(collected) * 100) / 100,
      uncollectedAllTime: Math.round(sum(uncollected) * 100) / 100,
      uncollectedRides: uncollected.length,
      byVehicleClass,
      dailyRevenue,
      hourlyRevenue,
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
    res.json({
      incidents: rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        rideId: r.ride_id,
        driverName: r.driverName,
        passengerName: r.passengerName,
        reportedBy: r.reporterName,
        type: r.incid_type,
        severity: r.severity || 'low',
        status: r.incid_status || 'open',
        location: r.location,
        description: r.description,
        notes: r.notes,
        resolution: r.resolution,
        date: r.created_at,
        updatedAt: r.updated_at,
      }))
    });
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
    const { rows } = await pgPool.query(
      `SELECT id, user_id, type, category, rating, area_ratings, comment,
              chauffeur_id, trip_id, is_anonymous, created_at
       FROM client_feedback
       ORDER BY created_at DESC
       LIMIT 500`
    );
    res.json({ feedback: rows });
  } catch (err: any) {
    logger.error(`[admin/feedback] ${errMsg(err)}`);
    res.status(500).json({ error: 'Failed to load feedback', feedback: [] });
  }
});

// ─── App Config ───────────────────────────────────────────────────────────────

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
  const safeKeys = ['maintenance_mode', 'min_version', 'surge_multiplier', 'surge_reason', 'service_area_km'];
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

adminRouter.get("/cities", async (_req: Request, res: Response) => {
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
});

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
