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
import { config } from './config';
import {
  logSacredFieldChange,
  diffSacredFieldChanges,
  isSacredField,
} from './audit-log';
import { getOwnerByEmail } from './owners';

// ============================================================================
// Errors
// ============================================================================

/**
 * Thrown by `updateDeal` when `deal_split_email` is set to an email
 * that does not resolve to a HubSpot Owner. Spec §6.2 requires this
 * server-side check before any HubSpot write — a typo'd email would
 * otherwise route co-work commission to nobody.
 *
 * Routes should map this to HTTP 422 with the documented error shape:
 *   { success: false, message, field: "deal_split_email" }
 */
export class DealSplitEmailNotFoundError extends Error {
  readonly field = 'deal_split_email' as const;
  readonly code = 'DEAL_SPLIT_EMAIL_NOT_FOUND' as const;
  readonly httpStatus = 422 as const;
  readonly userMessage =
    'Co-work email does not match any HubSpot expert. Check the spelling.';
  constructor(public readonly email: string) {
    super(
      `deal_split_email "${email}" does not match any HubSpot owner. ` +
        `Spec §6.2: server-side validation rejects unknown experts before write.`
    );
    this.name = 'DealSplitEmailNotFoundError';
  }
}

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
  'associated_household_id',
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
  // Billing / commission (read-only from the card's perspective — Rule 1)
  'ce_commission_amount',
  'ce_amount_received',
  'ce_invoice_status',
  'commission_status',
  'commission_locked',
  // Win/loss reason capture (Phase 4 / Phase 5)
  'closed_won_category',
  'closed_won_reason',
  'closed_lost_category',
  'closed_lost_reason',
  'wait_until_year',
  // Enrollment-email fields (item 4)
  'send_enrollment_email',
  'enrollment_email_sent',
  'enrollment_email_sent_date',
  // Expert / split ("sacred") fields — read-only in the card, surfaced so
  // split-referral deals are visible to the expert (edits stay in HubSpot
  // native UI where validation + audit-log apply).
  'expertprofile',
  'referred_by',
  'split_type',
  'deal_split_email',
  'deal_split_pct',
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
  associated_household_id: string | null;
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
  // Billing / commission (Rule 1: card reads but never writes)
  ce_commission_amount: string | null;
  ce_amount_received: string | null;
  ce_invoice_status: string | null;
  commission_status: string | null;
  commission_locked: string | null;
  // Win/loss reason capture
  closed_won_category: string | null;
  closed_won_reason: string | null;
  closed_lost_category: string | null;
  closed_lost_reason: string | null;
  wait_until_year: string | null;
  // Enrollment-email fields (item 4)
  send_enrollment_email: string | null;
  enrollment_email_sent: string | null;
  enrollment_email_sent_date: string | null;
  // Expert / split ("sacred") fields — read-only from the card
  expertprofile: string | null;
  referred_by: string | null;
  split_type: string | null;
  deal_split_email: string | null;
  deal_split_pct: string | null;
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
      associated_household_id: p.associated_household_id ?? null,
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
      ce_commission_amount: p.ce_commission_amount ?? null,
      ce_amount_received: p.ce_amount_received ?? null,
      ce_invoice_status: p.ce_invoice_status ?? null,
      commission_status: p.commission_status ?? null,
      commission_locked: p.commission_locked ?? null,
      closed_won_category: p.closed_won_category ?? null,
      closed_won_reason: p.closed_won_reason ?? null,
      closed_lost_category: p.closed_lost_category ?? null,
      closed_lost_reason: p.closed_lost_reason ?? null,
      wait_until_year: p.wait_until_year ?? null,
      send_enrollment_email: p.send_enrollment_email ?? null,
      enrollment_email_sent: p.enrollment_email_sent ?? null,
      enrollment_email_sent_date: p.enrollment_email_sent_date ?? null,
      expertprofile: p.expertprofile ?? null,
      referred_by: p.referred_by ?? null,
      split_type: p.split_type ?? null,
      deal_split_email: p.deal_split_email ?? null,
      deal_split_pct: p.deal_split_pct ?? null,
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
 *
 * Sacred-field audit log (spec §5.1): if the patch touches any of the
 * five sacred fields, we read their before-values, write the patch,
 * then emit a deal-timeline note diffing before vs after. The audit
 * write is best-effort — failures are logged but do NOT roll back the
 * underlying property write.
 *
 * Server-side validation (spec §6.2): if the patch sets
 * `deal_split_email` to a non-empty value, we resolve the email to a
 * HubSpot Owner BEFORE the deal write. If no owner matches, throws
 * `DealSplitEmailNotFoundError` (HTTP 422) without any HubSpot write.
 */
export async function updateDeal(
  dealId: string,
  properties: Record<string, string>,
  options: { changedByUserId?: string } = {}
): Promise<void> {
  // Server-side validation (spec §6.2): if the patch sets
  // `deal_split_email` to a non-empty value, confirm it resolves to a
  // HubSpot Owner before doing anything else. Empty / unset values are
  // allowed (clearing the split is fine).
  const proposedSplitEmail = properties['deal_split_email'];
  if (proposedSplitEmail && proposedSplitEmail.trim() !== '') {
    const owner = await getOwnerByEmail(proposedSplitEmail);
    if (!owner) {
      throw new DealSplitEmailNotFoundError(proposedSplitEmail);
    }
  }

  // Capture before-values for any sacred fields in the patch.
  const sacredTouched = Object.keys(properties).filter(isSacredField);
  let before: Record<string, string | null> | null = null;
  if (sacredTouched.length > 0) {
    before = await fetchSacredFieldsForAudit(dealId, sacredTouched);
  }

  try {
    await hubspotClient.crm.deals.basicApi.update(dealId, { properties });
  } catch (err: any) {
    console.error(`[deals] Failed to update deal ${dealId}:`, err.message);
    throw err;
  }

  // Diff & audit. If the read-before failed, skip — we can't compute a
  // reliable diff and a half-empty audit note is worse than none.
  if (before) {
    const changes = diffSacredFieldChanges(before, properties);
    if (changes.length > 0) {
      await logSacredFieldChange(dealId, changes, {
        changedByUserId: options.changedByUserId,
      });
    }
  }
}

/**
 * Read just the sacred-field properties for audit-log diffing.
 * Returns null on error (caller falls back to skipping the audit note
 * rather than emitting a misleading one).
 */
async function fetchSacredFieldsForAudit(
  dealId: string,
  sacredFields: string[]
): Promise<Record<string, string | null> | null> {
  try {
    const deal = await hubspotClient.crm.deals.basicApi.getById(
      dealId,
      sacredFields
    );
    const out: Record<string, string | null> = {};
    for (const f of sacredFields) {
      out[f] = (deal.properties as any)[f] ?? null;
    }
    return out;
  } catch (err: any) {
    console.warn(
      `[deals] Could not read sacred fields for audit (deal ${dealId}):`,
      err.message
    );
    return null;
  }
}

// ============================================================================
// Deal name ⇄ attending-program suffix (item 2)
// ============================================================================
//
// When a deal reaches Closed Won (programSelected) with tuition entered, we
// append the attending program to the deal name, e.g.
//   "Jane Doe 2026"  →  "Jane Doe 2026 — Camp Adventure"
// and strip it again if the deal leaves that stage. The suffix is the deal's
// `programname`, so the strip is deterministic: we remove exactly
// " — {programname}". reconcileDealName() is idempotent — it always rebuilds
// from a clean base, so calling it repeatedly never double-appends.

const PROGRAM_NAME_SEP = ' — ';

/** Remove a known " — {programName}" suffix if the name ends with it. */
export function stripProgramFromDealName(
  dealName: string,
  programName: string
): string {
  const base = dealName || '';
  const program = (programName || '').trim();
  if (!program) return base;
  const suffix = `${PROGRAM_NAME_SEP}${program}`;
  return base.endsWith(suffix)
    ? base.slice(0, base.length - suffix.length).trimEnd()
    : base;
}

/**
 * Compute the deal name a deal *should* have for its stage.
 *   - shouldHaveProgram=true  → "{cleanBase} — {programName}"
 *   - shouldHaveProgram=false → "{cleanBase}"
 * Always strips our known suffix first, so it's safe to call on any name.
 * Returns the desired name (may equal the input — caller should skip the
 * write when unchanged).
 */
export function reconcileDealName(opts: {
  currentName: string | null;
  programName: string | null;
  shouldHaveProgram: boolean;
}): string {
  const current = opts.currentName ?? '';
  const program = (opts.programName ?? '').trim();
  const base = program ? stripProgramFromDealName(current, program) : current;
  if (opts.shouldHaveProgram && program) {
    return `${base}${PROGRAM_NAME_SEP}${program}`;
  }
  return base;
}

/** True when a deal should carry the program suffix: Closed Won + tuition set. */
export function dealShouldHaveProgramSuffix(deal: {
  dealstage: string | null;
  tuition_at_enrollment: string | null;
}): boolean {
  const tuition = (deal.tuition_at_enrollment ?? '').trim();
  return (
    deal.dealstage === config.stages.programSelected &&
    tuition !== '' &&
    tuition !== '0'
  );
}

/**
 * Best-effort: bring a deal's name in line with its stage (append the
 * attending program at Closed Won, strip it otherwise). Idempotent and
 * non-throwing — used both at explicit transitions and as a self-heal on
 * card load (catches native HubSpot stage drags the card never saw).
 * Returns the new name if a write happened, else null.
 */
export async function reconcileDealNameForStage(deal: {
  id: string;
  dealname: string | null;
  programname: string | null;
  dealstage: string | null;
  tuition_at_enrollment: string | null;
}): Promise<string | null> {
  const desired = reconcileDealName({
    currentName: deal.dealname,
    programName: deal.programname,
    shouldHaveProgram: dealShouldHaveProgramSuffix(deal),
  });
  if (!desired || desired === (deal.dealname ?? '')) return null;
  try {
    await updateDeal(deal.id, { dealname: desired });
    return desired;
  } catch (err: any) {
    console.warn(
      `[deals] deal-name reconcile failed for ${deal.id} (non-fatal):`,
      err.message
    );
    return null;
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
