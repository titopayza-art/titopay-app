-- TITOPAY BOOK: THE FOUNDATION.
--
-- A universal booking layer: a business publishes a venue, defines what it
-- offers and what it offers it with, and customers book a span of time against
-- a resource. One engine for restaurants, doctors, car washes, salons, gyms and
-- hotels; the category changes the words on the screen, not the mechanism.
--
-- PURELY ADDITIVE. Seven new tables, all named book_*. No existing table gains a
-- column, loses one, changes a constraint or has a row rewritten. A deployment
-- that never applies this keeps working exactly as it does today.
--
-- WHAT IT DELIBERATELY DOES NOT TOUCH, because these are the financial record
-- and the identity record and Book is neither:
--   wallets, wallet_ledger, revenue_ledger, transactions, transaction_status_history
--   users, sessions, pricing_rules
--   business_profiles, business_representatives, business_staff
-- Book READS those and calls their services. It owns none of them.
--
-- NO SECOND FINANCIAL SYSTEM. There is no balance column, no escrow column, no
-- deposit column and no fee table anywhere below. Money that moves for a booking
-- moves through applyWalletMovement and is recorded in transactions and
-- wallet_ledger like every other rand in TitoPay. The only financial reference
-- here is book_activations.transaction_id, which POINTS AT that record rather
-- than duplicating it, and it is ON DELETE RESTRICT because a payment that
-- happened must not become unattributable.
--
-- NO CHECK CONSTRAINT ON category, deliberately, for the same reason
-- business_type and industry have none: the list of verticals is application
-- configuration in src/config/book-reference.js, and adding "veterinary" must be
-- a deploy rather than a migration. Booking STATUS is the opposite case - it is
-- TitoPay's own vocabulary that every screen keys off, so it IS constrained,
-- under a NAMED constraint so a future state is one ALTER away.

/* ============================================================ the venue */

-- A business's bookable presence. One business account may run several (a
-- restaurant group with three branches), which is why this is its own table
-- rather than columns on business_profiles.
CREATE TABLE IF NOT EXISTS book_venues (
  id UUID PRIMARY KEY,

  -- The business account that owns and is paid for this venue. CASCADE because
  -- a venue is meaningless without the business it belongs to.
  business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The verified business ENTITY, when the business has one.
  --
  -- DECLARED BARE, AND THE FOREIGN KEY IS ATTACHED AT THE BOTTOM OF THIS FILE.
  -- business_profiles is NOT created by schema.sql - it is created by the
  -- 20260816 migration and by ensureBusinessSchema() at runtime. An inline
  -- REFERENCES here would therefore fail on a fresh database, and because
  -- schema.sql runs as ONE statement that failure rolls the ENTIRE schema back
  -- and leaves an empty database. The guarded block at the end adds the
  -- constraint wherever the table does exist.
  business_profile_id UUID,

  -- The public web address. This is what gets shared, printed and posted, so it
  -- is unique platform-wide and never reused.
  slug TEXT NOT NULL,

  name TEXT NOT NULL,
  category TEXT NOT NULL,          -- see the note above: no CHECK, by design

  tagline TEXT,
  description TEXT,

  -- Where it is. Free text rather than a normalised address because a spaza in
  -- a township and a hotel in Sandton do not share an address shape.
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

  -- Opening hours, amenities and category-specific extras (cuisine, price band).
  -- JSONB is the sanctioned extension point and is never nullable here.
  opening_hours JSONB NOT NULL DEFAULT '[]'::JSONB,
  amenities JSONB NOT NULL DEFAULT '[]'::JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,

  -- THE PUBLIC AVAILABILITY COUNTER. A public, unauthenticated, pollable "3
  -- slots left" is marketing for a restaurant and a patient-load signal for a
  -- doctor. Health categories default this to FALSE and show "Accepting
  -- bookings" instead; every business can change it either way.
  shows_availability_count BOOLEAN NOT NULL DEFAULT TRUE,

  -- Whether a booking needs the business to say yes, or is confirmed on the spot.
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

-- The shared link must resolve to exactly one venue, forever.
CREATE UNIQUE INDEX IF NOT EXISTS uq_book_venues_slug ON book_venues (slug);
-- "my venues, newest first" - the default listing shape every owner-scoped
-- table in this schema uses.
CREATE INDEX IF NOT EXISTS idx_book_venues_business ON book_venues (business_user_id, created_at DESC);
-- Discovery reads only published venues, and almost always by category or city.
CREATE INDEX IF NOT EXISTS idx_book_venues_discovery
  ON book_venues (category, city) WHERE status = 'published';

/* ======================================================== the activation */

-- The once-off R250 that unlocks Book for a business.
--
-- ONCE-ONLY IS STRUCTURAL, NOT CHECKED IN CODE. The unique index on
-- business_user_id means a second activation cannot be written even if two
-- taps race past every application guard. Charging a business twice for the
-- same thing is the specific failure this table is shaped to prevent.
CREATE TABLE IF NOT EXISTS book_activations (
  id UUID PRIMARY KEY,
  business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The payment that bought it. RESTRICT, not CASCADE: a transaction that
  -- happened must remain attributable, and deleting it must fail loudly.
  transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,

  -- What was actually charged, read back from pricing at the moment of sale, so
  -- a later price change never rewrites what this business paid.
  amount NUMERIC(18,2) NOT NULL,
  service_code TEXT NOT NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_book_activations_business
  ON book_activations (business_user_id);

/* ========================================================= what is offered */

CREATE TABLE IF NOT EXISTS book_services (
  id UUID PRIMARY KEY,
  venue_id UUID NOT NULL REFERENCES book_venues(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  description TEXT,

  -- What the customer pays. Zero is legitimate and common: a restaurant
  -- reservation and a doctor's appointment are usually booked without payment.
  price NUMERIC(18,2) NOT NULL DEFAULT 0,

  duration_minutes INTEGER NOT NULL DEFAULT 60,
  -- How many of this service can run at once on ONE resource. A class of 20 is
  -- capacity 20 on one room; a haircut is capacity 1 on one chair.
  capacity INTEGER NOT NULL DEFAULT 1,
  -- Cleaning, turnaround, writing notes. Held after the booking so the next one
  -- cannot start into it.
  buffer_minutes INTEGER NOT NULL DEFAULT 0,
  -- How far ahead a customer must book, and how far ahead they may.
  lead_time_minutes INTEGER NOT NULL DEFAULT 0,
  booking_horizon_days INTEGER NOT NULL DEFAULT 90,
  -- How late a customer may cancel without it counting against them.
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

/* ======================================================== what it is offered with */

-- A table, a bay, a room, a chair, a trainer, a class. One shape, because they
-- are all "a thing that can hold N bookings at once".
CREATE TABLE IF NOT EXISTS book_resources (
  id UUID PRIMARY KEY,
  venue_id UUID NOT NULL REFERENCES book_venues(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT 'general',

  -- Covers for a table, seats for a class, one for a treatment chair.
  capacity INTEGER NOT NULL DEFAULT 1,

  -- When a resource IS a person, this is the TitoPay user they are. Optional and
  -- SET NULL because most resources are not people, and because a stylist
  -- leaving must not delete the chair's booking history. The staff RELATIONSHIP
  -- itself lives in business_staff - this is a pointer, not a second staff model.
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

/* ============================================== which service uses which resource */

-- Many to many, because a wash bay serves three wash packages and a stylist
-- does cuts and colour. Without this, availability cannot tell which resources
-- to look at for a given service.
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

/* =============================================================== when it is open */

-- A recurring weekly window.
--
-- MINUTES FROM MIDNIGHT, NOT A TIME COLUMN. South Africa has one timezone and no
-- daylight saving today, but "opens at 09:00" is a wall-clock fact about a place
-- and storing it as an integer makes that unambiguous forever, including if
-- TitoPay ever operates anywhere that does observe DST. 0 is midnight, 1440 is
-- the end of the day.
CREATE TABLE IF NOT EXISTS book_availability_rules (
  id UUID PRIMARY KEY,
  venue_id UUID NOT NULL REFERENCES book_venues(id) ON DELETE CASCADE,

  -- NULL means the whole venue. A value narrows the rule to one resource, which
  -- is how one stylist works Saturdays and the rest do not.
  resource_id UUID REFERENCES book_resources(id) ON DELETE CASCADE,

  -- 0 = Sunday, matching JavaScript's Date.getDay(), because the app reads this.
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

/* ===================================================== a specific day's exception */

-- A public holiday, a wedding that closes the restaurant, a doctor on leave, or
-- extra hours for a festival. Overrides the weekly rule for one date.
CREATE TABLE IF NOT EXISTS book_availability_exceptions (
  id UUID PRIMARY KEY,
  venue_id UUID NOT NULL REFERENCES book_venues(id) ON DELETE CASCADE,
  resource_id UUID REFERENCES book_resources(id) ON DELETE CASCADE,

  -- A true calendar date, which is what DATE is for in this schema.
  exception_date DATE NOT NULL,

  -- Closed all day, or open for a different window.
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

/* ============================================================== the booking */

CREATE TABLE IF NOT EXISTS book_bookings (
  id UUID PRIMARY KEY,

  -- Human-readable, and what a customer reads out over the phone.
  reference TEXT NOT NULL,

  venue_id UUID NOT NULL REFERENCES book_venues(id) ON DELETE CASCADE,
  service_id UUID REFERENCES book_services(id) ON DELETE SET NULL,
  resource_id UUID REFERENCES book_resources(id) ON DELETE SET NULL,

  -- WHO IS COMING. Nullable because a business may take a booking over the phone
  -- for somebody who has no TitoPay account.
  customer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,

  -- WHO MADE IT. Different from the customer for a business-to-business booking:
  -- a company books a restaurant for eight employees, so booked_by is the
  -- company's user and booked_for_business_id names the company.
  booked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Bare for the same reason as book_venues.business_profile_id above; the
  -- foreign key is attached by the guarded block at the end of this file.
  booked_for_business_id UUID,

  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  party_size INTEGER NOT NULL DEFAULT 1,

  status TEXT NOT NULL DEFAULT 'pending',

  -- What it cost, captured at booking time so a later price change does not
  -- rewrite history. The MONEY ITSELF lives in transactions; this is the quote.
  quoted_amount NUMERIC(18,2) NOT NULL DEFAULT 0,

  -- The payment, when there was one. RESTRICT so a payment cannot be orphaned.
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

-- THE AVAILABILITY INDEX. Every overlap check and every calendar view reads
-- exactly this shape: one resource, the bookings that still hold it, by time.
CREATE INDEX IF NOT EXISTS idx_book_bookings_resource_span
  ON book_bookings (resource_id, starts_at, ends_at)
  WHERE status IN ('pending','confirmed','checked_in');

-- The business console's four views: today, upcoming, past, cancelled.
CREATE INDEX IF NOT EXISTS idx_book_bookings_venue_time
  ON book_bookings (venue_id, starts_at DESC);

-- "my bookings" for a customer.
CREATE INDEX IF NOT EXISTS idx_book_bookings_customer
  ON book_bookings (customer_user_id, starts_at DESC)
  WHERE customer_user_id IS NOT NULL;

/* ================================================ deferred foreign keys */

-- business_profiles is created by the 20260816 migration and by
-- ensureBusinessSchema() at runtime, NOT by schema.sql. So the two columns that
-- point at it get their constraint here, guarded, instead of inline.
--
-- WHY GUARDED RATHER THAN UNCONDITIONAL: this same SQL is executed in two very
-- different situations. Applied as a migration to an existing database,
-- business_profiles is already there and the constraint is created. Executed as
-- part of schema.sql on a brand-new database, it is not there yet - and because
-- schema.sql runs as ONE statement, an unguarded ALTER would abort the whole
-- file and leave the database empty. Skipping quietly is correct: the column
-- still exists and still holds the id, and ensureBookSchema() attaches the
-- constraint later once business_profiles has been created.
--
-- This mirrors the deferred-FK block schema.sql already uses for ticket_refunds.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'business_profiles') THEN

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'book_venues_business_profile_fkey'
    ) THEN
      ALTER TABLE book_venues
        ADD CONSTRAINT book_venues_business_profile_fkey
        FOREIGN KEY (business_profile_id) REFERENCES business_profiles(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'book_bookings_booked_for_business_fkey'
    ) THEN
      ALTER TABLE book_bookings
        ADD CONSTRAINT book_bookings_booked_for_business_fkey
        FOREIGN KEY (booked_for_business_id) REFERENCES business_profiles(id) ON DELETE SET NULL;
    END IF;

  ELSE
    RAISE NOTICE 'business_profiles is not present yet; Book''s foreign keys to it will be attached by ensureBookSchema().';
  END IF;
END $$;
