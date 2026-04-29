/**
 * Deal helpers (HubSpot fetch + update + company association).
 *
 * The session-card API needs more deal properties than the referral
 * workflow does (session_*, lengthofstay, deal_currency_code, etc.), so
 * those reads/writes live here. Workflow.ts has its own narrower
 * fetchDealData; consolidating that into a single shared helper is a
 * Phase 4 cleanup.
 */

import { hubspotClient } from './hubspot';

// ============================================================================
// Property sets
// ============================================================================

const SESSION_CARD_PROPERTIES: ReadonlyArray<string> = [
  'dealname',
  'pipeline',
  'dealstage',
  'year1',
  'program_id',
  'programname',
  'associated_child_id',
  'deal_currency_code',
  'tuition_at_enrollment',
  'amount',
  'lengthofstay',
  'note_1',
  'commission_rate',
  'session_start_date',
  'session_end_date',
  'session_name',
  'session_id',
  'hubspot_owner_id',
  'deal_key',
];

// ============================================================================
// Types
// ============================================================================

export interface DealRecord {
  id: string;
  // Identity
  dealname: string | null;
  deal_key: string | null;
  associated_child_id: string | null;
  hubspot_owner_id: string | null;
  // Pipeline + stage
  pipeline: string | null;
  dealstage: string | null;
  // Camp / program
  program_id: string | null;
  programname: string | null;
  year1: string | null;
  // Tuition + session
  tuition_at_enrollment: string | null;
  amount: string | null;
  lengthofstay: string | null;
  deal_currency_code: string | null;
  session_id: string | null;
  session_name: string | null;
  session_start_date: string | null;
  session_end_date: string | null;
  // Misc
  note_1: string | null;
  commission_rate: string | null;
}

// ============================================================================
// Fetch
// ============================================================================

/**
 * Get a single deal by ID with the session-card property set.
 * Returns null if the deal doesn't exist (HubSpot returns 404).
 */
export async function getDeal(dealId: string): Promise<DealRecord | null> {
  try {
    const deal = await hubspotClient.crm.deals.basicApi.getById(
      dealId,
      [...SESSION_CARD_PROPERTIES]
    );
    const p = deal.properties as Record<string, string | null>;
    return {
      id: deal.id,
      dealname: p.dealname ?? null,
      deal_key: p.deal_key ?? null,
      associated_child_id: p.associated_child_id ?? null,
      hubspot_owner_id: p.hubspot_owner_id ?? null,
      pipeline: p.pipeline ?? null,
      dealstage: p.dealstage ?? null,
      program_id: p.program_id ?? null,
      programname: p.programname ?? null,
      year1: p.year1 ?? null,
      tuition_at_enrollment: p.tuition_at_enrollment ?? null,
      amount: p.amount ?? null,
      lengthofstay: p.lengthofstay ?? null,
      deal_currency_code: p.deal_currency_code ?? null,
      session_id: p.session_id ?? null,
      session_name: p.session_name ?? null,
      session_start_date: p.session_start_date ?? null,
      session_end_date: p.session_end_date ?? null,
      note_1: p.note_1 ?? null,
      commission_rate: p.commission_rate ?? null,
    };
  } catch (err: any) {
    if (err?.code === 404 || err?.statusCode === 404) {
      return null;
    }
    console.error(`[deals] Failed to fetch deal ${dealId}:`, err.message);
    throw err;
  }
}

// ============================================================================
// Update
// ============================================================================

/**
 * Patch deal properties. Caller is responsible for not writing `ce_*`
 * fields (Rule 1 — those belong to ce-billing's push sync). This helper
 * does NOT enforce that — too easy to miss in code review. The
 * `requireUnlocked` middleware planned in Phase 3f will validate.
 */
export async function updateDeal(
  dealId: string,
  properties: Record<string, string>
): Promise<void> {
  try {
    await hubspotClient.crm.deals.basicApi.update(dealId, { properties });
  } catch (err: any) {
    console.error(`[deals] Failed to update deal ${dealId}:`, err.message);
    throw err;
  }
}

// ============================================================================
// Association
// ============================================================================

/**
 * Associate a deal with a company using the default Deal ↔ Company
 * association. Idempotent — HubSpot ignores duplicate creates.
 *
 * Uses the v4 default association type (no label) which has
 * associationCategory `HUBSPOT_DEFINED`. The exact typeId for the default
 * Deal-to-Company is 5 in HubSpot's standard schema; passing
 * `HUBSPOT_DEFAULT` lets HubSpot pick.
 */
export async function associateDealToCompany(
  dealId: string,
  companyId: string
): Promise<void> {
  try {
    await hubspotClient.crm.associations.v4.basicApi.createDefault(
      'deals',
      dealId,
      'companies',
      companyId
    );
  } catch (err: any) {
    // Idempotent — duplicate associations return 200 in v4. Anything else
    // is unexpected.
    console.error(
      `[deals] Failed to associate deal ${dealId} to company ${companyId}:`,
      err.message
    );
    throw err;
  }
}
