/**
 * PATCH /api/referrals/:referralId - Update a referral
 *
 * Request body:
 * {
 *   properties: {
 *     referral_status?: string (internal value)
 *     client_interest?: string (internal value)
 *     referral_note_to_company?: string
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

  // Parse request body
  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON in request body' },
      { status: 400 }
    );
  }

  // Validate input
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

  // Execute update workflow
  const result = await updateReferralWorkflow(referralId, validation.data.properties);

  if (!result.success) {
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
