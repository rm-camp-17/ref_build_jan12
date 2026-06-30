/**
 * Shared types for the unified card's stage-aware views.
 *
 * The unified card fetches:
 *   - GET /api/v2/deal/:dealId/card-data (existing, returns the coarse
 *     `status` enum + sessions/referralContext payload)
 *   - GET /api/v2/deal/:dealId/details   (new in Phase 4, returns raw
 *     dealstage + ce_* + closed_* fields so the router can pick the
 *     right view and the WonView/LostView can render their read-side)
 *
 * Both responses are merged into the `DealContext` passed to each view.
 */

// ============================================================================
// /api/v2/deal/:dealId/card-data response
// ============================================================================

export interface PostgresSession {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  startDateRaw: string;
  endDateRaw: string;
  tuition: number;
  currency: string;
  weeks: number;
  programName: string;
  companyName: string;
}

export interface ReferralContext {
  campName: string | null;
  referralId: string;
}

export type CardData =
  | { status: "not-in-pipeline" }
  | {
      status: "confirmed";
      tuition: string | null;
      weeks: string | null;
      currency: string | null;
      sessionName: string | null;
      sessionStartDate: string | null;
      sessionEndDate: string | null;
      notes: string | null;
    }
  | { status: "inactive"; message: string }
  | { status: "error"; message: string }
  | {
      status: "eligible";
      sessions: PostgresSession[];
      programName: string;
      programId: string | null;
      year: number | null;
      referralContext: ReferralContext | null;
      // Set when sessions is empty (none on file for this camp/year) — the
      // picker shows manual tuition entry with this note instead of a list.
      sessionsNote?: string | null;
    };

// ============================================================================
// /api/v2/deal/:dealId/details response
// ============================================================================

export interface DealDetails {
  id: string;
  dealname: string | null;
  year1: string | null;
  dealstage: string | null;
  pipeline: string | null;
  associated_child_id: string | null;
  associated_household_id: string | null;
  hubspot_owner_id: string | null;
  tuition_at_enrollment: string | null;
  lengthofstay: string | null;
  deal_currency_code: string | null;
  session_id: string | null;
  session_name: string | null;
  session_start_date: string | null;
  session_end_date: string | null;
  ce_commission_amount: string | null;
  ce_amount_received: string | null;
  ce_invoice_status: string | null;
  commission_status: string | null;
  commission_locked: string | null;
  closed_won_category: string | null;
  closed_won_reason: string | null;
  closed_lost_category: string | null;
  closed_lost_reason: string | null;
  wait_until_year: string | null;
  note_1: string | null;
  // Enrollment-email fields (item 4)
  send_enrollment_email: string | null;
  enrollment_email_sent: string | null;
  enrollment_email_sent_date: string | null;
  parent_contact_count: number;
  associated_child_count: number;
  associated_household_count: number;
  associated_companies: Array<{
    id: string;
    name: string | null;
    // Camp's "Commission Structure - Summary" (company property
    // commission_structure___summary). May be absent on older payloads.
    commission_structure?: string | null;
  }>;
}

// ============================================================================
// Stage IDs (must match referral-builder/vercel-api/src/lib/config.ts)
// ============================================================================

export const STAGES = {
  newLead: "appointmentscheduled",
  introCallCompleted: "qualifiedtobuy",
  recommendationPresented: "presentationscheduled",
  tuitionUndecided: "1282923123",
  programSelected: "decisionmakerboughtin", // = Closed Won
  closedLost: "closedlost",
} as const;

export const ACTIVE_PIPELINE = "default";

// ============================================================================
// Common API base
// ============================================================================

export const API_BASE = "https://referral-builder1122026.vercel.app";

// ============================================================================
// Locked-fields helper
// ============================================================================

export function isCommissionLocked(details: DealDetails | null): boolean {
  if (!details) return false;
  // HubSpot booleans round-trip as "true"/"false" strings.
  return details.commission_locked === "true";
}
