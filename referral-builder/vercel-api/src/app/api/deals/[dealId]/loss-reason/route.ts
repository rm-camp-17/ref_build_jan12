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
 *     closed_lost_category: 'WAIT_NEXT_YEAR' | 'OTHER_PROGRAM'
 *                           | 'OUT_OF_MARKET' | 'MONEY'
 *                           | 'NON_RESPONSIVE' | 'OTHER',
 *     closed_lost_reason?: string,
 *     wait_until_year?: number,    // required iff category === 'WAIT_NEXT_YEAR'
 *     setStageToLost?: boolean     // when true, also patches dealstage = closedlost
 *   }
 *
 * Response:
 *   { success: true, advancedToLost: boolean }
 *
 * Validation:
 *   - category must be one of the six above
 *   - if category === 'WAIT_NEXT_YEAR':
 *       wait_until_year is required, must be a number, must be >= currentYear.
 *       If the rep enters currentYear (a no-op meaning "wait until this
 *       year"), we floor up to currentYear + 1.
 *   - if category !== 'WAIT_NEXT_YEAR' AND wait_until_year provided:
 *       reject (mismatch — the property only makes sense for WAIT_NEXT_YEAR).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDeal, updateDeal } from '@/lib/deals';
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
  'OTHER_PROGRAM',
  'OUT_OF_MARKET',
  'MONEY',
  'NON_RESPONSIVE',
  'OTHER',
] as const;

type LossCategory = (typeof VALID_LOSS_CATEGORIES)[number];

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
    body = rawBody ? JSON.parse(rawBody) : {};
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

  if (category === 'WAIT_NEXT_YEAR') {
    if (!waitProvided) {
      return NextResponse.json(
        {
          success: false,
          message: 'wait_until_year is required when closed_lost_category is WAIT_NEXT_YEAR.',
        },
        { status: 400 }
      );
    }
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
    // Floor: a rep entering currentYear means "wait until this year",
    // which is a no-op. Bump it to currentYear + 1 so the auto-clone job
    // has something to act on.
    resolvedWaitUntilYear = wy === currentYear ? currentYear + 1 : wy;
  } else if (waitProvided) {
    return NextResponse.json(
      {
        success: false,
        message: 'wait_until_year only valid for WAIT_NEXT_YEAR category.',
      },
      { status: 400 }
    );
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
    return NextResponse.json(
      { success: false, message: 'Failed to update deal.' },
      { status: 500 }
    );
  }
}
