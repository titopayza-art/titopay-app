-- TitoPay service catalogue corrections
-- Nine field values across seven rows. Indicative SQL — adjust the table and
-- column names to your schema.
--
-- The app needs no deployment for any of this: the catalogue is fetched on
-- load. Editing services-default.json in the deployment zip has no effect in
-- production, because that file is only the fallback used when GET /v1/services
-- fails.

BEGIN;

-- 1. Hide Stokvel until it has a ledger.
--    The app renders a complete savings-group interface — create, members,
--    contributions, withdrawals, statement — against /v1/stockvels, and there is
--    no service behind that path. Leave status as 'active': the row stays, it is
--    simply not shown. Flip this back to true on the day the Stokvel endpoints
--    in openapi-app.yaml are live, and not before.
UPDATE services SET personal_visible = false WHERE service_code = 'stockvel';

-- 2. Business accounts are showing personal-only services.
--    bill-split: splitting a bill between friends has no merchant meaning.
--    withdraw:   duplicates Payouts, and a merchant has no way to choose
--                between them. Business settles through 'payouts'.
UPDATE services SET business_visible = false
  WHERE service_code IN ('bill-split', 'withdraw');

-- 3. Business accounts are missing two services they should have.
--    'tickets' is browse-and-buy. It is distinct from 'ticketing', which is the
--    organiser dashboard. A business needs both: one to buy, one to sell.
UPDATE services SET business_visible = true
  WHERE service_code IN ('send-gift', 'tickets');

-- 4. Airtime is published three times.
--    The app collapses airtime, data and airtime-data into a single
--    "Airtime & Data" tile everywhere — three tiles with the same icon for
--    overlapping products reads as a bug. Leave airtime-data visible.
UPDATE services SET personal_visible = false, business_visible = false
  WHERE service_code IN ('airtime', 'data');

-- 5. Copy correction. A personal account is not dealing with customers.
UPDATE services
  SET description = 'Request money by username, cellphone number or email.'
  WHERE service_code = 'payment-request';

COMMIT;

-- Verify. Expect exactly the eight rows changed above.
SELECT service_code, personal_visible, business_visible, description
  FROM services
 WHERE service_code IN (
   'stockvel', 'bill-split', 'withdraw', 'send-gift',
   'tickets', 'airtime', 'data', 'payment-request'
 )
 ORDER BY service_code;

-- Catalogue hygiene, no app change either way: nine rows are status
-- 'coming_soon' / 'disabled' and invisible to both account types —
-- shop-marketplace, rewards, business-rewards, virtual-doctor, travel, donate,
-- cross-border, get-cash, cash-back. Either attach a real date or remove them.
