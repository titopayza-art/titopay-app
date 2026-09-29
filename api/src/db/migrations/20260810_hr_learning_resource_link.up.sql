-- "Open resource" pointed at a placeholder, so it went nowhere (N-02).
--
-- Every seeded course was written with course_url = 'hr-learning'. The portal
-- renders the link as <a href={courseUrl}> whenever that field has a value, so
-- all fifteen courses — including the mandatory Anti-Fraud, Cybersecurity and
-- Customer Service ones — showed an "Open resource" button that navigated to a
-- relative path which does not exist.
--
-- The material itself is not missing: it is the course's handbook content and
-- its lessons, read inside the application. Clearing the placeholder makes the
-- portal do the right thing, because it only draws the link when there is a
-- real address to draw it for.
--
-- Only the exact placeholder is cleared. A course someone has since given a
-- real link keeps it.

UPDATE hr_learning_courses
   SET course_url = NULL, updated_at = NOW()
 WHERE course_url IN ('hr-learning', 'hr_learning', '#', '')
   AND deleted_at IS NULL;

-- Approval decisions on an announcement are recorded rather than discarded.
--
-- The portal sends submittedBy/submittedAt when senior staff submit one, and
-- approvedBy/publishedAt when the CEO approves it. None of those columns
-- existed, so every one of them was dropped on the way in: an approved
-- announcement could not say when it went live or who let it, which is the
-- part of an approval workflow worth keeping.

ALTER TABLE hr_announcements ADD COLUMN IF NOT EXISTS submitted_by TEXT;
ALTER TABLE hr_announcements ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE hr_announcements ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE hr_announcements ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

-- Existing announcements keep their history: the row's own creation time is the
-- best available record of when it was submitted, and a published one went live
-- no later than its last update.
UPDATE hr_announcements SET submitted_at = created_at WHERE submitted_at IS NULL;
UPDATE hr_announcements SET published_at = updated_at
 WHERE published_at IS NULL AND status = 'published';
