/**
 * Clone-ledger ops + advisory lock helpers.
 *
 * The clone_ledger table (migrations/001_clone_ledger.sql) is the
 * source-of-truth dedup boundary for clone-for-year. Reads and writes
 * here happen under a transaction-scoped Postgres advisory lock so
 * concurrent requests for the same (source_key, target_year) pair
 * serialize safely — the dedup is robust against HubSpot's 5-15s search
 * indexing lag, double-clicks, retries, and Lambda concurrency.
 *
 * This module only exposes the lock + ledger primitives. The clone
 * orchestration (HubSpot read, build payload, HubSpot create, copy
 * associations) lives in lib/clone.ts.
 */

import { PoolClient } from 'pg';
import { query } from './pg';

export interface CloneLedgerRow {
  source_key: string;
  target_year: number;
  new_deal_id: string;
  created_at: Date;
}

// Self-heal guard: ensure the clone_ledger table exists at most once per
// process. Cleared implicitly on cold start (each Lambda re-ensures once).
let _ledgerEnsured = false;

export interface CloneLedgerHealth {
  totalRows: number;
  removedDuplicates: number;
  /** True when a unique index/PK on (source_key, target_year) is in place. */
  dedupEnforced: boolean;
}

/**
 * Ensure the clone_ledger table exists AND carries its dedup boundary.
 *
 * Two failure modes seen in production, both self-healed here:
 *  - migrations/001_clone_ledger.sql never applied → every clone throws
 *    `relation "clone_ledger" does not exist`. CREATE TABLE IF NOT EXISTS
 *    fixes it.
 *  - the table EXISTS but without the composite primary key (created by an
 *    older definition or by hand) → CREATE TABLE IF NOT EXISTS silently
 *    keeps it, and every `ON CONFLICT (source_key, target_year)` insert
 *    fails with `there is no unique or exclusion constraint matching the ON
 *    CONFLICT specification` (the 2026-07-10 clone-for-year incident, deals
 *    60920961188 / 58006509201). Healing = dedup existing rows (keep the
 *    earliest — the first clone is the authoritative one), then add a
 *    unique index, which ON CONFLICT accepts just like a constraint.
 *
 * Runs via the pool (autocommit) and must be called BEFORE the clone's own
 * transaction, so a later ROLLBACK in the clone flow can't undo the DDL.
 * Idempotent throughout; a redundant unique index next to an existing PK is
 * harmless on a table this small.
 */
export async function healCloneLedger(): Promise<CloneLedgerHealth> {
  await query(
    `CREATE TABLE IF NOT EXISTS clone_ledger (
       source_key   TEXT          NOT NULL,
       target_year  INTEGER       NOT NULL,
       new_deal_id  BIGINT        NOT NULL,
       created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
       PRIMARY KEY (source_key, target_year)
     )`
  );
  await query(
    `CREATE INDEX IF NOT EXISTS clone_ledger_target_year_idx ON clone_ledger (target_year)`
  );
  // Dedup before adding the unique index — index creation fails while
  // duplicate (source_key, target_year) rows exist. No-op when the PK has
  // been enforcing uniqueness all along.
  const removed = await query(
    `DELETE FROM clone_ledger a
     USING clone_ledger b
     WHERE a.source_key = b.source_key
       AND a.target_year = b.target_year
       AND (a.created_at > b.created_at
            OR (a.created_at = b.created_at AND a.ctid > b.ctid))
     RETURNING 1`
  );
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS clone_ledger_source_year_uq
     ON clone_ledger (source_key, target_year)`
  );
  const [stats] = await query<{ total: number; enforced: boolean }>(
    `SELECT
       (SELECT COUNT(*)::int FROM clone_ledger) AS total,
       EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE tablename = 'clone_ledger' AND indexdef ILIKE '%unique%'
       ) OR EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conrelid = 'clone_ledger'::regclass AND contype IN ('p', 'u')
       ) AS enforced`
  );
  return {
    totalRows: stats?.total ?? 0,
    removedDuplicates: removed.length,
    dedupEnforced: Boolean(stats?.enforced),
  };
}

/** Once-per-process wrapper around healCloneLedger for the clone hot path. */
export async function ensureCloneLedgerTable(): Promise<void> {
  if (_ledgerEnsured) return;
  await healCloneLedger();
  _ledgerEnsured = true;
}

/**
 * Acquire a transaction-scoped advisory lock for an idempotency key.
 * Blocks until the lock is granted (no timeout — the caller's
 * connection-level timeouts apply). Released automatically when the
 * transaction commits or rolls back.
 *
 * Use `hashtext(...)` server-side so we get a deterministic int from
 * the string key — Postgres advisory locks take an int, not a string.
 */
export async function acquireCloneLock(
  client: PoolClient,
  idempotencyKey: string
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    idempotencyKey,
  ]);
}

/**
 * Look up an existing clone in the ledger. Returns null if the
 * (source_key, target_year) pair has not been cloned yet.
 *
 * MUST be called inside a transaction that already holds the advisory
 * lock for this idempotency key — otherwise the lookup races with
 * concurrent inserts.
 */
export async function findCloneLedger(
  client: PoolClient,
  sourceKey: string,
  targetYear: number
): Promise<CloneLedgerRow | null> {
  const result = await client.query<CloneLedgerRow>(
    `SELECT source_key, target_year, new_deal_id, created_at
     FROM clone_ledger
     WHERE source_key = $1 AND target_year = $2
     LIMIT 1`,
    [sourceKey, targetYear]
  );
  return result.rows[0] ?? null;
}

/**
 * Insert a clone into the ledger. Written as INSERT … WHERE NOT EXISTS
 * instead of ON CONFLICT so it works even when the unique index is missing
 * (ON CONFLICT (cols) hard-fails without one — the 2026-07-10 incident).
 * Race-safety comes from the advisory lock the caller holds; the unique
 * index added by healCloneLedger is defense in depth on top.
 *
 * MUST be called inside a transaction that holds the advisory lock.
 */
export async function insertCloneLedger(
  client: PoolClient,
  sourceKey: string,
  targetYear: number,
  newDealId: string
): Promise<void> {
  await client.query(
    `INSERT INTO clone_ledger (source_key, target_year, new_deal_id)
     SELECT $1, $2, $3
     WHERE NOT EXISTS (
       SELECT 1 FROM clone_ledger WHERE source_key = $1 AND target_year = $2
     )`,
    [sourceKey, targetYear, newDealId]
  );
}

/**
 * Drop a ledger row. Used when the recorded clone no longer exists in HubSpot
 * (e.g. a rep deleted the test clone) — we delete the stale row so the clone
 * can be recreated instead of forever deduping to a phantom deal.
 *
 * MUST be called inside a transaction that holds the advisory lock.
 */
export async function deleteCloneLedger(
  client: PoolClient,
  sourceKey: string,
  targetYear: number
): Promise<void> {
  await client.query(
    `DELETE FROM clone_ledger WHERE source_key = $1 AND target_year = $2`,
    [sourceKey, targetYear]
  );
}

/**
 * Build the idempotency key. Stable across retries — same source +
 * target = same lock + same ledger row.
 */
export function buildIdempotencyKey(
  sourceKey: string,
  targetYear: number
): string {
  return `clone:${sourceKey}:${targetYear}`;
}
