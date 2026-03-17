/**
 * GET /api/deals/:dealId/referrals - List referrals for a deal
 *
 * Fetches all referrals associated with the specified deal,
 * including related company, program, and session details.
 */

import { NextRequest, NextResponse } from 'next/server';
import { fetchReferralsForDeal } from '@/lib/referrals';

type Params = { dealId: string };

export async function GET(
  req: NextRequest,
  { params }: { params: Params }
) {
  const { dealId } = params;

  if (!dealId || !/^\d+$/.test(dealId)) {
    return NextResponse.json(
      { error: 'Valid Deal ID is required' },
      { status: 400 }
    );
  }

  try {
    const validReferrals = await fetchReferralsForDeal(dealId);

    console.log(`[GET /api/deals/${dealId}/referrals] Found ${validReferrals.length} referrals`);
    return NextResponse.json({ results: validReferrals });
  } catch (error: any) {
    console.error('[GET /api/deals/*/referrals] Error:', error.message);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch referrals' },
      { status: 500 }
    );
  }
}
