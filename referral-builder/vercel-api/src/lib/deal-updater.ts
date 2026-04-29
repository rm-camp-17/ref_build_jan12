/**
 * Deal-updater services for session selection.
 *
 * Two flows:
 *   - selectSession: pick a known Postgres session, write everything onto
 *     the deal, advance to "Program Selected" (decisionmakerboughtin).
 *   - selectCustomSession: rep typed in a custom session ("Other,
 *     requires office approval") — write the inputs but DO NOT advance
 *     stage; deal stays at Tuition Undecided pending approval.
 *
 * Both flows update the deal AND associate the deal to its company (idempotent).
 */

import { config } from './config';
import { getSessionById } from './sessions';
import { getCompanyByProgramId } from './companies';
import { updateDeal, associateDealToCompany } from './deals';

// ============================================================================
// Types
// ============================================================================

export interface SelectSessionResult {
  success: boolean;
  message: string;
  properties: Record<string, string>;
}

export interface CustomSessionInput {
  description: string;
  tuition: number;
  currency: string;
  weeks: number;
}

// ============================================================================
// Select existing session
// ============================================================================

/**
 * Apply a Postgres session to the deal. Writes:
 *   - Tuition fields: tuition_at_enrollment, amount, lengthofstay, deal_currency_code
 *   - Session pointer: session_id, session_name, session_start_date, session_end_date
 *   - Stage advance: dealstage = programSelected (= Closed Won)
 *   - Bookkeeping: closedate = today, note_1 = human-readable summary
 *
 * Best-effort associates the deal to its company (looked up by programId).
 */
export async function selectSession(
  dealId: string,
  sessionId: string | number,
  programId: string | null
): Promise<SelectSessionResult> {
  const session = await getSessionById(sessionId);
  if (!session) {
    return {
      success: false,
      message: 'Session not found.',
      properties: {},
    };
  }

  // Best-effort: look up company for the deal-association write.
  // If programId is missing or company not found, skip — the session
  // write itself still succeeds.
  let companyHsObjectId: string | null = null;
  if (programId) {
    try {
      const company = await getCompanyByProgramId(programId);
      companyHsObjectId = company?.hsObjectId ?? null;
    } catch (err: any) {
      console.warn(
        `[deal-updater] Company lookup failed for programId ${programId}:`,
        err.message
      );
    }
  }

  const note = `Session: ${session.name || `${session.startDate}-${session.endDate}`} (${session.weeks} weeks)`;

  const properties: Record<string, string> = {
    // Session financials
    tuition_at_enrollment: String(session.tuition),
    amount: String(session.tuition),
    lengthofstay: String(session.weeks),
    deal_currency_code: session.currency || 'USD',
    // Structured session data
    session_start_date: session.startDateRaw,
    session_end_date: session.endDateRaw,
    session_name: session.name || '',
    session_id: String(session.id),
    // Deal progression
    closedate: new Date().toISOString().split('T')[0],
    dealstage: config.stages.programSelected,
    // Human-readable note
    note_1: note,
  };

  await updateDeal(dealId, properties);

  // Associate deal to company — best-effort, don't fail the whole op
  if (companyHsObjectId) {
    try {
      await associateDealToCompany(dealId, companyHsObjectId);
    } catch (err: any) {
      console.warn(
        `[deal-updater] deal→company association failed (non-fatal): ${err.message}`
      );
    }
  }

  return {
    success: true,
    message: `Session selected: ${note}. Tuition: ${session.currency} $${session.tuition}.`,
    properties,
  };
}

// ============================================================================
// Custom session (Other / requires approval)
// ============================================================================

/**
 * Apply a custom (rep-typed) session to the deal. Tuition + weeks are
 * required; description is optional. Does NOT advance the stage — the
 * deal stays at Tuition Undecided so an admin can review before the
 * camp gets billed.
 */
export async function selectCustomSession(
  dealId: string,
  input: CustomSessionInput
): Promise<SelectSessionResult> {
  const { description, tuition, currency, weeks } = input;
  const finalDescription = description || 'Custom session';

  const properties: Record<string, string> = {
    tuition_at_enrollment: String(tuition),
    amount: String(tuition),
    lengthofstay: String(weeks),
    deal_currency_code: currency || 'USD',
    // Intentionally NOT set: session_start_date, session_end_date, session_id
    // (unknown for custom sessions)
    session_name: finalDescription,
    note_1: `CUSTOM (pending approval): ${finalDescription}`,
    // No dealstage write — stays at Tuition Undecided
  };

  await updateDeal(dealId, properties);

  return {
    success: true,
    message: `Custom session saved (pending office approval): ${finalDescription}`,
    properties,
  };
}
