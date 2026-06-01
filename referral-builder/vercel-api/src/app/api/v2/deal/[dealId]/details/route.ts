/**
 * GET /api/v2/deal/[dealId]/details
 *
 * Lightweight read-only deal property dump used by the unified card to:
 *   1. Detect the deal's raw `dealstage` so the stage router can switch
 *      between SetupView / ReferralTableView / SessionPickerView / WonView /
 *      LostView even when /card-data only returns a coarse status (the
 *      existing card-data route lumps every non-Tuition-Undecided
 *      non-Won stage under `inactive`).
 *   2. Render the read-only `<BillingPanel />` (commission_status,
 *      ce_commission_amount, ce_amount_received, ce_invoice_status) on
 *      the Won view.
 *   3. Render the LostView in display mode (closed_lost_category,
 *      closed_lost_reason, wait_until_year) when the deal is already at
 *      closedlost.
 *   4. Drive the cross-stage <CommissionLockedBanner /> via the
 *      `commission_locked` flag.
 *
 * Wraps `getDeal()` from lib/deals.ts. Read-only — no writes here.
 *
 * Response on 200:
 *   {
 *     id, dealname, year1, dealstage, pipeline,
 *     associated_child_id, associated_household_id, hubspot_owner_id,
 *     tuition_at_enrollment, lengthofstay, deal_currency_code,
 *     session_id, session_name, session_start_date, session_end_date,
 *     ce_commission_amount, ce_amount_received, ce_invoice_status,
 *     commission_status, commission_locked,
 *     closed_won_category, closed_won_reason,
 *     closed_lost_category, closed_lost_reason, wait_until_year,
 *     note_1
 *   }
 *
 * 404 when the deal doesn't exist.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDeal } from '@/lib/deals';
import { getAssociatedIds } from '@/lib/associations';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';

export async function GET(
  _req: NextRequest,
  { params }: { params: { dealId: string } }
) {
  const { dealId } = params;

  if (!dealId) {
    return NextResponse.json(
      { error: 'No deal ID provided.' },
      { status: 400 }
    );
  }

  try {
    const deal = await getDeal(dealId);
    if (!deal) {
      return NextResponse.json(
        { error: 'Deal not found.' },
        { status: 404 }
      );
    }

    // Association lookups for SetupView checklist + ReferralTableView's
    // dealCompanies list. Done server-side because hubspot.fetch from the
    // iframe can't authenticate to HubSpot's own API — it stamps a JWT
    // meant for our backend, not for hubapi.com.
    const [contactIds, childIds, householdIds, companyIds] = await Promise.all([
      getAssociatedIds('deals', dealId, 'contacts'),
      getAssociatedIds('deals', dealId, config.objectTypes.child),
      getAssociatedIds('deals', dealId, config.objectTypes.household),
      getAssociatedIds('deals', dealId, 'companies'),
    ]);

    // Resolve company names so ReferralTableView can render them in the
    // "Existing Referrals" badge + auto-select if there's only one.
    let associated_companies: Array<{ id: string; name: string | null }> = [];
    if (companyIds.length > 0) {
      const companies = await Promise.all(
        companyIds.map(async (id) => {
          try {
            const c = await hubspotClient.crm.companies.basicApi.getById(id, ['name']);
            return { id, name: c.properties?.name ?? null };
          } catch {
            return { id, name: null };
          }
        })
      );
      associated_companies = companies;
    }

    return NextResponse.json({
      parent_contact_count: contactIds.length,
      associated_child_count: childIds.length,
      associated_household_count: householdIds.length,
      associated_companies,
      id: deal.id,
      dealname: deal.dealname,
      year1: deal.year1,
      dealstage: deal.dealstage,
      pipeline: deal.pipeline,
      associated_child_id: deal.associated_child_id,
      associated_household_id: deal.associated_household_id,
      hubspot_owner_id: deal.hubspot_owner_id,
      tuition_at_enrollment: deal.tuition_at_enrollment,
      lengthofstay: deal.lengthofstay,
      deal_currency_code: deal.deal_currency_code,
      session_id: deal.session_id,
      session_name: deal.session_name,
      session_start_date: deal.session_start_date,
      session_end_date: deal.session_end_date,
      ce_commission_amount: deal.ce_commission_amount,
      ce_amount_received: deal.ce_amount_received,
      ce_invoice_status: deal.ce_invoice_status,
      commission_status: deal.commission_status,
      commission_locked: deal.commission_locked,
      closed_won_category: deal.closed_won_category,
      closed_won_reason: deal.closed_won_reason,
      closed_lost_category: deal.closed_lost_category,
      closed_lost_reason: deal.closed_lost_reason,
      wait_until_year: deal.wait_until_year,
      note_1: deal.note_1,
    });
  } catch (err: any) {
    console.error(
      `[v2/details] error for deal ${dealId}:`,
      err.message,
      err.stack
    );
    return NextResponse.json(
      { error: 'Failed to load deal details.' },
      { status: 500 }
    );
  }
}
