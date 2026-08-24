// ─── URBONT Server — Shared Types ────────────────────────────────────────────
//
// Types shared across server/api/*.ts handlers.
// ─────────────────────────────────────────────────────────────────────────────
import type { Request } from 'express';

// ── Authenticated Request ─────────────────────────────────────────────────────
export interface AuthRequest extends Request {
  user?: {
    id:    string;
    role:  'passenger' | 'chauffeur' | 'valet' | 'admin';
    email?: string;
    phone?: string;
  };
}

// ── Ride State Machine ────────────────────────────────────────────────────────
export type RideStatus =
  | 'scheduled'
  | 'searching'
  | 'confirmed'
  | 'driver_arrived'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export const ACTIVE_RIDE_STATUSES: RideStatus[] = [
  'scheduled', 'searching', 'confirmed', 'driver_arrived', 'in_progress',
];

// ── Driver Verification ───────────────────────────────────────────────────────
export type VerificationStatus =
  | 'pending_documents'
  | 'pending_review'
  | 'rejected'
  | 'approved';

// ── Database Row Shapes (raw from pg) ─────────────────────────────────────────
export interface DbRide {
  id:               string;
  passenger_id:     string;
  driver_id?:       string | null;
  ride_status:      RideStatus;
  pickup_address:   string;
  dropoff_address:  string;
  pickup_lat?:      number;
  pickup_lng?:      number;
  dropoff_lat?:     number;
  dropoff_lng?:     number;
  vehicle_type?:    string;
  fare?:            number;
  locked_fare?:     number;
  wait_fee?:        number;
  payment_intent_id?:string | null;
  accepted_at?:     string | null;
  wait_started_at?: string | null;
  started_at?:      string | null;
  completed_at?:    string | null;
  created_at:       string;
  scheduled_at?:    string | null;
  cancel_reason?:   string | null;
  surge_multiplier?:number;
}

export interface DbDriver {
  id:                  string;
  first_name:          string;
  last_name:           string;
  email?:              string;
  phone?:              string;
  avatar_url?:         string;
  rating?:             number;
  total_rides?:        number;
  verification_status: VerificationStatus;
  is_online?:          boolean;
  current_lat?:        number;
  current_lng?:        number;
  last_location_at?:   string;
  vehicle?: {
    make?:          string;
    model?:         string;
    year?:          string;
    color?:         string;
    license_plate?: string;
    photo_url?:     string;
    category?:      string;
  };
}

export interface DbUser {
  id:           string;
  first_name?:  string;
  last_name?:   string;
  email?:       string;
  phone?:       string;
  avatar_url?:  string;
  role:         'passenger' | 'chauffeur' | 'valet' | 'admin';
  created_at:   string;
  is_suspended?:boolean;
  is_banned?:   boolean;
}

// ── Socket Events ─────────────────────────────────────────────────────────────
export type SocketEvent =
  | 'ride:status'
  | 'ride:driver_assigned'
  | 'ride:completed'
  | 'ride:cancelled'
  | 'driver:location'
  | 'driver:online'
  | 'driver:offline'
  | 'notification:new';

// ── API Response Helpers ──────────────────────────────────────────────────────
export function ok<T>(data: T)           { return { success: true, data }; }
export function err(message: string, code?: string) { return { success: false, error: message, code }; }
