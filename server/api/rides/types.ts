export type PickupDropoff = string | { address: string; lat: number; lng: number } | null;

export interface RideRow {
  id: string;
  ride_status: string;
  passenger_id: string;
  driver_id: string | null;
  vehicle_type: string;
  pickup_address: string;
  destination_address?: string;
  pickup_lat: number | null;
  pickup_lng: number | null;
  destination_lat?: number | null;
  destination_lng?: number | null;
  payment_intent_id: string | null;
  payment_method?: string;
  accepted_at: string | null;
  completed_at?: string | null;
  updated_at: string;
  created_at?: string;
  scheduled_at: string | null;
  pickup: PickupDropoff;
  dropoff: PickupDropoff;
  driver_location: { lat: number; lng: number } | null;
  fare?: number | null;
  tip_amount?: number | null;
  notes?: string | null;
  cancel_reason?: string | null;
  promo_code?: string | null;
  surge_multiplier?: number | null;
  booking_type?: string;
  guest_name?: string | null;
  guest_phone?: string | null;
  hourly_hours?: number | null;
}

export interface DriverStats {
  consecutive_trips: number;
  total_earned: number;
}

