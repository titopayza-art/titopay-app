-- 007: admin-controlled site settings (maintenance, banner, business hours,
-- legal details, chatbot), advertising posters, chatbot knowledge base and
-- conversation log, callback requests.
SET search_path TO tr;

CREATE TABLE site_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ad_posters (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  subtitle        text,
  image_upload_id uuid REFERENCES uploads(id),
  link_url        text,
  placement       text NOT NULL DEFAULT 'home' CHECK (placement IN ('home','events')),
  starts_at       timestamptz,
  ends_at         timestamptz,
  active          boolean NOT NULL DEFAULT true,
  sort_order      int NOT NULL DEFAULT 0,
  clicks          int NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (link_url IS NULL OR link_url ~ '^(https?://|/)')
);

CREATE TABLE kb_articles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question   text NOT NULL,
  answer     text NOT NULL,
  keywords   text[] NOT NULL DEFAULT '{}',
  link_url   text,
  active     boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Questions asked to the assistant (no account data), kept 90 days to improve answers.
CREATE TABLE chat_messages (
  id           bigserial PRIMARY KEY,
  conversation text NOT NULL,
  question     text NOT NULL,
  answer       text NOT NULL,
  source       text NOT NULL CHECK (source IN ('kb','ai','fallback')),
  article_id   uuid REFERENCES kb_articles(id) ON DELETE SET NULL,
  helpful      boolean,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_created_idx ON chat_messages (created_at);

ALTER TABLE support_cases ADD COLUMN phone text;
ALTER TABLE support_cases ADD COLUMN full_name text;
ALTER TABLE support_cases ADD COLUMN preferred_time text;
ALTER TABLE support_cases ADD COLUMN source text NOT NULL DEFAULT 'web';
ALTER TABLE support_cases ADD COLUMN due_at timestamptz;
ALTER TABLE support_cases DROP CONSTRAINT support_cases_category_check;
ALTER TABLE support_cases ADD CONSTRAINT support_cases_category_check
  CHECK (category IN ('tickets','refund','tag','payment','account','organiser','advertising','callback','other'));
