/**
 * POST /api/v2/deal/[dealId]/send-enrollment-email
 *
 * Item 4: queues the selected-program (enrollment) email to the camp by
 * checking the deal's `send_enrollment_email` box. An existing HubSpot-side
 * poller (~every 2 min) sends the email, stamps enrollment_email_sent +
 * _date, and unchecks the box. We don't send the email here — we only set
 * the trigger flag.
 *
 * Body: none required.
 * Response: { success: true } | { success: false, message }
 */

import { NextRequest, NextResponse } from 'next/server';
import { updateDeal } from '@/lib/deals';
import { config } from '@/lib/config';
import {
  requireUnlocked,
  RequireUnlockedError,
} from '@/lib/require-unlocked';
import {
  requireDealAuthorization,
  DealAuthorizationError,
} from '@/lib/require-deal-authorization';
import { notifyPipelineFailure } from '@/lib/error-notifier';

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

  // Read the (empty) body so the HMAC verifier sees the exact bytes.
  const rawBody = await req.text();

  try {
    await requireDealAuthorization(req, dealId, rawBody);
    // send_enrollment_email is not a sacred billing field.
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
    await updateDeal(dealId, {
      [config.properties.deal.sendEnrollmentEmail]: 'true',
    });
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error(
      `[v2/send-enrollment-email] error for deal ${dealId}:`,
      err.message,
      err.stack
    );
    await notifyPipelineFailure({
      action: 'send-enrollment-email',
      dealId,
      error: err?.message ?? String(err),
    });
    return NextResponse.json(
      { success: false, message: 'Failed to queue enrollment email.' },
      { status: 500 }
    );
  }
}
