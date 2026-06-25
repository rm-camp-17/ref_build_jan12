#!/usr/bin/env node
/**
 * One-off: inspect the session-amounts Postgres (EXTERNAL_DATABASE_URL — the
 * companies/programs/sessions DB) for where camp write-ups might live, so we
 * can point the memo builder's DB write-up source at the real table/column.
 *
 * Usage:
 *   EXTERNAL_DATABASE_URL=postgres://... node scripts/inspect-writeups.mjs
 *
 * Prints: all public tables, any write-up-ish columns, the full column list of
 * companies/programs/sessions, and the widest text columns (likely narratives).
 * Read-only — runs no DDL/DML.
 */

import pg from 'pg';

async function main() {
  const url = process.env.EXTERNAL_DATABASE_URL;
  if (!url) {
    console.error('Set EXTERNAL_DATABASE_URL (the session-amounts DB URL).');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    const tables = (
      await c.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema='public' ORDER BY table_name`
      )
    ).rows.map((r) => r.table_name);
    console.log('TABLES:\n  ' + tables.join(', ') + '\n');

    const likely = (
      await c.query(
        `SELECT table_name, column_name, data_type
           FROM information_schema.columns
          WHERE table_schema='public'
            AND (column_name ILIKE '%write%' OR column_name ILIKE '%narrative%'
              OR column_name ILIKE '%descrip%' OR column_name ILIKE '%about%'
              OR column_name ILIKE '%overview%' OR column_name ILIKE '%blurb%'
              OR column_name ILIKE '%summary%' OR column_name ILIKE '%bio%'
              OR column_name ILIKE '%profile%' OR column_name ILIKE '%content%'
              OR column_name ILIKE '%note%' OR column_name ILIKE '%detail%')
          ORDER BY table_name, column_name`
      )
    ).rows;
    console.log('WRITE-UP-LIKE COLUMNS:');
    if (likely.length === 0) console.log('  (none found)');
    for (const r of likely) console.log(`  ${r.table_name}.${r.column_name} (${r.data_type})`);
    console.log('');

    for (const t of ['companies', 'programs', 'sessions']) {
      if (!tables.includes(t)) continue;
      const cols = (
        await c.query(
          `SELECT column_name, data_type FROM information_schema.columns
            WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
          [t]
        )
      ).rows;
      console.log(`COLUMNS ON ${t}:`);
      for (const r of cols) console.log(`  ${r.column_name} (${r.data_type})`);
      console.log('');
    }

    // Widest text columns across the DB — narratives tend to be long text.
    const wide = (
      await c.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema='public' AND data_type IN ('text','character varying')
          ORDER BY table_name, column_name`
      )
    ).rows;
    console.log('SAMPLE MAX TEXT LENGTH PER TEXT COLUMN (top 15 widest):');
    const sized = [];
    for (const r of wide) {
      try {
        const max = (
          await c.query(
            `SELECT COALESCE(MAX(LENGTH(${r.column_name}::text)),0) AS n FROM ${r.table_name}`
          )
        ).rows[0].n;
        sized.push({ t: r.table_name, c: r.column_name, n: Number(max) });
      } catch {
        /* skip columns we can't measure */
      }
    }
    sized
      .sort((a, b) => b.n - a.n)
      .slice(0, 15)
      .forEach((s) => console.log(`  ${s.t}.${s.c}: max ${s.n} chars`));
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('inspect-writeups failed:', e.message);
  process.exit(1);
});
