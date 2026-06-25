/**
 * PATCH /api/referrals/:referralId - Update a referral
 *
 * Request body:
 * {
 *   properties: {
 *     referral_status?: string (internal value)
 *     client_interest?: string (internal value)
 *     referral_note_to_company?: string
 *   },
 *   context?: {
 *     dealId?: string       - Required for selection/de-selection transitions
 *     companyId?: string    - Required for selection transitions
 *     previousClientInterest?: string - Required to detect selection transitions
 *   }
 * }
 *
 * Response:
 * { ok: true } on success
 * { ok: false, error: string, errors?: string[] } on failure
 */

import { NextRequest, NextResponse } from 'next/server';
import { updateReferralWorkflow } from '@/lib/workflow';
import { validateUpdateReferralInput } from '@/lib/validation';
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

type Params = { referralId: string };

export async function PATCH(
  req: NextRequest,
  { params }: { params: Params }
) {
  const { referralId } = params;

  // Validate referral ID
  if (!referralId || !/^\d+$/.test(referralId)) {
    return NextResponse.json(
      { ok: false, error: 'Invalid referral ID' },
      { status: 400 }
    );
  }

  // Read raw body once for HMAC verification + JSON parsing.
  let rawBody = '';
  let body: any;
  try {
    rawBody = await req.text();
    body = parseRequestBody(rawBody);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON in request body' },
      { status: 400 }
    );
  }

  // Authorization + commission_locked enforcement (spec §5.1, §6.1).
  //
  // PATCH /api/referrals/:id is a referral mutation, not a deal mutation
  // — none of the deal's sacred fields are touched directly. We still
  // run the auth check (using context.dealId when present, or the
  // referralId as a fallback log key) and pass [] to requireUnlocked
  // so it short-circuits without a network call.
  //
  // NOTE: the Selected-transition saga (workflow.ts) writes deal-side
  // properties indirectly. None of those (program_id, programname,
  // dealstage) are sacred per Rule 2, so this remains correct. If that
  // ever changes, switch to passing the touched deal field names here.
  const dealIdForAuth =
    (body?.context && typeof body.context.dealId === 'string'
      ? body.context.dealId
      : '') || referralId;
  try {
    await requireDealAuthorization(req, dealIdForAuth, rawBody);
    await requireUnlocked(dealIdForAuth, []);
  } catch (err) {
    if (err instanceof DealAuthorizationError) {
      return NextResponse.json(err.body, { status: err.statusCode });
    }
    if (err instanceof RequireUnlockedError) {
      return NextResponse.json(err.body, { status: err.statusCode });
    }
    throw err;
  }

  // Validate input (validates properties, not context)
  const validation = validateUpdateReferralInput(body);
  if (!validation.valid || !validation.data) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Validation failed',
        errors: validation.errors,
      },
      { status: 400 }
    );
  }

  // Extract context for selection/de-selection handling
  const context = body?.context ? {
    dealId: typeof body.context.dealId === 'string' ? body.context.dealId : undefined,
    companyId: typeof body.context.companyId === 'string' ? body.context.companyId : undefined,
    previousClientInterest: typeof body.context.previousClientInterest === 'string' ? body.context.previousClientInterest : undefined,
  } : undefined;

  // Execute update workflow with context
  const result = await updateReferralWorkflow(referralId, validation.data.properties, context);

  if (!result.success) {
    await notifyPipelineFailure({
      action: 'update-referral',
      referralId,
      dealId: context?.dealId,
      error: result.errors?.[0] || 'Failed to update referral',
    });
    return NextResponse.json(
      {
        ok: false,
        error: result.errors?.[0] || 'Failed to update referral',
        errors: result.errors,
      },
      { status: 500 }
    );
  }

  console.log(`[PATCH /api/referrals/${referralId}] Updated:`, Object.keys(validation.data.properties));
  return NextResponse.json({ ok: true });
}
