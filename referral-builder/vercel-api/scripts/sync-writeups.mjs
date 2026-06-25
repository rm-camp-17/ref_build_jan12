#!/usr/bin/env node
/**
 * Loads the committed camp write-up seed (data/writeups.json) into the
 * `camp_writeups` table in the session Postgres, so the memo builder can serve
 * write-ups from the DB (MEMO_WRITEUP_SOURCE=db or auto) instead of the bundled
 * seed.
 *
 * Usage:
 *   EXTERNAL_DATABASE_URL=postgres://... node scripts/sync-writeups.mjs
 *
 * Idempotent: creates the table if needed and upserts every seed row by slug.
 * To refresh the write-ups themselves, re-extract them from Google Drive into
 * data/writeups.json (see referral-builder/MEMO_BUILDER.md), then re-run this.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(__dirname, '..', 'data', 'writeups.json');

async function main() {
  const connectionString = process.env.EXTERNAL_DATABASE_URL;
  if (!connectionString) {
    console.error('EXTERNAL_DATABASE_URL is required.');
    process.exit(1);
  }

  let seed;
  try {
    seed = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  } catch (e) {
    console.error(`Failed to read ${SEED_PATH}:`, e.message);
    process.exit(1);
  }
  if (!Array.isArray(seed) || seed.length === 0) {
    console.error('Seed is empty — nothing to sync.');
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString,
    max: 1,
    ssl: { rejectUnauthorized: false },
  });

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS camp_writeups (
        slug          TEXT PRIMARY KEY,
        camp_name     TEXT NOT NULL,
        doc_type      TEXT NOT NULL DEFAULT 'writeup',
        drive_file_id TEXT,
        writeup_text  TEXT NOT NULL,
        synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    let upserted = 0;
    for (const r of seed) {
      const slug = (r.slug || '').trim();
      const text = (r.text || '').trim();
      if (!slug || !text) continue;
      await client.query(
        `INSERT INTO camp_writeups (slug, camp_name, doc_type, drive_file_id, writeup_text, synced_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (slug) DO UPDATE SET
           camp_name = EXCLUDED.camp_name,
           doc_type = EXCLUDED.doc_type,
           drive_file_id = EXCLUDED.drive_file_id,
           writeup_text = EXCLUDED.writeup_text,
           synced_at = NOW()`,
        [
          slug,
          r.campName || r.title || slug,
          r.docType === 'recap' ? 'recap' : 'writeup',
          r.driveFileId || null,
          text,
        ]
      );
      upserted++;
    }
    console.log(`Synced ${upserted} write-ups into camp_writeups.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('sync-writeups failed:', e.message);
  process.exit(1);
});
