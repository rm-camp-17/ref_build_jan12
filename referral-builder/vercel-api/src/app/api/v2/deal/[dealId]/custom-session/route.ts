/**
 * POST /api/v2/deal/[dealId]/custom-session
 *
 * Rep typed in a custom session ("Other, requires office approval"):
 * write the inputs but DO NOT advance the deal stage. The deal stays at
 * Tuition Undecided so an admin can review before billing.
 *
 * Body:
 *   {
 *     description?: string    (optional; defaults to "Custom session")
 *     tuition: number         (required, > 0)
 *     currency?: string       (optional; defaults to "USD")
 *     weeks: number           (required, > 0)
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { selectCustomSession } from '@/lib/deal-updater';
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
    body = rawBody ? JSON.parse(rawBody) : {};
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

  const tuition = parseFloat(String(body?.tuition));
  const weeks = parseFloat(String(body?.weeks));

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
    return NextResponse.json(
      {
        success: false,
        message: 'Failed to save custom session. Please try again.',
      },
      { status: 500 }
    );
  }
}
