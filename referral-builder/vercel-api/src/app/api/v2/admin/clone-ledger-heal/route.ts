/**
 * GET /api/v2/admin/clone-ledger-heal — repair the clone_ledger dedup table.
 *
 * Runs healCloneLedger against the external Postgres: creates the table if
 * missing, removes duplicate (source_key, target_year) rows (keeping the
 * earliest), and adds the unique index that `ON CONFLICT` / the dedup
 * boundary requires. Idempotent — safe to hit any time.
 *
 * Built for the 2026-07-10 incident where the live table existed without
 * its composite primary key, so every clone's ledger insert failed with
 * "there is no unique or exclusion constraint matching the ON CONFLICT
 * specification" and orphaned the just-created HubSpot deal.
 *
 * Response: { totalRows, removedDuplicates, dedupEnforced }
 */

import { NextResponse } from 'next/server';
import { healCloneLedger } from '@/lib/clone-ledger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  try {
    const health = await healCloneLedger();
    return NextResponse.json(health);
  } catch (err: any) {
    console.error('[clone-ledger-heal] error:', err?.message);
    return NextResponse.json(
      { error: `Heal failed: ${err?.message}` },
      { status: 500 }
    );
  }
}
