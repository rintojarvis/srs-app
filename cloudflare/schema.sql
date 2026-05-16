-- SRS app sync schema for Cloudflare D1
-- All timestamps in `updated_at` are unix epoch milliseconds (INTEGER).
-- JSON-shaped columns are stored as TEXT (D1 has no native JSON type).

CREATE TABLE IF NOT EXISTS cards (
  id           TEXT PRIMARY KEY,
  front        TEXT,
  back         TEXT,
  tags         TEXT,   -- JSON array
  source       TEXT,
  linked_cards TEXT,   -- JSON array
  fsrs         TEXT,   -- JSON object (FSRS state: stability/difficulty/due/etc)
  updated_at   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cards_updated_at ON cards(updated_at);

CREATE TABLE IF NOT EXISTS mistakes (
  id           TEXT PRIMARY KEY,
  at           TEXT,
  text         TEXT,
  tags         TEXT,   -- JSON array
  source       TEXT,
  hit_card_ids TEXT,   -- JSON array
  status       TEXT,
  updated_at   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mistakes_updated_at ON mistakes(updated_at);

CREATE TABLE IF NOT EXISTS checkins (
  date       TEXT PRIMARY KEY,   -- YYYY-MM-DD
  subjects   TEXT,                -- JSON array
  topic      TEXT,
  progress   TEXT,
  sources    TEXT,                -- JSON array
  at         TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_checkins_updated_at ON checkins(updated_at);

CREATE TABLE IF NOT EXISTS review_history (
  card_id     TEXT NOT NULL,
  at          TEXT NOT NULL,
  rating      TEXT,
  card_review TEXT,
  comment     TEXT,
  updated_at  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (card_id, at)
);

CREATE INDEX IF NOT EXISTS idx_review_history_updated_at ON review_history(updated_at);
