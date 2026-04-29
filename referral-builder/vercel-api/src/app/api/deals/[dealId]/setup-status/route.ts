/**
 * GET /api/deals/[dealId]/setup-status
 *
 * Read-only New Lead setup checklist (UNIFIED_CARD_SPEC.md §4.1).
 * Returns the deal header (name/year/owner) and the three association
 * checks the rep needs to complete before "Add Referrals" lights up:
 *   - Child   (config.objectTypes.child   = 2-50911061)
 *   - Household (config.objectTypes.household = 2-53610744)
 *   - Contacts ('contacts')
 *
 * Response:
 *   {
 *     dealname, year1, hubspot_owner_id,
 *     child:     { associated, count, ids },
 *     household: { associated, count, ids },
 *     contacts:  { associated, count, ids },
 *     isReady    // true iff all three associated
 *   }
 *
 * No mutations — `requireUnlocked` is irrelevant for reads. We still call
 * `requireDealAuthorization` so strict mode rejects unauthenticated traffic
 * even on the read side once the toggle flips.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDeal } from '@/lib/deals';
import { getAssociatedIds } from '@/lib/associations';
import { config } from '@/lib/config';
import {
  requireDealAuthorization,
  DealAuthorizationError,
} from '@/lib/require-deal-authorization';

export async function GET(
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

  // Authorization (spec §6.1). GETs don't have a body to verify against,
  // so pass empty rawBody — the HMAC v3 string-to-sign is method+url+body+ts
  // and an empty body is still well-defined.
  try {
    await requireDealAuthorization(req, dealId, '');
  } catch (err) {
    if (err instanceof DealAuthorizationError) {
      return NextResponse.json(err.body, { status: err.statusCode });
    }
    throw err;
  }

  try {
    const [deal, childIds, householdIds, contactIds] = await Promise.all([
      getDeal(dealId),
      getAssociatedIds('deals', dealId, config.objectTypes.child),
      getAssociatedIds('deals', dealId, config.objectTypes.household),
      getAssociatedIds('deals', dealId, 'contacts'),
    ]);

    if (!deal) {
      return NextResponse.json(
        { success: false, message: 'Deal not found.' },
        { status: 404 }
      );
    }

    const child = {
      associated: childIds.length > 0,
      count: childIds.length,
      ids: childIds,
    };
    const household = {
      associated: householdIds.length > 0,
      count: householdIds.length,
      ids: householdIds,
    };
    const contacts = {
      associated: contactIds.length > 0,
      count: contactIds.length,
      ids: contactIds,
    };

    return NextResponse.json({
      dealname: deal.dealname,
      year1: deal.year1,
      hubspot_owner_id: deal.hubspot_owner_id,
      child,
      household,
      contacts,
      isReady: child.associated && household.associated && contacts.associated,
    });
  } catch (err: any) {
    console.error(
      `[setup-status] error for deal ${dealId}:`,
      err.message,
      err.stack
    );
    return NextResponse.json(
      { success: false, message: 'Failed to load setup status.' },
      { status: 500 }
    );
  }
}
