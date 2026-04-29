import { Pool, PoolClient, QueryResultRow } from 'pg';

let _pool: Pool | undefined;

/**
 * Lazy Postgres pool for the external session DB (camp/program/session
 * data, originally hosted by Replit). Configured for Vercel serverless:
 *
 *  - `max: 1` — each warm Lambda holds at most one connection. Multiple
 *    Lambdas in parallel each open their own connection up to the
 *    Postgres server's `max_connections`.
 *  - `idleTimeoutMillis: 5000` — short idle window so connections free up
 *    quickly when traffic is sparse (sales reps clicking the card).
 *  - `connectionTimeoutMillis: 10000` — fail fast if the DB is down so
 *    the route returns a 5xx instead of hanging the Lambda.
 *
 * If we ever migrate this DB to Neon, swap in @neondatabase/serverless's
 * HTTP driver here — that scales to higher concurrency without per-Lambda
 * connections at all.
 */
function getPool(): Pool {
  if (!_pool) {
    if (!process.env.EXTERNAL_DATABASE_URL) {
      throw new Error(
        'EXTERNAL_DATABASE_URL is not defined. Set it in Vercel env vars to point at the camp/program/session Postgres.'
      );
    }
    _pool = new Pool({
      connectionString: process.env.EXTERNAL_DATABASE_URL,
      max: 1,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: false },
    });
    _pool.on('error', (err) => {
      console.error('[pg] Unexpected pool error:', err.message);
    });
  }
  return _pool;
}

/**
 * Run a parameterized query against the external session DB.
 *
 *   const rows = await query<SessionRow>(
 *     'SELECT * FROM sessions WHERE id = $1',
 *     [123]
 *   );
 *
 * Returns just the rows array, not the full pg result object — the
 * additional fields (rowCount, command, fields) aren't needed by callers.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: ReadonlyArray<unknown> = []
): Promise<T[]> {
  const pool = getPool();
  const result = await pool.query<T>(text, values as unknown[]);
  return result.rows;
}

/**
 * Run a function inside a Postgres transaction. The callback gets a
 * dedicated `PoolClient` it can call `.query()` on; that's the same
 * client used for `BEGIN`/`COMMIT`/`ROLLBACK`, so transaction-scoped
 * features (advisory locks, etc.) work correctly.
 *
 *   await withTransaction(async (client) => {
 *     await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
 *     await client.query('INSERT INTO clone_ledger (...) VALUES (...)');
 *   });
 *
 * Rolls back on any thrown error and re-throws. The client is released
 * back to the pool in a `finally`.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr: any) {
      console.warn('[pg] ROLLBACK failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}
