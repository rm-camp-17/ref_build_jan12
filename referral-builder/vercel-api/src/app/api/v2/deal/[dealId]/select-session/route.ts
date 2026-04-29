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

export async function POST(
  req: NextRequest,
  { params }: { params: { dealId: string } }
) {
  const { dealId } = params;

  let body: { sessionId?: string | number; programId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid JSON in request body.' },
      { status: 400 }
    );
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
