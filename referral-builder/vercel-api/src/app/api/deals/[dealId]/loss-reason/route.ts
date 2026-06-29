/**
 * PATCH /api/deals/[dealId]/loss-reason
 *
 * Closed Lost capture (UNIFIED_CARD_SPEC.md §4.5, §4.6) — writes the
 * loss category + free-text reason, optionally with a `wait_until_year`
 * (only meaningful when category = WAIT_NEXT_YEAR), and optionally
 * advances the deal's stage to `closedlost` when called from a
 * non-terminal stage's "Mark as Lost" action (§4.6).
 *
 * Body:
 *   {
 *     closed_lost_category: 'WAIT_NEXT_YEAR' | 'RETURNING_CAMPER'
 *                           | 'OTHER_PROGRAM' | 'OUT_OF_MARKET' | 'MONEY'
 *                           | 'NON_RESPONSIVE' | 'OTHER',
 *     closed_lost_reason?: string,
 *     wait_until_year?: number,    // required for WAIT_NEXT_YEAR; optional for
 *                                  // RETURNING_CAMPER; rejected otherwise
 *     setStageToLost?: boolean     // when true, also patches dealstage = closedlost
 *   }
 *
 * Response:
 *   { success: true, advancedToLost: boolean }
 *
 * Validation:
 *   - category must be one of the seven above
 *   - wait_until_year, when provided, must be an integer >= currentYear (a bare
 *     currentYear floors up to currentYear + 1). It is required for
 *     WAIT_NEXT_YEAR, allowed for RETURNING_CAMPER, and rejected for the rest.
 *   - "RETURNING_CAMPER" = the camper is coming back (often re-enrolling
 *     directly, so no commission this year); the rep clones to next year to
 *     keep following the relationship.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDeal, updateDeal } from '@/lib/deals';
import { parseRequestBody } from '@/lib/parse-request-body';
import { notifyPipelineFailure } from '@/lib/error-notifier';
import {
  requireUnlocked,
  RequireUnlockedError,
} from '@/lib/require-unlocked';
import {
  requireDealAuthorization,
  DealAuthorizationError,
} from '@/lib/require-deal-authorization';

const VALID_LOSS_CATEGORIES = [
  'WAIT_NEXT_YEAR',
  'RETURNING_CAMPER',
  'OTHER_PROGRAM',
  'OUT_OF_MARKET',
  'MONEY',
  'NON_RESPONSIVE',
  'OTHER',
] as const;

type LossCategory = (typeof VALID_LOSS_CATEGORIES)[number];

// Categories that carry a next-year follow-up year (wait_until_year): the
// family is expected back next year, so we record the year for follow-up and
// to pre-fill the clone. Required for WAIT_NEXT_YEAR (the family explicitly
// said "next year"); optional for RETURNING_CAMPER (returning camper, no
// commission this year — clone to keep following the relationship).
const WAIT_YEAR_CATEGORIES: readonly LossCategory[] = [
  'WAIT_NEXT_YEAR',
  'RETURNING_CAMPER',
];

const CLOSED_LOST_STAGE = 'closedlost';

export async function PATCH(
  req: NextRequest,
  { params }: { params: { dealId: string } }
) {
  const { dealId } = params;

  if (!dealId || !/^\d+$/.test(dealId)) {
    return NextResponse.json(
      { success: false, message: 'Valid Deal ID is required.' },
      { status: 400 }
    );
  }

  const rawBody = await req.text();
  let body: {
    closed_lost_category?: string;
    closed_lost_reason?: string;
    wait_until_year?: unknown;
    setStageToLost?: unknown;
  };
  try {
    body = parseRequestBody(rawBody) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid JSON in request body.' },
      { status: 400 }
    );
  }

  const category = body.closed_lost_category;
  if (!category || !VALID_LOSS_CATEGORIES.includes(category as LossCategory)) {
    return NextResponse.json(
      {
        success: false,
        message: `closed_lost_category must be one of: ${VALID_LOSS_CATEGORIES.join(', ')}.`,
      },
      { status: 400 }
    );
  }

  // wait_until_year validation
  let resolvedWaitUntilYear: number | undefined;
  const waitProvided = body.wait_until_year !== undefined && body.wait_until_year !== null;
  const usesWaitYear = WAIT_YEAR_CATEGORIES.includes(category as LossCategory);

  // Required for WAIT_NEXT_YEAR (the family explicitly named a year).
  if (category === 'WAIT_NEXT_YEAR' && !waitProvided) {
    return NextResponse.json(
      {
        success: false,
        message: 'wait_until_year is required when closed_lost_category is WAIT_NEXT_YEAR.',
      },
      { status: 400 }
    );
  }
  // Only the next-year categories may carry a wait year.
  if (waitProvided && !usesWaitYear) {
    return NextResponse.json(
      {
        success: false,
        message: 'wait_until_year is only valid for WAIT_NEXT_YEAR or RETURNING_CAMPER.',
      },
      { status: 400 }
    );
  }
  if (waitProvided) {
    const wy = Number(body.wait_until_year);
    if (!Number.isFinite(wy) || !Number.isInteger(wy)) {
      return NextResponse.json(
        { success: false, message: 'wait_until_year must be an integer.' },
        { status: 400 }
      );
    }
    const currentYear = new Date().getUTCFullYear();
    if (wy < currentYear) {
      return NextResponse.json(
        {
          success: false,
          message: `wait_until_year must be ${currentYear} or later (no past years).`,
        },
        { status: 400 }
      );
    }
    // Floor: a rep entering currentYear means "wait until this year", which is
    // a no-op. Bump it to currentYear + 1 so the clone-to-next-year offered on
    // the Closed Lost view targets a real future year.
    resolvedWaitUntilYear = wy === currentYear ? currentYear + 1 : wy;
  }

  // Spec §5.1, §6.1 — closed_lost_* aren't sacred but the pattern stays
  // uniform across mutating routes.
  try {
    await requireDealAuthorization(req, dealId, rawBody);
    await requireUnlocked(dealId, []);
  } catch (err) {
    if (err instanceof DealAuthorizationError) {
      return NextResponse.json(err.body, { status: err.statusCode });
    }
    if (err instanceof RequireUnlockedError) {
      return NextResponse.json(err.body, { status: err.statusCode });
    }
    throw err;
  }

  // Build property patch
  const properties: Record<string, string> = {
    closed_lost_category: category,
  };
  if (typeof body.closed_lost_reason === 'string') {
    properties.closed_lost_reason = body.closed_lost_reason;
  }
  if (resolvedWaitUntilYear !== undefined) {
    properties.wait_until_year = String(resolvedWaitUntilYear);
  }

  // Stage advance (§4.6) — only set if the caller asked AND the deal
  // isn't already at closedlost (avoids a no-op write that would still
  // bump hs_lastmodifieddate).
  let advancedToLost = false;
  if (body.setStageToLost === true) {
    try {
      const deal = await getDeal(dealId);
      if (deal && deal.dealstage !== CLOSED_LOST_STAGE) {
        properties.dealstage = CLOSED_LOST_STAGE;
        advancedToLost = true;
      }
    } catch (err: any) {
      // Soft-fail the read. The caller asked to advance; if we can't
      // read the current stage, the safer behavior is to write the
      // stage anyway (the worst case is a redundant write).
      console.warn(
        `[loss-reason] could not read deal ${dealId} to check current stage; setting closedlost anyway:`,
        err.message
      );
      properties.dealstage = CLOSED_LOST_STAGE;
      advancedToLost = true;
    }
  }

  try {
    await updateDeal(dealId, properties);
    return NextResponse.json({ success: true, advancedToLost });
  } catch (err: any) {
    console.error(
      `[loss-reason] error for deal ${dealId}:`,
      err.message,
      err.stack
    );
    await notifyPipelineFailure({
      action: 'loss-reason',
      dealId,
      error: err?.message ?? String(err),
      detail: `category=${category}, setStageToLost=${body.setStageToLost === true}`,
    });
    return NextResponse.json(
      { success: false, message: 'Failed to update deal.' },
      { status: 500 }
    );
  }
}
