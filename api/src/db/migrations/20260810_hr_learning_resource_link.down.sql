-- Reverses 20260810_hr_learning_resource_link.
--
-- The cleared course_url values are not restored: they were a placeholder that
-- pointed nowhere, and putting them back would restore the broken link.

ALTER TABLE hr_announcements DROP COLUMN IF EXISTS submitted_by;
ALTER TABLE hr_announcements DROP COLUMN IF EXISTS submitted_at;
ALTER TABLE hr_announcements DROP COLUMN IF EXISTS approved_by;
ALTER TABLE hr_announcements DROP COLUMN IF EXISTS published_at;
