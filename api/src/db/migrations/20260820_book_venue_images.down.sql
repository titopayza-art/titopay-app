-- Reverse the venue images.
--
-- WHAT THIS COSTS: every business's cover photo and gallery is destroyed and
-- nothing else holds a copy. They were uploaded by the business and can only be
-- recovered by asking each one again.
--
-- No money is affected: these columns hold pictures, nothing else.

ALTER TABLE book_venues DROP COLUMN IF EXISTS gallery;
ALTER TABLE book_venues DROP COLUMN IF EXISTS cover_image_url;
