"use strict";

// TITOPAY BOOK: THE RUNTIME SCHEMA GUARD.
//
// This is the THIRD copy of Book's schema, and all three are deliberate:
//
//   1. src/db/migrations/20260819_book_foundation.up.sql
//        what an EXISTING database applies.
//   2. the block appended at the end of src/db/schema.sql
//        what a NEW database gets, because db:init-production reads the .sql
//        files and NEVER reads migrations.
//   3. this file
//        what a deployment that has done neither gets, lazily, on first use.
//
// Three copies drift. So test/book-schema-duality.test.js compares all three
// against a real database and fails if they disagree - that test is the reason
// this is safe, not the comments.
//
// IT ALSO DOES SOMETHING THE OTHER TWO CANNOT. business_profiles is created by
// the 20260816 migration and by ensureBusinessSchema(), never by schema.sql, so
// Book's two foreign keys into it cannot be declared inline: on a fresh database
// they would abort schema.sql, and because that file runs as ONE statement the
// whole schema would roll back and leave the database EMPTY. They are declared
// bare and attached here, once business_profiles actually exists.

const { pool } = require("../db/pool");

// The memoized-promise-that-clears-on-failure shape used by every other
// ensure*Schema in this codebase. A failed attempt must not be cached, or one
// transient error makes the service permanently broken for the process.
let schemaReady = null;

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS book_venues (
  id UUID PRIMARY KEY,
  business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_profile_id UUID,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  tagline TEXT,
  description TEXT,
  address_line TEXT,
  suburb TEXT,
  city TEXT,
  province TEXT,
  postal_code TEXT,
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  contact_phone TEXT,
  contact_email TEXT,
  website_url TEXT,
  opening_hours JSONB NOT NULL DEFAULT '[]'::JSONB,
  amenities JSONB NOT NULL DEFAULT '[]'::JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  shows_availability_count BOOLEAN NOT NULL DEFAULT TRUE,
  auto_confirm BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'draft',
  published_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT book_venues_status_check
    CHECK (status IN ('draft','published','paused','archived'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_book_venues_slug ON book_venues (slug);
CREATE INDEX IF NOT EXISTS idx_book_venues_business ON book_venues (business_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_book_venues_discovery
  ON book_venues (category, city) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS book_activations (
  id UUID PRIMARY KEY,
  business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,
  amount NUMERIC(18,2) NOT NULL,
  service_code TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_book_activations_business
  ON book_activations (business_user_id);

CREATE TABLE IF NOT EXISTS book_services (
  id UUID PRIMARY KEY,
  venue_id UUID NOT NULL REFERENCES book_venues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(18,2) NOT NULL DEFAULT 0,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  capacity INTEGER NOT NULL DEFAULT 1,
  buffer_minutes INTEGER NOT NULL DEFAULT 0,
  lead_time_minutes INTEGER NOT NULL DEFAULT 0,
  booking_horizon_days INTEGER NOT NULL DEFAULT 90,
  cancellation_notice_minutes INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT book_services_status_check CHECK (status IN ('active','inactive')),
  CONSTRAINT book_services_duration_check CHECK (duration_minutes > 0 AND duration_minutes <= 1440),
  CONSTRAINT book_services_capacity_check CHECK (capacity > 0),
  CONSTRAINT book_services_price_check CHECK (price >= 0)
);
CREATE INDEX IF NOT EXISTS idx_book_services_venue ON book_services (venue_id, sort_order, created_at);

CREATE TABLE IF NOT EXISTS book_resources (
  id UUID PRIMARY KEY,
  venue_id UUID NOT NULL REFERENCES book_venues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT 'general',
  capacity INTEGER NOT NULL DEFAULT 1,
  staff_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT book_resources_status_check CHECK (status IN ('active','inactive')),
  CONSTRAINT book_resources_capacity_check CHECK (capacity > 0)
);
CREATE INDEX IF NOT EXISTS idx_book_resources_venue ON book_resources (venue_id, sort_order, created_at);

CREATE TABLE IF NOT EXISTS book_service_resources (
  id UUID PRIMARY KEY,
  service_id UUID NOT NULL REFERENCES book_services(id) ON DELETE CASCADE,
  resource_id UUID NOT NULL REFERENCES book_resources(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_book_service_resources
  ON book_service_resources (service_id, resource_id);
CREATE INDEX IF NOT EXISTS idx_book_service_resources_resource
  ON book_service_resources (resource_id);

CREATE TABLE IF NOT EXISTS book_availability_rules (
  id UUID PRIMARY KEY,
  venue_id UUID NOT NULL REFERENCES book_venues(id) ON DELETE CASCADE,
  resource_id UUID REFERENCES book_resources(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL,
  opens_minute INTEGER NOT NULL,
  closes_minute INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT book_availability_day_check CHECK (day_of_week BETWEEN 0 AND 6),
  CONSTRAINT book_availability_window_check
    CHECK (opens_minute >= 0 AND closes_minute <= 1440 AND closes_minute > opens_minute)
);
CREATE INDEX IF NOT EXISTS idx_book_availability_venue
  ON book_availability_rules (venue_id, day_of_week);

CREATE TABLE IF NOT EXISTS book_availability_exceptions (
  id UUID PRIMARY KEY,
  venue_id UUID NOT NULL REFERENCES book_venues(id) ON DELETE CASCADE,
  resource_id UUID REFERENCES book_resources(id) ON DELETE CASCADE,
  exception_date DATE NOT NULL,
  is_closed BOOLEAN NOT NULL DEFAULT TRUE,
  opens_minute INTEGER,
  closes_minute INTEGER,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT book_exception_window_check CHECK (
    is_closed = TRUE
    OR (opens_minute IS NOT NULL AND closes_minute IS NOT NULL
        AND opens_minute >= 0 AND closes_minute <= 1440 AND closes_minute > opens_minute)
  )
);
CREATE INDEX IF NOT EXISTS idx_book_exceptions_venue
  ON book_availability_exceptions (venue_id, exception_date);

CREATE TABLE IF NOT EXISTS book_bookings (
  id UUID PRIMARY KEY,
  reference TEXT NOT NULL,
  venue_id UUID NOT NULL REFERENCES book_venues(id) ON DELETE CASCADE,
  service_id UUID REFERENCES book_services(id) ON DELETE SET NULL,
  resource_id UUID REFERENCES book_resources(id) ON DELETE SET NULL,
  customer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  booked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  booked_for_business_id UUID,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  party_size INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  quoted_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,
  customer_notes TEXT,
  business_notes TEXT,
  cancellation_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  confirmed_at TIMESTAMPTZ,
  checked_in_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancelled_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT book_bookings_status_check
    CHECK (status IN ('pending','confirmed','checked_in','completed','cancelled','rejected','no_show')),
  CONSTRAINT book_bookings_span_check CHECK (ends_at > starts_at),
  CONSTRAINT book_bookings_party_check CHECK (party_size > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_book_bookings_reference ON book_bookings (reference);
CREATE INDEX IF NOT EXISTS idx_book_bookings_resource_span
  ON book_bookings (resource_id, starts_at, ends_at)
  WHERE status IN ('pending','confirmed','checked_in');
CREATE INDEX IF NOT EXISTS idx_book_bookings_venue_time
  ON book_bookings (venue_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_book_bookings_customer
  ON book_bookings (customer_user_id, starts_at DESC)
  WHERE customer_user_id IS NOT NULL;
`;

// The two foreign keys that cannot be declared inline. Guarded on both sides:
// the table has to exist, and the constraint must not already be there.
const DEFERRED_FK_SQL = `
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'business_profiles') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'book_venues_business_profile_fkey') THEN
      ALTER TABLE book_venues
        ADD CONSTRAINT book_venues_business_profile_fkey
        FOREIGN KEY (business_profile_id) REFERENCES business_profiles(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'book_bookings_booked_for_business_fkey') THEN
      ALTER TABLE book_bookings
        ADD CONSTRAINT book_bookings_booked_for_business_fkey
        FOREIGN KEY (booked_for_business_id) REFERENCES business_profiles(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;
`;

// EVERY COLUMN A LATER BOOK MIGRATION ADDS MUST BE REPEATED HERE.
//
// CREATE TABLE IF NOT EXISTS is a no-op against a table that already exists, so
// whichever of the three copies ran FIRST defines the table forever. If a later
// migration adds a column and this list is not updated, a database whose tables
// were built by this file silently lacks it, and the failure appears as a 500 on
// one deployment and not another. This is not hypothetical: it is exactly the
// bug that shipped in business-verification-service and had to be repaired.
const LATER_COLUMNS_SQL = `
-- (empty: no Book migration has added a column yet. Add ALTER TABLE ... ADD
--  COLUMN IF NOT EXISTS lines here in the SAME commit as any future migration.)
SELECT 1;
`;

async function build() {
  await pool.query(CREATE_SQL);
  await pool.query(LATER_COLUMNS_SQL);
  // Last, because it depends on the tables above existing.
  await pool.query(DEFERRED_FK_SQL);
}

/**
 * Make sure Book's tables exist before touching them.
 *
 * Safe to call on every request: the work happens once per process and the
 * result is a resolved promise thereafter. Safe to call concurrently. Safe on a
 * database where the migration already ran, because every statement is
 * IF NOT EXISTS.
 */
function ensureBookSchema() {
  if (!schemaReady) {
    schemaReady = build().catch((error) => {
      // Do not cache a failure, or one transient error breaks Book for the
      // lifetime of the process.
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

// Tests need to force a rebuild against a freshly created database.
function resetForTests() {
  schemaReady = null;
}

module.exports = { ensureBookSchema, resetForTests, CREATE_SQL, DEFERRED_FK_SQL };
