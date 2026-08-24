import { supabaseAdmin } from './client';
import { logger } from '../lib/logger';

export interface UserDoc {
  id: string;
  phone: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  role: 'passenger';
  membership_type: 'standard' | 'vip';
  total_rides: number;
  created_at?: string;
  updated_at?: string;
}

export interface DriverDoc {
  id: string;
  phone: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  role: 'chauffeur';
  membership: 'free' | 'premium';
  membership_since?: string;
  status: 'offline' | 'online' | 'on_trip';
  rating: number;
  total_rides: number;
  vehicle?: { make: string; model: string; year: number; color: string; plate: string };
  background_check?: { status: string; checkr_id?: string; completed_at?: string };
  concierge_partner_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface RideDoc {
  id?: string;
  passenger_id: string;
  driver_id?: string;
  concierge_id?: string;
  status: 'searching' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled';
  vehicle_type: string;
  pickup: { address: string; lat: number; lng: number };
  dropoff: { address: string; lat: number; lng: number };
  fare?: number;
  distance?: number;
  duration_minutes?: number;
  payment_method?: string;
  payment_intent_id?: string;
  notes?: string;
  rating?: number;
  created_at?: string;
  updated_at?: string;
  completed_at?: string;
}

export interface ConciergePartnerDoc {
  id: string;
  business_name: string;
  contact_person: string;
  phone: string;
  email?: string;
  role: 'valet';
  commission_rate: number;
  commission_type: 'cash_at_pickup';
  status: 'active' | 'suspended' | 'pending';
  total_referrals: number;
  created_at?: string;
  updated_at?: string;
}

export interface NotificationDoc {
  id?: string;
  user_id: string;
  title: string;
  body: string;
  type: 'ride_update' | 'payment' | 'system' | 'promo';
  read: boolean;
  data?: Record<string, string>;
  created_at?: string;
}

function generateReferralCode(uid: string): string {
  return uid.replace(/-/g, '').substring(0, 8).toUpperCase();
}

export async function createUserDoc(uid: string, data: Partial<UserDoc>): Promise<void> {
  const now = new Date().toISOString();
  try {
    // Check if profile already exists so we don't overwrite data on re-login
    const { data: existing } = await supabaseAdmin
      .from('profiles')
      .select('id, first_name, last_name, total_rides')
      .eq('id', uid)
      .maybeSingle();

    const payload: Record<string, unknown> = {
      id: uid,
      role: 'passenger',
      membership_type: 'standard',
      avatar_url: '/default-avatar.svg',
      referral_code: generateReferralCode(uid),
      updated_at: now,
    };

    // Only set total_rides for brand-new profiles — never reset existing ride count
    if (!existing) payload.total_rides = 0;

    // Only include phone/email if provided — never overwrite saved values with null
    // on re-login (e.g. re-onboard calls that only send {role, phone} would otherwise
    // wipe a separately-saved email back to null on every login).
    if (data.phone)   payload.phone = data.phone;
    else if (!existing) payload.phone = null;

    if (data.email)   payload.email = data.email;
    else if (!existing) payload.email = null;

    // Only include names if provided — never overwrite saved names with null on re-login
    if (data.first_name)       payload.first_name = data.first_name;
    else if (!existing)        payload.first_name = null;

    if (data.last_name)        payload.last_name  = data.last_name;
    else if (!existing)        payload.last_name  = null;

    await supabaseAdmin.from('profiles').upsert(payload, { onConflict: 'id', ignoreDuplicates: false });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[DB] createUserDoc error');
  }
}

export async function createDriverDoc(uid: string, data: Partial<DriverDoc>): Promise<void> {
  const now = new Date().toISOString();
  try {
    const { data: existing } = await supabaseAdmin
      .from('profiles')
      .select('id, first_name, last_name, total_rides, background_check')
      .eq('id', uid)
      .maybeSingle();

    const payload: Record<string, unknown> = {
      id: uid,
      role: 'chauffeur',
      membership: 'free',
      status_val: 'offline',
      rating: 5.0,
      avatar_url: '/default-avatar.svg',
      background_check: existing?.background_check || { status: 'not_submitted' },
      referral_code: generateReferralCode(uid),
      updated_at: now,
    };

    if (!existing) payload.total_rides = 0;

    // Only include phone/email if provided — never overwrite saved values with null
    // on re-login (e.g. re-onboard calls that only send {role, phone} would otherwise
    // wipe a separately-saved email back to null on every login).
    if (data.phone)      payload.phone = data.phone;
    else if (!existing)  payload.phone = null;

    if (data.email)      payload.email = data.email;
    else if (!existing)  payload.email = null;

    if (data.first_name)  payload.first_name = data.first_name;
    else if (!existing)   payload.first_name = null;

    if (data.last_name)   payload.last_name  = data.last_name;
    else if (!existing)   payload.last_name  = null;

    await supabaseAdmin.from('profiles').upsert(payload, { onConflict: 'id', ignoreDuplicates: false });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[DB] createDriverDoc error');
  }
}

export async function getUserDoc(uid: string): Promise<UserDoc | null> {
  try {
    const { data } = await supabaseAdmin.from('profiles').select('*').eq('id', uid).maybeSingle();
    if (!data) return null;
    return {
      id: data.id,
      phone: data.phone,
      first_name: data.first_name,
      last_name: data.last_name,
      email: data.email,
      role: 'passenger',
      membership_type: data.membership_type || 'standard',
      total_rides: data.total_rides || 0,
      created_at: data.created_at,
      updated_at: data.updated_at,
      ...data,
    } as UserDoc;
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[DB] getUserDoc error');
    return null;
  }
}

export async function getDriverDoc(uid: string): Promise<DriverDoc | null> {
  try {
    const { data } = await supabaseAdmin.from('profiles').select('*').eq('id', uid).eq('role', 'chauffeur').maybeSingle();
    if (!data) return null;
    return {
      id: data.id,
      phone: data.phone,
      first_name: data.first_name,
      last_name: data.last_name,
      email: data.email,
      role: 'chauffeur',
      membership: data.membership || 'free',
      status: data.status_val || 'offline',
      rating: data.rating || 5.0,
      total_rides: data.total_rides || 0,
      vehicle: data.vehicle,
      background_check: data.background_check,
      created_at: data.created_at,
      updated_at: data.updated_at,
      ...data,
    } as DriverDoc;
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[DB] getDriverDoc error');
    return null;
  }
}

export async function createRide(data: Omit<RideDoc, 'id' | 'created_at' | 'updated_at'>): Promise<string> {
  const now = new Date().toISOString();
  const { data: ride, error } = await supabaseAdmin.from('rides').insert({
    passenger_id: data.passenger_id,
    driver_id: data.driver_id || null,
    concierge_id: data.concierge_id || null,
    ride_status: data.status || 'searching',
    vehicle_type: data.vehicle_type,
    pickup_address: data.pickup.address,
    dropoff_address: data.dropoff.address,
    pickup_lat: data.pickup.lat,
    pickup_lng: data.pickup.lng,
    dropoff_lat: data.dropoff.lat,
    dropoff_lng: data.dropoff.lng,
    fare: data.fare || null,
    distance_meters: data.distance || null,
    duration_minutes: data.duration_minutes || null,
    payment_method: data.payment_method || null,
    notes: data.notes || null,
    created_at: now,
    updated_at: now,
  }).select('id').single();
  if (error) throw new Error(error.message);
  return ride.id as string;
}

export async function updateRide(rideId: string, data: Partial<RideDoc>): Promise<void> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (data.status)               updates.ride_status   = data.status;
  if (data.driver_id !== undefined) updates.driver_id = data.driver_id;
  if (data.fare !== undefined)   updates.fare          = data.fare;
  if (data.rating !== undefined) updates.rating        = data.rating;
  if (data.notes !== undefined)  updates.notes         = data.notes;
  await supabaseAdmin.from('rides').update(updates).eq('id', rideId);
}

export async function getRidesByPassenger(passengerId: string, limitCount = 20): Promise<RideDoc[]> {
  try {
    const { data } = await supabaseAdmin.from('rides').select('*').eq('passenger_id', passengerId).order('created_at', { ascending: false }).limit(limitCount);
    return (data ?? []) as RideDoc[];
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[DB] getRidesByPassenger error');
    return [];
  }
}

export async function getRidesByDriver(driverId: string, limitCount = 20): Promise<RideDoc[]> {
  try {
    const { data } = await supabaseAdmin.from('rides').select('*').eq('driver_id', driverId).order('created_at', { ascending: false }).limit(limitCount);
    return (data ?? []) as RideDoc[];
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[DB] getRidesByDriver error');
    return [];
  }
}

export async function createConciergePartner(uid: string, data: Partial<ConciergePartnerDoc>): Promise<void> {
  const now = new Date().toISOString();
  try {
    await supabaseAdmin.from('profiles').upsert({
      id: uid,
      role: 'valet',
      commission_rate: 10,
      commission_type: 'cash_at_pickup',
      status_val: 'pending',
      total_referrals: 0,
      business_name: data.business_name || null,
      phone: data.phone || null,
      email: data.email || null,
      avatar_url: '/default-avatar.svg',
      updated_at: now,
    }, { onConflict: 'id', ignoreDuplicates: false });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[DB] createConciergePartner error');
  }
}

export async function sendNotification(userId: string, data: Omit<NotificationDoc, 'id' | 'user_id' | 'read' | 'created_at'>): Promise<void> {
  const now = new Date().toISOString();
  try {
    await supabaseAdmin.from('notifications').insert({
      user_id: userId,
      title: data.title,
      body: data.body,
      type: data.type,
      read: false,
      created_at: now,
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[DB] sendNotification error');
  }
}

// ─── Incidents ────────────────────────────────────────────────────────────────

export interface IncidentDoc {
  id?: string;
  ride_id?: string;
  driver_id?: string;
  passenger_id?: string;
  reported_by_id?: string;
  reporter_role: 'driver' | 'passenger' | 'admin';
  reporter_name?: string;
  incid_type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  incid_status?: 'open' | 'investigating' | 'resolved' | 'closed';
  location?: string;
  description?: string;
  notes?: string;
  resolution?: string;
  created_at?: string;
  updated_at?: string;
}

export async function createIncident(data: Omit<IncidentDoc, 'id' | 'created_at' | 'updated_at'>): Promise<string> {
  const now = new Date().toISOString();
  const { data: incident, error } = await supabaseAdmin.from('incidents').insert({
    ride_id: data.ride_id || null,
    driver_id: data.driver_id || null,
    passenger_id: data.passenger_id || null,
    reported_by_id: data.reported_by_id || null,
    reporter_role: data.reporter_role,
    reporter_name: data.reporter_name || null,
    incid_type: data.incid_type,
    severity: data.severity,
    incid_status: data.incid_status || 'open',
    location: data.location || null,
    description: data.description || null,
    notes: data.notes || null,
    created_at: now,
    updated_at: now,
  }).select('id').single();
  if (error) throw new Error(error.message);
  return incident.id as string;
}

export async function getIncidents(limit = 50): Promise<IncidentDoc[]> {
  try {
    const { data } = await supabaseAdmin.from('incidents').select('*').order('created_at', { ascending: false }).limit(limit);
    return (data ?? []) as IncidentDoc[];
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[DB] getIncidents error');
    return [];
  }
}

export async function updateIncident(id: string, updates: Partial<IncidentDoc>): Promise<void> {
  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (updates.incid_status) payload.incid_status = updates.incid_status;
  if (updates.resolution)   payload.resolution   = updates.resolution;
  if (updates.notes)        payload.notes        = updates.notes;
  await supabaseAdmin.from('incidents').update(payload).eq('id', id);
}

// ─── Support Tickets ──────────────────────────────────────────────────────────

export interface SupportTicketDoc {
  id: string;
  user_id?: string;
  user_name?: string;
  user_phone?: string;
  user_type: 'passenger' | 'driver' | 'concierge';
  subject: string;
  category: string;
  ticket_status: 'open' | 'pending' | 'resolved' | 'closed';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assigned_to?: string;
  messages: Array<{ sender: string; content: string; timestamp: string; isAdmin: boolean }>;
  created_at?: string;
  updated_at?: string;
}

export async function createSupportTicket(data: Omit<SupportTicketDoc, 'created_at' | 'updated_at'>): Promise<void> {
  const now = new Date().toISOString();
  try {
    await supabaseAdmin.from('support_tickets').insert({
      id: data.id,
      user_id: data.user_id || null,
      user_name: data.user_name || null,
      user_phone: data.user_phone || null,
      user_type: data.user_type,
      subject: data.subject,
      category: data.category,
      status: data.ticket_status || 'open',
      priority: data.priority,
      assigned_to: data.assigned_to || null,
      messages: data.messages || [],
      created_at: now,
      updated_at: now,
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[DB] createSupportTicket error');
  }
}

export async function getSupportTickets(limit = 50): Promise<SupportTicketDoc[]> {
  try {
    const { data } = await supabaseAdmin.from('support_tickets').select('*').order('created_at', { ascending: false }).limit(limit);
    return (data ?? []).map((r: Record<string, unknown>) => ({ ...r, messages: r.messages || [] })) as SupportTicketDoc[];
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[DB] getSupportTickets error');
    return [];
  }
}

export async function addTicketMessage(ticketId: string, message: { sender: string; content: string; isAdmin: boolean }): Promise<void> {
  const now = new Date().toISOString();
  try {
    const { data: existing } = await supabaseAdmin.from('support_tickets').select('messages').eq('id', ticketId).maybeSingle();
    if (!existing) return;
    const messages = [...((existing.messages as typeof message[]) || []), { ...message, timestamp: now }];
    await supabaseAdmin.from('support_tickets').update({ messages, status: 'pending', updated_at: now }).eq('id', ticketId);
  } catch (err) {
    logger.error({ err: (err as Error).message }, '[DB] addTicketMessage error');
  }
}
