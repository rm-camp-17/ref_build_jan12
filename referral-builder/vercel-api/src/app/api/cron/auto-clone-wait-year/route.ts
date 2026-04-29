/**
 * GET /api/cron/auto-clone-wait-year
 *
 * Vercel-scheduled cron that resurrects "Closed Lost — wait next year"
 * deals when their `wait_until_year` rolls around. Implements the cron
 * spec in UNIFIED_CARD_SPEC.md §5.3.
 *
 * Schedule: daily at 06:00 UTC (configured in /vercel.json `crons`).
 *
 * Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`. The
 *   handler returns 401 on missing / mismatched header so a public hit
 *   can't trigger a clone storm.
 *
 * Behavior:
 *   1. Find up to 200 candidate deals where:
 *        pipeline = default
 *        dealstage = closedlost
 *        closed_lost_category = WAIT_NEXT_YEAR
 *        wait_until_year = currentYear
 *   2. For each, call `cloneForYear()` with `confirmExpertFields: true`
 *      (the cron is unattended — we trust the snapshot).
 *   3. Aggregate results. The clone_ledger guarantees idempotency, so
 *      re-running on the same candidates after a partial failure is
 *      safe (returns `deduped: true`).
 *
 * Returns 200 even when individual candidates fail — Vercel Cron retries
 * non-2xx responses, and we don't want a single bad record to trigger a
 * retry storm. Per-candidate errors are surfaced in the `errors` array.
 */

import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { cloneForYear } from '@/lib/clone';

// Cap per run so a backlog of stale wait_until_year deals can't blow
// past the HubSpot search limit or the Vercel function timeout. Anything
// beyond this rolls to tomorrow's run.
const MAX_CANDIDATES_PER_RUN = 200;

interface Candidate {
  id: string;
  dealKey: string | null;
  year1: string | null;
  dealname: string | null;
  ownerId: string | null;
}

interface CronError {
  dealId: string;
  message: string;
}

interface CronResponse {
  processed: number;
  created: number;
  deduped: number;
  errors: CronError[];
  /** True when the search hit the cap; more candidates exist for tomorrow. */
  truncated?: boolean;
}

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail closed: if the secret isn't configured, refuse. Better to
    // alert via 401 than silently run with no auth.
    console.error('[cron/auto-clone] CRON_SECRET not configured');
    return false;
  }
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${expected}`;
}

async function findCandidates(currentYear: number): Promise<{
  candidates: Candidate[];
  truncated: boolean;
}> {
  const result = await hubspotClient.crm.deals.searchApi.doSearch({
    filterGroups: [
      {
        filters: [
          { propertyName: 'pipeline', operator: 'EQ' as any, value: 'default' },
          { propertyName: 'dealstage', operator: 'EQ' as any, value: 'closedlost' },
          {
            propertyName: 'closed_lost_category',
            operator: 'EQ' as any,
            value: 'WAIT_NEXT_YEAR',
          },
          {
            propertyName: 'wait_until_year',
            operator: 'EQ' as any,
            value: String(currentYear),
          },
        ],
      },
    ],
    properties: ['deal_key', 'year1', 'dealname', 'hubspot_owner_id'],
    sorts: [],
    limit: MAX_CANDIDATES_PER_RUN,
    after: '0',
  });

  const candidates: Candidate[] = result.results.map((r: any) => {
    const p = (r.properties ?? {}) as Record<string, string | null>;
    return {
      id: r.id,
      dealKey: p.deal_key ?? null,
      year1: p.year1 ?? null,
      dealname: p.dealname ?? null,
      ownerId: p.hubspot_owner_id ?? null,
    };
  });

  // HubSpot's search response includes `paging.next.after` when more
  // results exist beyond the requested limit.
  const truncated = Boolean((result as any).paging?.next?.after);

  return { candidates, truncated };
}

export async function GET(req: NextRequest): Promise<NextResponse<CronResponse>> {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      // Match the response shape so callers always get the same fields.
      { processed: 0, created: 0, deduped: 0, errors: [{ dealId: '', message: 'Unauthorized' }] },
      { status: 401 }
    );
  }

  const currentYear = new Date().getFullYear();
  console.log(`[cron/auto-clone] starting run for year ${currentYear}`);

  let candidates: Candidate[];
  let truncated = false;
  try {
    const found = await findCandidates(currentYear);
    candidates = found.candidates;
    truncated = found.truncated;
  } catch (err: any) {
    console.error('[cron/auto-clone] HubSpot search failed:', err.message, err.stack);
    // Return 200 with the error surfaced. Vercel will retry on 5xx and
    // we don't want a HubSpot blip to cause a retry storm.
    return NextResponse.json({
      processed: 0,
      created: 0,
      deduped: 0,
      errors: [{ dealId: '', message: `Search failed: ${err.message}` }],
    });
  }

  if (truncated) {
    console.warn(
      `[cron/auto-clone] more than ${MAX_CANDIDATES_PER_RUN} candidates found for year ${currentYear} — processing first batch, remainder rolls to tomorrow`
    );
  }

  let created = 0;
  let deduped = 0;
  const errors: CronError[] = [];

  for (const candidate of candidates) {
    console.log(
      `[cron/auto-clone] processing deal ${candidate.id} (${candidate.dealname ?? 'no name'}, owner ${candidate.ownerId ?? 'none'})`
    );
    try {
      const result = await cloneForYear({
        sourceDealId: candidate.id,
        targetYear: currentYear,
        // Automated run — trust the source snapshot. The rep can't
        // confirm at 06:00 UTC, and the clone_ledger keeps re-runs safe.
        confirmExpertFields: true,
      });

      if (result.success) {
        if (result.deduped) {
          deduped++;
          console.log(
            `[cron/auto-clone] deal ${candidate.id} already cloned to ${result.newDealId}`
          );
        } else {
          created++;
          console.log(
            `[cron/auto-clone] deal ${candidate.id} cloned to ${result.newDealId}`
          );
        }
      } else {
        const message =
          'message' in result && typeof result.message === 'string'
            ? result.message
            : 'Clone failed';
        errors.push({ dealId: candidate.id, message });
        console.error(
          `[cron/auto-clone] deal ${candidate.id} failed: ${message}`
        );
      }
    } catch (err: any) {
      // Don't let one bad record block the rest of the batch.
      const message = err?.message ?? String(err);
      errors.push({ dealId: candidate.id, message });
      console.error(
        `[cron/auto-clone] deal ${candidate.id} threw:`,
        message,
        err?.stack
      );
    }
  }

  const response: CronResponse = {
    processed: candidates.length,
    created,
    deduped,
    errors,
  };
  if (truncated) {
    response.truncated = true;
  }

  console.log(
    `[cron/auto-clone] run complete: processed=${response.processed} created=${created} deduped=${deduped} errors=${errors.length}${truncated ? ' (truncated)' : ''}`
  );

  // Always 200 — partial failures don't trigger Vercel retries.
  return NextResponse.json(response);
}
