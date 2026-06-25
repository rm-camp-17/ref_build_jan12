-- Camp write-ups mirror (optional DB-backed source for the memo builder).
--
-- The memo builder reads camp write-ups from the committed data/writeups.json
-- seed by default (MEMO_WRITEUP_SOURCE=seed). To serve them from the session
-- Postgres instead (MEMO_WRITEUP_SOURCE=db or auto), create this table and load
-- it with `npm run sync-writeups` (which upserts the seed into this table).
--
-- Keyed by `slug` (the normalized camp name) so the runtime can fuzzy-match a
-- HubSpot company name to its write-up the same way the seed provider does.

CREATE TABLE IF NOT EXISTS camp_writeups (
  slug          TEXT PRIMARY KEY,
  camp_name     TEXT NOT NULL,
  doc_type      TEXT NOT NULL DEFAULT 'writeup',
  drive_file_id TEXT,
  writeup_text  TEXT NOT NULL,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_camp_writeups_camp_name ON camp_writeups (camp_name);
