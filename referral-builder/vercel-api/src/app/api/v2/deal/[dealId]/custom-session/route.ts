/**
 * POST /api/v2/deal/[dealId]/custom-session
 *
 * Rep typed in a custom "Other" session amount. Item 6: this now writes
 * the inputs AND advances the deal to "Program Selected" (Closed Won),
 * exactly like picking a listed session. Tuition is sanitized so values
 * like "$1,200" parse correctly instead of silently 400-ing.
 *
 * Body:
 *   {
 *     description?: string    (optional; defaults to "Custom session")
 *     tuition: number|string  (required, > 0; "$1,200" accepted)
 *     currency?: string       (optional; defaults to "USD")
 *     weeks: number|string    (required, > 0)
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { selectCustomSession } from '@/lib/deal-updater';
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

export async function POST(
  req: NextRequest,
  { params }: { params: { dealId: string } }
) {
  const { dealId } = params;

  const rawBody = await req.text();
  let body: {
    description?: string;
    tuition?: unknown;
    currency?: string;
    weeks?: unknown;
  };
  try {
    body = parseRequestBody(rawBody) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid JSON in request body.' },
      { status: 400 }
    );
  }

  // Authorization + commission_locked enforcement (spec §5.1, §6.1)
  try {
    await requireDealAuthorization(req, dealId, rawBody);
    // custom-session writes tuition_at_enrollment + lengthofstay (sacred)
    await requireUnlocked(dealId, ['tuition_at_enrollment', 'lengthofstay']);
  } catch (err) {
    if (err instanceof DealAuthorizationError) {
      return NextResponse.json(err.body, { status: err.statusCode });
    }
    if (err instanceof RequireUnlockedError) {
      return NextResponse.json(err.body, { status: err.statusCode });
    }
    throw err;
  }

  // Sanitize money/number input: strip currency symbols, thousands
  // separators and stray whitespace so "$1,200" / "1 200" parse correctly.
  const toNumber = (v: unknown) =>
    parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  const tuition = toNumber(body?.tuition);
  const weeks = toNumber(body?.weeks);

  if (!Number.isFinite(tuition) || tuition <= 0) {
    return NextResponse.json(
      { success: false, message: 'A valid tuition amount is required.' },
      { status: 400 }
    );
  }
  if (!Number.isFinite(weeks) || weeks <= 0) {
    return NextResponse.json(
      { success: false, message: 'A valid number of weeks is required.' },
      { status: 400 }
    );
  }

  try {
    const result = await selectCustomSession(dealId, {
      description: body.description || 'Custom session',
      tuition,
      currency: body.currency || 'USD',
      weeks,
    });
    return NextResponse.json(result);
  } catch (err: any) {
    console.error(
      `[v2/custom-session] error for deal ${dealId}:`,
      err.message,
      err.stack
    );
    await notifyPipelineFailure({
      action: 'custom-session',
      dealId,
      error: err?.message ?? String(err),
    });
    return NextResponse.json(
      {
        success: false,
        message: 'Failed to save custom session. Please try again.',
      },
      { status: 500 }
    );
  }
}
