-- ==========================================
-- URBONT: Master Database SQL Schema
-- Description: Run this file entirely in the Supabase SQL Editor to generate the entire database architecture.
-- ==========================================

-- 1. Enable UUID Extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==========================================
-- 2. CORE: Profiles (Syncs with Auth)
-- ==========================================
CREATE TABLE public.profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  phone TEXT UNIQUE,
  email TEXT UNIQUE,
  role TEXT DEFAULT 'passenger' CHECK (role IN ('passenger', 'chauffeur', 'valet', 'admin', 'driver', 'concierge')),
  status_val TEXT DEFAULT 'active',
  rating NUMERIC(3, 2) DEFAULT 5.0,
  total_rides INTEGER DEFAULT 0,
  stripe_customer_id TEXT,
  pin_hash TEXT,
  avatar_url TEXT,
  title TEXT,
  business_name TEXT,
  home_address TEXT,
  work_address TEXT,
  hotel_name TEXT, -- only for Valets
  referral_code TEXT, -- only for Valets
  -- Driver personal info (required for onboarding; added here so Supabase-only
  -- setups don't need runMigrations() just to save driver profile data)
  date_of_birth TEXT,
  drivers_license TEXT,
  license_expiry TEXT,
  ssn_last4 TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Trigger to Automatically create a profile when a new Auth User signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (new.id, new.email);
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- ==========================================
-- 3. RLS Policies (Security)
-- ==========================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read their own profile." ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update their own profile." ON public.profiles FOR UPDATE USING (auth.uid() = id);
-- Note: Admins can bypass this if you set an admin policy.


-- ==========================================
-- 4. RIDES AND TRIPS
-- ==========================================
CREATE TABLE public.rides (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  passenger_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  driver_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  concierge_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL, -- if booked completely by Valet
  ride_status TEXT DEFAULT 'searching' CHECK (ride_status IN ('searching', 'confirmed', 'in_progress', 'completed', 'cancelled')),
  vehicle_type TEXT NOT NULL,
  pickup_address TEXT NOT NULL,
  pickup_lat NUMERIC(10, 8),
  pickup_lng NUMERIC(11, 8),
  dropoff_address TEXT NOT NULL,
  dropoff_lat NUMERIC(10, 8),
  dropoff_lng NUMERIC(11, 8),
  fare NUMERIC(10, 2) NOT NULL,
  distance_meters NUMERIC(10, 2),
  distance_text TEXT,
  duration_minutes INTEGER,
  payment_method TEXT DEFAULT 'card',
  scheduled_at TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE public.ride_logs (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  ride_id UUID REFERENCES public.rides(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);


-- ==========================================
-- 5. CHAUFFEUR LOCATIONS & DOCUMENTS
-- ==========================================
CREATE TABLE public.driver_locations (
  driver_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE PRIMARY KEY,
  lat NUMERIC(10, 8) NOT NULL,
  lng NUMERIC(11, 8) NOT NULL,
  heading NUMERIC(5, 2),
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- driver_documents: one row per (driver, doc_key).
-- The UNIQUE constraint on (driver_id, doc_key) is required for Supabase
-- PostgREST's onConflict upsert to work correctly (Uber-style: re-uploading
-- a document replaces the existing record and resets status to 'pending').
CREATE TABLE public.driver_documents (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  driver_id     UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  doc_key       TEXT NOT NULL,
  document_type TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'pending_review', 'approved', 'rejected')),
  storage_url   TEXT,
  image_url     TEXT,
  file_name     TEXT,
  driver_name   TEXT,
  expiry_date   DATE,
  notified_30d  BOOLEAN DEFAULT false,
  notified_7d   BOOLEAN DEFAULT false,
  rejection_reason TEXT,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at    TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  CONSTRAINT driver_documents_driver_doc_key_unique UNIQUE (driver_id, doc_key)
);


-- ==========================================
-- 6. COMMUNICATIONS & SUPPORT
-- ==========================================
CREATE TABLE public.ride_chats (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  ride_id UUID REFERENCES public.rides(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  translated_message TEXT,
  sender_role TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE public.support_tickets (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'closed')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE public.incidents (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  ride_id UUID REFERENCES public.rides(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  details TEXT,
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE public.notifications (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE public.user_push_tokens (
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE PRIMARY KEY,
  token TEXT NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);


-- ==========================================
-- 7. MISC / GIFT REQUESTS
-- ==========================================
CREATE TABLE public.gift_requests (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  requester_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  recipient_name TEXT NOT NULL,
  recipient_phone TEXT NOT NULL,
  vehicle_type TEXT NOT NULL,
  pickup_address TEXT NOT NULL,
  dropoff_address TEXT NOT NULL,
  scheduled_at TIMESTAMP WITH TIME ZONE,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);


-- ==========================================
-- 8. DRIVER STATS & STREAKS
-- ==========================================
CREATE TABLE IF NOT EXISTS public.driver_stats (
  driver_id          UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  consecutive_trips  INTEGER       NOT NULL DEFAULT 0,
  total_earned       NUMERIC(10,2) NOT NULL DEFAULT 0,
  trips_accepted     INTEGER       NOT NULL DEFAULT 0,
  trips_offered      INTEGER       NOT NULL DEFAULT 0,
  trips_completed    INTEGER       NOT NULL DEFAULT 0,
  last_updated       TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);

-- ==========================================
-- 9. FEEDBACK / DISPUTES
-- ==========================================
CREATE TABLE IF NOT EXISTS public.feedback (
  id         UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ride_id    UUID REFERENCES public.rides(id) ON DELETE SET NULL,
  type       TEXT NOT NULL DEFAULT 'general',
  category   TEXT,
  rating     INTEGER,
  comment    TEXT,
  metadata   JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ==========================================
-- 10. FAVORITE DRIVERS
-- ==========================================
CREATE TABLE IF NOT EXISTS public.favorite_drivers (
  id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  passenger_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  driver_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  UNIQUE(passenger_id, driver_id)
);

-- ==========================================
-- 11. AIRPORT QUEUE (MIA / FLL / OPF)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.airport_queue (
  id           UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  driver_id    UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  airport_code TEXT NOT NULL DEFAULT 'MIA',
  position     INTEGER NOT NULL DEFAULT 1,
  active       BOOLEAN NOT NULL DEFAULT true,
  joined_at    TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ==========================================
-- 12. STORAGE BUCKETS
-- ==========================================
-- Make sure to create these buckets manually in the Supabase Dashboard if the script fails to:
INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', true) ON CONFLICT DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('chauffeur-docs', 'chauffeur-docs', false) ON CONFLICT DO NOTHING;

-- Allows Public to read avatars
CREATE POLICY "Avatar images are publicly accessible." 
  ON storage.objects FOR SELECT USING (bucket_id = 'avatars');

-- Allow authenticated users to upload their own avatar
CREATE POLICY "Users can upload their own avatar."
  ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'avatars' AND auth.role() = 'authenticated');
