/**
 * GET /api/v2/admin/legacy-family-probe — read-only diagnostic against the
 * legacy camp/program/session Postgres (EXTERNAL_DATABASE_URL).
 *
 * Built for the Ruth Abramson wrong-parent incident (2026-07-23): outgoing
 * referrals listed a parent ("Leah Abramson") who exists NOWHERE in HubSpot,
 * so the mailer's family data must come from this legacy DB. This probe
 * finds where.
 *
 * Modes:
 *   ?q=abramson            search name/email-ish text columns across
 *                          family/contact/child/referral-ish tables
 *   ?q=...&table=families  restrict the search to one table (all text cols)
 *   ?tables=1              just list tables + their columns
 *
 * Strictly read-only SELECTs; identifiers come from information_schema (never
 * from user input), values are parameterized. Row caps keep output small.
 * TEMPORARY: remove once the incident is diagnosed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/pg';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TABLE_HINT = /famil|contact|parent|child|kid|client|referr|household|deal|signup|enroll/i;
const COL_HINT = /name|email|parent|guardian|mother|father|contact/i;
const TEXT_TYPES = new Set(['text', 'character varying', 'character', 'citext']);
const MAX_TABLES = 15;
const MAX_ROWS = 8;

function quoteIdent(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').trim();
  const onlyTable = (searchParams.get('table') || '').trim();
  const listOnly = searchParams.get('tables') === '1';

  try {
    const columns = await query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`
    );

    const byTable = new Map<string, Array<{ column_name: string; data_type: string }>>();
    for (const c of columns) {
      const list = byTable.get(c.table_name) || [];
      list.push({ column_name: c.column_name, data_type: c.data_type });
      byTable.set(c.table_name, list);
    }

    if (listOnly) {
      const tables: Record<string, string[]> = {};
      for (const [t, cols] of byTable.entries()) {
        tables[t] = cols.map((c) => c.column_name);
      }
      return NextResponse.json({ tableCount: byTable.size, tables });
    }

    if (!q) {
      return NextResponse.json(
        { error: 'Pass ?q=<name fragment> (or ?tables=1 to list tables).' },
        { status: 400 }
      );
    }

    // Candidate tables: explicitly requested, or name/column heuristics.
    let candidates = Array.from(byTable.keys()).filter((t) => {
      if (onlyTable) return t === onlyTable;
      if (TABLE_HINT.test(t)) return true;
      return (byTable.get(t) || []).some(
        (c) => COL_HINT.test(c.column_name) && TEXT_TYPES.has(c.data_type)
      );
    });
    candidates = candidates.slice(0, MAX_TABLES);

    const hits: Record<string, unknown[]> = {};
    const searched: Record<string, string[]> = {};
    for (const t of candidates) {
      const cols = (byTable.get(t) || []).filter((c) => TEXT_TYPES.has(c.data_type));
      const searchCols = (onlyTable
        ? cols
        : cols.filter((c) => COL_HINT.test(c.column_name))
      ).slice(0, 6);
      if (searchCols.length === 0) continue;
      searched[t] = searchCols.map((c) => c.column_name);
      const where = searchCols
        .map((c) => `${quoteIdent(c.column_name)} ILIKE $1`)
        .join(' OR ');
      try {
        const rows = await query(
          `SELECT * FROM ${quoteIdent(t)} WHERE ${where} LIMIT ${MAX_ROWS}`,
          [`%${q}%`]
        );
        if (rows.length > 0) hits[t] = rows;
      } catch (err: any) {
        hits[`${t}:error`] = [err?.message];
      }
    }

    return NextResponse.json({ q, searched, hits });
  } catch (err: any) {
    console.error('[legacy-family-probe] error:', err?.message);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}
