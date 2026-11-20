-- 010: events people like (saved to their account).
SET search_path TO tr;
CREATE TABLE event_likes (
  user_id    uuid NOT NULL REFERENCES users(id),
  event_id   uuid NOT NULL REFERENCES events(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX event_likes_event_idx ON event_likes (event_id);
