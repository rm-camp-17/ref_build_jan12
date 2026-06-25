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
import {
  updateDeal,
  associateDealToCompany,
  getDeal,
  reconcileDealName,
} from './deals';

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

  // Item 2: advancing to Closed Won with tuition entered → append the
  // attending program to the deal name (idempotent).
  await appendProgramSuffix(dealId, properties);

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
 * Apply a custom (rep-typed) "Other" session to the deal. Tuition + weeks
 * are required; description is optional.
 *
 * Item 6: a custom amount now advances the deal to "Program Selected"
 * (Closed Won) exactly like picking a listed session — previously it wrote
 * the tuition but left the deal at Tuition Undecided, so the card reset to
 * the picker and the rep saw nothing happen.
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
    // Deal progression — advance to Closed Won just like a preset session.
    closedate: new Date().toISOString().split('T')[0],
    dealstage: config.stages.programSelected,
    note_1: `CUSTOM session: ${finalDescription}`,
  };

  // Item 2: append the attending program to the deal name (idempotent).
  await appendProgramSuffix(dealId, properties);

  await updateDeal(dealId, properties);

  return {
    success: true,
    message: `Custom session selected: ${finalDescription}. Tuition: ${currency || 'USD'} $${tuition}.`,
    properties,
  };
}

// ============================================================================
// Deal-name suffix helper (item 2)
// ============================================================================

/**
 * Mutates `properties` to include a `dealname` with the attending program
 * appended, when advancing a deal to Closed Won. Reads the deal's current
 * name + programname; no-ops (and never throws) if the program is unknown
 * or the name already carries the suffix.
 */
async function appendProgramSuffix(
  dealId: string,
  properties: Record<string, string>
): Promise<void> {
  try {
    const deal = await getDeal(dealId);
    if (!deal) return;
    const programName = deal.programname ?? '';
    if (!programName.trim()) return;
    const desired = reconcileDealName({
      currentName: deal.dealname,
      programName,
      shouldHaveProgram: true,
    });
    if (desired && desired !== (deal.dealname ?? '')) {
      properties.dealname = desired;
    }
  } catch (err: any) {
    console.warn(
      `[deal-updater] could not append program to deal name for ${dealId} (non-fatal):`,
      err.message
    );
  }
}
