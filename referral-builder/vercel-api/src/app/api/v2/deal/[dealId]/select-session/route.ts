/**
 * POST /api/v2/deal/[dealId]/select-session
 *
 * Apply a known Postgres session to the deal: writes tuition + session
 * pointer, advances dealstage to "Program Selected" (= Closed Won),
 * associates the deal to its company.
 *
 * Body:
 *   {
 *     sessionId: string | number   (required, Postgres session.id)
 *     programId?: string           (Company.programid for assoc lookup)
 *   }
 *
 * Response:
 *   { success: true, message, properties }   — written deal properties
 *   { success: false, message }              — validation/lookup error
 */

import { NextRequest, NextResponse } from 'next/server';
import { selectSession } from '@/lib/deal-updater';
import { parseRequestBody } from '@/lib/parse-request-body';
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

  // Read raw body once so we can both verify HubSpot's HMAC and parse it
  // as JSON. NextRequest doesn't let us re-read req.json() after we've
  // pulled the text out, so do this in one pass.
  const rawBody = await req.text();
  let body: { sessionId?: string | number; programId?: string };
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
    // select-session writes tuition_at_enrollment + lengthofstay (sacred)
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

  const sessionId = body?.sessionId;
  if (!sessionId) {
    return NextResponse.json(
      { success: false, message: 'No session selected.' },
      { status: 400 }
    );
  }

  try {
    const result = await selectSession(
      dealId,
      sessionId,
      body.programId ?? null
    );
    if (!result.success) {
      return NextResponse.json(result, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (err: any) {
    console.error(
      `[v2/select-session] error for deal ${dealId}:`,
      err.message,
      err.stack
    );
    return NextResponse.json(
      {
        success: false,
        message: 'Failed to update deal. Please try again.',
      },
      { status: 500 }
    );
  }
}
