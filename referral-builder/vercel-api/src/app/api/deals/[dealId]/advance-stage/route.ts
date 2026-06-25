/**
 * POST /api/deals/[dealId]/advance-stage
 *
 * Stage advance helper (UNIFIED_CARD_SPEC.md §4.1, §4.6) — used by:
 *   - "Add Referrals" on the New Lead view → advance to
 *     `presentationscheduled` (Recommendation Plan Presented)
 *   - "Mark as Lost" from any non-terminal stage → advance to `closedlost`
 *
 * Body:
 *   { toStage: 'presentationscheduled' | 'closedlost' }
 *
 * Future stages can be added to ALLOWED_STAGES; everything else is
 * rejected with 400. Stage transitions like Tuition Undecided → Closed
 * Won are owned by /select-session and don't go through this route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { updateDeal } from '@/lib/deals';
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

// Stages the card's StageNav can move a deal to via this route.
//   - appointmentscheduled   ← Step Back from Referrals to Setup
//   - presentationscheduled  → Forward from Setup to Referrals
//   - closedlost              Mark as Lost
// Forward Referrals → Session and Session → Won are intentionally NOT
// here: they go through `/select-session` and the Mark Selected saga
// which write program_id / programname / tuition_at_enrollment as part
// of the transition. Bypassing them would leave the deal in an
// inconsistent state.
const ALLOWED_STAGES = [
  'appointmentscheduled',
  'presentationscheduled',
  'closedlost',
] as const;
type AllowedStage = (typeof ALLOWED_STAGES)[number];

export async function POST(
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
  let body: { toStage?: string };
  try {
    body = parseRequestBody(rawBody) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid JSON in request body.' },
      { status: 400 }
    );
  }

  const toStage = body.toStage;
  if (!toStage || !ALLOWED_STAGES.includes(toStage as AllowedStage)) {
    return NextResponse.json(
      {
        success: false,
        message: `toStage must be one of: ${ALLOWED_STAGES.join(', ')}.`,
      },
      { status: 400 }
    );
  }

  // Spec §5.1, §6.1 — `dealstage` isn't sacred (only the seven
  // commission-relevant fields are), so requireUnlocked short-circuits.
  // Pattern stays uniform with the other mutating routes.
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

  try {
    await updateDeal(dealId, { dealstage: toStage });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error(
      `[advance-stage] error for deal ${dealId}:`,
      err.message,
      err.stack
    );
    await notifyPipelineFailure({
      action: 'advance-stage',
      dealId,
      error: err?.message ?? String(err),
      detail: `toStage=${toStage}`,
    });
    return NextResponse.json(
      { success: false, message: 'Failed to update deal.' },
      { status: 500 }
    );
  }
}
