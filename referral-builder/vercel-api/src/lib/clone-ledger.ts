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

export interface CloneLedgerRow {
  source_key: string;
  target_year: number;
  new_deal_id: string;
  created_at: Date;
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
 * Insert a clone into the ledger. The (source_key, target_year) primary
 * key prevents duplicate inserts even if the advisory lock somehow
 * fails (defense in depth). On conflict, we trust the existing row —
 * the caller should have read it before getting here.
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
     VALUES ($1, $2, $3)
     ON CONFLICT (source_key, target_year) DO NOTHING`,
    [sourceKey, targetYear, newDealId]
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
