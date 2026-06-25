/**
 * POST /api/v2/deal/[dealId]/clone-for-year
 *
 * Clone a Won (or any) deal into a new deal for `targetYear`. Race-safe
 * via Postgres advisory lock + clone_ledger table — see UNIFIED_CARD_SPEC.md
 * §5.2.
 *
 * Body:
 *   {
 *     targetYear: number              (required, e.g. 2027)
 *     confirmExpertFields?: boolean   (only set on the retry after a
 *                                      requiresConfirmation response)
 *   }
 *
 * Response (success):
 *   {
 *     success: true
 *     newDealId: string
 *     newDealName: string
 *     deduped: boolean      // true → returned an existing clone, didn't create new
 *   }
 *
 * Response (locked source, needs confirmation):
 *   HTTP 409
 *   {
 *     success: false
 *     requiresConfirmation: true
 *     message: string
 *     lockedFields: string[]
 *   }
 *
 * Response (error):
 *   HTTP 4xx/5xx
 *   { success: false, message: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { cloneForYear } from '@/lib/clone';
import { parseRequestBody } from '@/lib/parse-request-body';
import { notifyPipelineFailure } from '@/lib/error-notifier';
import {
  requireDealAuthorization,
  DealAuthorizationError,
} from '@/lib/require-deal-authorization';

// The clone now awaits its association/referral/activity copy before
// responding (previously fire-and-forget in setTimeout, which Vercel froze).
// For a deal with many referrals that copy is a few dozen sequential HubSpot
// calls — give the function room beyond the short default.
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: { dealId: string } }
) {
  const { dealId } = params;

  const rawBody = await req.text();
  let body: { targetYear?: unknown; confirmExpertFields?: unknown };
  try {
    body = parseRequestBody(rawBody) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid JSON in request body.' },
      { status: 400 }
    );
  }

  // Authorization (spec §6.1). Note: we deliberately do NOT call
  // `requireUnlocked` here. clone-for-year has its own in-lib lock
  // pre-flight (§5.2 step 0) that returns `requiresConfirmation` so the
  // rep can acknowledge the locked source before proceeding. A blanket
  // 409 from the middleware would short-circuit that UX flow and ship
  // the wrong error shape to the card.
  try {
    await requireDealAuthorization(req, dealId, rawBody);
  } catch (err) {
    if (err instanceof DealAuthorizationError) {
      return NextResponse.json(err.body, { status: err.statusCode });
    }
    throw err;
  }

  const targetYear =
    typeof body?.targetYear === 'number'
      ? body.targetYear
      : parseInt(String(body?.targetYear ?? ''), 10);

  if (!Number.isFinite(targetYear) || targetYear < 2000 || targetYear > 2100) {
    return NextResponse.json(
      { success: false, message: 'A valid target year (2000-2100) is required.' },
      { status: 400 }
    );
  }

  try {
    const result = await cloneForYear({
      sourceDealId: dealId,
      targetYear,
      confirmExpertFields: body.confirmExpertFields === true,
    });

    if (result.success) {
      return NextResponse.json(result);
    }

    if ('requiresConfirmation' in result && result.requiresConfirmation) {
      // 409 Conflict — the rep needs to acknowledge the locked-source
      // warning before we'll proceed.
      return NextResponse.json(result, { status: 409 });
    }

    return NextResponse.json(result, { status: 400 });
  } catch (err: any) {
    console.error(
      `[v2/clone-for-year] error for deal ${dealId}:`,
      err.message,
      err.stack
    );
    await notifyPipelineFailure({
      action: 'clone-for-year',
      dealId,
      error: err?.message ?? String(err),
      detail: `targetYear=${targetYear}`,
    });
    return NextResponse.json(
      { success: false, message: 'Failed to clone deal. Please try again.' },
      { status: 500 }
    );
  }
}
