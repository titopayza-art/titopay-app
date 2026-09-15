-- Reverse the TitoPay Book foundation.
--
-- WHAT THIS COSTS: every venue, every service, every resource, every opening
-- hour and EVERY BOOKING is destroyed. Customers with a confirmed table on
-- Friday lose it silently, and the business has no record it ever existed.
-- Export book_bookings before running this if a single real booking has been
-- taken.
--
-- WHAT IT DOES NOT COST: no money is affected. Book owns no balance, no ledger
-- and no transaction. Payments taken for activations or bookings live in
-- transactions, wallet_ledger and revenue_ledger and are untouched by every
-- statement below, so reversing this cannot alter a balance or lose a rand.
--
-- The consequence is that a reversal leaves ORPHANED PAYMENTS: a transactions
-- row that says a business paid R250 for Book with nothing left to point at.
-- That is the correct trade. The financial record is the thing that must never
-- be lost, and it survives.
--
-- Dropped children first, so no statement fails on a dependency.

DROP TABLE IF EXISTS book_bookings;
DROP TABLE IF EXISTS book_availability_exceptions;
DROP TABLE IF EXISTS book_availability_rules;
DROP TABLE IF EXISTS book_service_resources;
DROP TABLE IF EXISTS book_resources;
DROP TABLE IF EXISTS book_services;
DROP TABLE IF EXISTS book_activations;
DROP TABLE IF EXISTS book_venues;
