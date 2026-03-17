/**
 * GET /api/deals/:dealId/household-referrals - List all referrals across a household
 *
 * Traverses Deal → Household → all Deals → all Referrals to surface
 * the full referral history for a family. Includes child matching
 * to distinguish same-child vs sibling referrals.
 */

import { NextRequest, NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { getAssociatedIds } from '@/lib/associations';
import { getObject } from '@/lib/objects';
import { fetchReferralsForDeal, ReferralData } from '@/lib/referrals';

type Params = { dealId: string };

interface HouseholdDealData {
  dealId: string;
  dealName: string;
  dealKey: string;
  dealYear: string;
  childId: string | null;
  isSameChild: boolean;
  referrals: ReferralData[];
}

interface HouseholdReferralsResponse {
  currentDealChildId: string | null;
  householdDeals: HouseholdDealData[];
}

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
    // Get current deal's Child ID and Household ID in parallel
    const [currentChildIds, householdIds] = await Promise.all([
      getAssociatedIds('deals', dealId, config.objectTypes.child),
      getAssociatedIds('deals', dealId, config.objectTypes.household),
    ]);

    const currentDealChildId = currentChildIds.length > 0 ? currentChildIds[0] : null;

    // If no household association, return empty
    if (householdIds.length === 0) {
      console.log(`[GET /api/deals/${dealId}/household-referrals] No household found`);
      return NextResponse.json({
        currentDealChildId,
        householdDeals: [],
      } satisfies HouseholdReferralsResponse);
    }

    const householdId = householdIds[0];

    // Get all deals in the household
    const allDealIds = await getAssociatedIds(
      config.objectTypes.household,
      householdId,
      'deals'
    );

    // Filter out the current deal
    const siblingDealIds = allDealIds.filter((id) => id !== dealId);

    if (siblingDealIds.length === 0) {
      console.log(`[GET /api/deals/${dealId}/household-referrals] No sibling deals`);
      return NextResponse.json({
        currentDealChildId,
        householdDeals: [],
      } satisfies HouseholdReferralsResponse);
    }

    // Fetch data for each sibling deal in parallel
    const householdDeals = await Promise.all(
      siblingDealIds.map(async (sibDealId): Promise<HouseholdDealData> => {
        const [dealObj, sibChildIds, referrals] = await Promise.all([
          getObject('deals', sibDealId, [
            config.properties.deal.name,
            config.properties.deal.key,
            config.properties.deal.year,
          ]),
          getAssociatedIds('deals', sibDealId, config.objectTypes.child),
          fetchReferralsForDeal(sibDealId),
        ]);

        const sibChildId = sibChildIds.length > 0 ? sibChildIds[0] : null;

        return {
          dealId: sibDealId,
          dealName: dealObj.properties[config.properties.deal.name] || '',
          dealKey: dealObj.properties[config.properties.deal.key] || '',
          dealYear: dealObj.properties[config.properties.deal.year] || '',
          childId: sibChildId,
          isSameChild: currentDealChildId !== null && sibChildId === currentDealChildId,
          referrals,
        };
      })
    );

    console.log(
      `[GET /api/deals/${dealId}/household-referrals] Found ${householdDeals.length} sibling deals, ` +
      `${householdDeals.reduce((sum, d) => sum + d.referrals.length, 0)} total referrals`
    );

    return NextResponse.json({
      currentDealChildId,
      householdDeals,
    } satisfies HouseholdReferralsResponse);
  } catch (error: any) {
    console.error('[GET /api/deals/*/household-referrals] Error:', error.message);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch household referrals' },
      { status: 500 }
    );
  }
}
