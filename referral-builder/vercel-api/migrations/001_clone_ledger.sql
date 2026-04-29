-- Migration: clone_ledger
-- Created: 2026-04-29 (Phase 3c)
-- Database: EXTERNAL_DATABASE_URL (the camp/program/session Postgres)
--
-- Stores authoritative records of every clone-for-year operation. The
-- (source_key, target_year) primary key is the dedup boundary that
-- prevents the same source deal from being cloned twice for the same
-- year — the failure mode that would create duplicate placements in
-- ce-billing and double-bill experts (UNIFIED_CARD_SPEC.md §1 Rule 3).
--
-- The clone-for-year route acquires a Postgres transaction-scoped
-- advisory lock keyed on hashtext(idempotencyKey) before reading or
-- writing this table, so concurrent requests serialize on the same
-- (source_key, target_year) pair regardless of HubSpot's eventually-
-- consistent search.

CREATE TABLE IF NOT EXISTS clone_ledger (
  source_key   TEXT          NOT NULL,
  target_year  INTEGER       NOT NULL,
  new_deal_id  BIGINT        NOT NULL,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_key, target_year)
);

-- Optional: index for "what's been cloned to this year" reporting
CREATE INDEX IF NOT EXISTS clone_ledger_target_year_idx
  ON clone_ledger (target_year);

-- Optional: index for "all clones of this source"
CREATE INDEX IF NOT EXISTS clone_ledger_source_key_idx
  ON clone_ledger (source_key);
