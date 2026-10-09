SET search_path TO tr;
UPDATE support_cases SET category = 'other' WHERE category IN ('organiser','advertising','callback');
ALTER TABLE support_cases DROP CONSTRAINT support_cases_category_check;
ALTER TABLE support_cases ADD CONSTRAINT support_cases_category_check CHECK (category IN ('tickets','refund','tag','payment','account','other'));
ALTER TABLE support_cases DROP COLUMN IF EXISTS phone, DROP COLUMN IF EXISTS full_name, DROP COLUMN IF EXISTS preferred_time, DROP COLUMN IF EXISTS source, DROP COLUMN IF EXISTS due_at;
DROP TABLE IF EXISTS chat_messages, kb_articles, ad_posters, site_settings;
