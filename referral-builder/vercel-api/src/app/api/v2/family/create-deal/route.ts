/**
 * POST /api/v2/family/create-deal
 *
 * One-click deal creation from the Family Deals card (Child / Household /
 * Parent records).
 *
 *   Body: {
 *     childId: string        // HubSpot child object id (required)
 *     year: number           // e.g. 2027 (required)
 *     expertProfile: string  // deal expertprofile enum value (required)
 *     householdId?: string   // resolved from the child when omitted
 *     ownerId?: string       // optional HubSpot owner
 *   }
 *
 * Creates the deal with the standard field set (dealname "{Child} | {Year}",
 * pipeline default, New Lead, year1, deal_key, FK properties, expertprofile)
 * and the required associations (child, household, parent contacts).
 *
 * 409 with { duplicate: true, existingDealName } when the child already has a
 * deal for that year.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createFamilyDeal } from '@/lib/family';
import { parseRequestBody } from '@/lib/parse-request-body';
import { notifyPipelineFailure } from '@/lib/error-notifier';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  let body: {
    childId?: unknown;
    year?: unknown;
    expertProfile?: unknown;
    householdId?: unknown;
    ownerId?: unknown;
  };
  try {
    body = parseRequestBody(rawBody) as typeof body;
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid JSON in request body.' },
      { status: 400 }
    );
  }

  const childId = typeof body.childId === 'string' ? body.childId.trim() : '';
  const year =
    typeof body.year === 'number' ? body.year : parseInt(String(body.year ?? ''), 10);
  const expertProfile =
    typeof body.expertProfile === 'string' ? body.expertProfile.trim() : '';

  if (!childId || !/^\d+$/.test(childId)) {
    return NextResponse.json(
      { success: false, message: 'childId (HubSpot child record id) is required.' },
      { status: 400 }
    );
  }
  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    return NextResponse.json(
      { success: false, message: 'A valid year (2000-2100) is required.' },
      { status: 400 }
    );
  }
  if (!expertProfile) {
    return NextResponse.json(
      { success: false, message: 'expertProfile is required.' },
      { status: 400 }
    );
  }

  try {
    const result = await createFamilyDeal({
      childId,
      year,
      expertProfile,
      householdId:
        typeof body.householdId === 'string' && body.householdId.trim()
          ? body.householdId.trim()
          : null,
      ownerId:
        typeof body.ownerId === 'string' && body.ownerId.trim()
          ? body.ownerId.trim()
          : null,
    });

    if (result.success) return NextResponse.json(result);
    if ('duplicate' in result && result.duplicate) {
      return NextResponse.json(result, { status: 409 });
    }
    return NextResponse.json(result, { status: 400 });
  } catch (err: any) {
    console.error('[v2/family/create-deal] error:', err?.message, err?.stack);
    await notifyPipelineFailure({
      action: 'family-create-deal',
      dealId: childId,
      error: err?.message ?? String(err),
      detail: `year=${year} expert=${expertProfile}`,
    }).catch(() => {});
    return NextResponse.json(
      { success: false, message: 'Failed to create the deal. Please try again.' },
      { status: 500 }
    );
  }
}
