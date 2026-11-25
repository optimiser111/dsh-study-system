-- M1 schema. 依据 M1-设计与契约.md §3.1。
-- 与已签字 DDL 的差异：reviews.state_json（ts-fsrs 的 Card 状态无法用现有 6 列无损表示）
-- 这条差异已作为「第 8 处差异」报备，等待追签。

CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS courses (
  id          TEXT PRIMARY KEY,
  platform    TEXT NOT NULL,
  external_id TEXT,
  title       TEXT NOT NULL,
  axis        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  course_id     TEXT NOT NULL REFERENCES courses(id),
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL,
  quality_json  TEXT,
  detail        TEXT
);

CREATE TABLE IF NOT EXISTS contents (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id),
  text               TEXT NOT NULL,
  normalizer_version INTEGER NOT NULL,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  course_id      TEXT NOT NULL REFERENCES courses(id),
  source_id      TEXT REFERENCES sources(id),
  content_id     TEXT REFERENCES contents(id),
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  active_seconds INTEGER
);

CREATE TABLE IF NOT EXISTS segments (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  seq         INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  text        TEXT NOT NULL,
  span_start  INTEGER NOT NULL,
  span_end    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id                 TEXT PRIMARY KEY,
  segment_id         TEXT NOT NULL REFERENCES segments(id),
  kind               TEXT NOT NULL,
  question           TEXT NOT NULL,
  options_json       TEXT,
  answer             TEXT NOT NULL,
  span_text          TEXT NOT NULL,
  span_start         INTEGER NOT NULL,
  span_end           INTEGER NOT NULL,
  source_kind        TEXT NOT NULL,
  topic              TEXT,
  difficulty         INTEGER,
  rubric_json        TEXT,
  model              TEXT NOT NULL,
  prompt_version     TEXT NOT NULL,
  normalizer_version INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  discarded          INTEGER NOT NULL DEFAULT 0,
  discard_reason     TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  card_id     TEXT PRIMARY KEY REFERENCES cards(id),
  stability   REAL NOT NULL,
  difficulty  REAL NOT NULL,
  due_at      INTEGER NOT NULL,
  reps        INTEGER NOT NULL DEFAULT 0,
  lapses      INTEGER NOT NULL DEFAULT 0,
  last_rating TEXT,
  state_json  TEXT
);

CREATE TABLE IF NOT EXISTS answers (
  id          TEXT PRIMARY KEY,
  card_id     TEXT NOT NULL REFERENCES cards(id),
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  raw         TEXT NOT NULL,
  correct     INTEGER,
  rubric_json TEXT,
  graded_by   TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  dedupe_key   TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS xp_ledger (
  id       TEXT PRIMARY KEY,
  axis     TEXT NOT NULL,
  delta    INTEGER NOT NULL,
  reason   TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id)
);

CREATE INDEX IF NOT EXISTS idx_cards_seg    ON cards(segment_id);
CREATE INDEX IF NOT EXISTS idx_reviews_due  ON reviews(due_at);
CREATE INDEX IF NOT EXISTS idx_answers_card ON answers(card_id);
CREATE INDEX IF NOT EXISTS idx_events_type  ON events(type, created_at);
