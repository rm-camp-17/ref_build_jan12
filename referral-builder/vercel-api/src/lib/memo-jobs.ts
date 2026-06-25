/**
 * Memo-generation job store.
 *
 * Memo generation (gather camps → compose with Claude → render .docx → upload
 * to HubSpot Files) takes 20-60s — far longer than HubSpot's `hubspot.fetch`
 * gateway will wait. So the card no longer waits on it synchronously: the POST
 * route creates a job here, kicks the work off with Vercel `waitUntil` (runs
 * after the response, up to the function's maxDuration), and the card polls the
 * GET route until the job is `done` or `error`. No gateway timeout, and the
 * real error (e.g. a missing Files scope) surfaces in the card instead of an
 * opaque "Gateway took too long".
 *
 * Jobs live in the session Postgres (EXTERNAL_DATABASE_URL — same DB as
 * clone_ledger). The table self-heals (CREATE TABLE IF NOT EXISTS) so no
 * migration step is required.
 */

import { randomUUID } from 'crypto';
import { query } from './pg';

export type MemoJobStatus = 'pending' | 'done' | 'error';

export interface MemoJobRow {
  id: string;
  deal_id: string;
  status: MemoJobStatus;
  file_url: string | null;
  file_name: string | null;
  note_id: string | null;
  camps_included: string | null; // JSON array of camp names
  limited_info: string | null; // JSON array of camp names with no write-up
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MemoJobResult {
  fileUrl: string | null;
  fileName: string;
  noteId: string | null;
  campsIncluded: string[];
  limitedInfoCamps: string[];
}

// Run the DDL at most once per warm process (mirrors clone-ledger).
let _ensured = false;

/**
 * Ensure the memo_jobs table exists. Idempotent; self-heals environments where
 * no migration was applied. Best-effort — callers proceed even if it throws.
 */
export async function ensureMemoJobsTable(): Promise<void> {
  if (_ensured) return;
  await query(
    `CREATE TABLE IF NOT EXISTS memo_jobs (
       id             TEXT         PRIMARY KEY,
       deal_id        TEXT         NOT NULL,
       status         TEXT         NOT NULL DEFAULT 'pending',
       file_url       TEXT,
       file_name      TEXT,
       note_id        TEXT,
       camps_included TEXT,
       limited_info   TEXT,
       error          TEXT,
       created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
       updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
     )`
  );
  await query(
    `CREATE INDEX IF NOT EXISTS memo_jobs_deal_idx ON memo_jobs (deal_id, created_at DESC)`
  );
  _ensured = true;
}

/** Create a new pending job for a deal and return its id. */
export async function createMemoJob(dealId: string): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO memo_jobs (id, deal_id, status) VALUES ($1, $2, 'pending')`,
    [id, dealId]
  );
  return id;
}

/** Fetch a job by id, or null if not found. */
export async function getMemoJob(id: string): Promise<MemoJobRow | null> {
  const rows = await query<MemoJobRow>(
    `SELECT id, deal_id, status, file_url, file_name, note_id,
            camps_included, limited_info, error, created_at, updated_at
       FROM memo_jobs WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] ?? null;
}

/** Mark a job done with its result. */
export async function markMemoJobDone(
  id: string,
  result: MemoJobResult
): Promise<void> {
  await query(
    `UPDATE memo_jobs
        SET status = 'done', file_url = $2, file_name = $3, note_id = $4,
            camps_included = $5, limited_info = $6, error = NULL, updated_at = NOW()
      WHERE id = $1`,
    [
      id,
      result.fileUrl,
      result.fileName,
      result.noteId,
      JSON.stringify(result.campsIncluded ?? []),
      JSON.stringify(result.limitedInfoCamps ?? []),
    ]
  );
}

/** Mark a job failed with a user-facing message. */
export async function markMemoJobError(id: string, message: string): Promise<void> {
  await query(
    `UPDATE memo_jobs SET status = 'error', error = $2, updated_at = NOW() WHERE id = $1`,
    [id, message.slice(0, 2000)]
  );
}
