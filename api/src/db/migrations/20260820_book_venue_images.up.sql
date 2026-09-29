-- A BOOKING PAGE WITH NO PICTURE OF THE PLACE IS NOT A BOOKING PAGE.
--
-- Two additive columns on book_venues. Nothing is dropped, no constraint on an
-- existing column changes, no row is rewritten, and a deployment that never
-- applies this keeps working exactly as it does.
--
-- STORED THE WAY EVENT POSTERS ALREADY ARE: a data: URL or an https URL in a
-- TEXT column, validated in the service at 700KB, which is the ceiling
-- cleanEventBanner has used since ticketing shipped. No object storage, no new
-- dependency and no second way to hold an image.
--
-- Touches no financial table and no identity table.

ALTER TABLE book_venues
  ADD COLUMN IF NOT EXISTS cover_image_url TEXT;

-- Up to six more, as a JSONB array of the same shape. NOT NULL with a default
-- so no existing row is rewritten.
ALTER TABLE book_venues
  ADD COLUMN IF NOT EXISTS gallery JSONB NOT NULL DEFAULT '[]'::JSONB;
