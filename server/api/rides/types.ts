export interface PickupDropoff {
  address: string;
  lat: number;
  lng: number;
  terminal?: string;
  gate?: string;
  airline?: string;
  flight_number?: string;
  notes?: string;
}

export interface RideRow {
  id: string;
  passenger_id: string;
  driver_id: string | null;
  vehicle_type: string;
  pickup: PickupDropoff;
  dropoff: PickupDropoff;
  pickup_address?: string | null;
  pickup_lat?: number | null;
  pickup_lng?: number | null;
  fare: number | string;
  distance: number | string;
  duration_minutes: number;
  payment_method: string;
  payment_intent_id?: string | null;
  notes?: string | null;
  scheduled_at?: string | null;
  ride_status: string;
  accepted_at?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  rating?: number | null;
  created_at: string;
  updated_at: string;
  pickup_pin?: string | null;
  pin_verified_at?: string | null;
  valet_session_id?: string | null;
  valet_car_photo_url?: string | null;
  valet_odometer_reading?: number | null;
  valet_fuel_level?: string | null;
  valet_keys_tag?: string | null;
  valet_parking_bay?: string | null;
  valet_fee?: number | string | null;
  valet_ticket_number?: string | null;
  valet_vehicle_brand?: string | null;
  valet_vehicle_model?: string | null;
  valet_vehicle_color?: string | null;
  valet_license_plate?: string | null;
}

export interface DriverStats {
  driver_id: string;
  consecutive_trips: number;
  total_earned: number;
  last_updated: string;
}
