/**
 * Clone-for-year orchestration (race-safe, idempotent).
 *
 * Implements UNIFIED_CARD_SPEC.md §5.2 — the corrected clone flow that
 * uses a Postgres advisory lock + clone_ledger table for dedup, NOT
 * HubSpot's eventually-consistent search alone.
 *
 * Key invariants:
 *   - Each (source_key, target_year) pair clones at most once. Concurrent
 *     requests serialize on the advisory lock; later arrivals see the
 *     ledger row and return the existing new_deal_id.
 *   - Rule 1: this code does NOT write `ce_*` fields. ce-billing's pull
 *     sync initializes them on first sight. Earlier draft of the spec
 *     pre-seeded them with empty strings — that's a Rule 1 violation.
 *   - Locked sources: if the source deal is `commission_locked=true`,
 *     the API returns 409 with `requiresConfirmation: true`. The
 *     frontend shows a "confirm expert assignment fields" prompt; on
 *     confirm, the rep re-POSTs with `confirmExpertFields: true`.
 */

import { hubspotClient } from './hubspot';
import { withTransaction } from './pg';
import {
  acquireCloneLock,
  findCloneLedger,
  insertCloneLedger,
  buildIdempotencyKey,
} from './clone-ledger';
import { getAssociatedIds } from './associations';
import { config } from './config';

// ============================================================================
// Types
// ============================================================================

export interface CloneInput {
  sourceDealId: string;
  targetYear: number;
  /**
   * If the source deal is commission_locked, the rep must confirm they
   * intend to propagate the (potentially-bad) expert assignment fields.
   * Initial request: omit; if `requiresConfirmation` comes back, re-POST
   * with this set to `true`.
   */
  confirmExpertFields?: boolean;
}

export interface CloneSuccess {
  success: true;
  newDealId: string;
  newDealName: string;
  /** True if (source, year) was already cloned — returned the existing clone. */
  deduped: boolean;
}

export interface CloneRequiresConfirmation {
  success: false;
  requiresConfirmation: true;
  message: string;
  lockedFields: string[];
}

export interface CloneError {
  success: false;
  message: string;
}

export type CloneResult = CloneSuccess | CloneRequiresConfirmation | CloneError;

// ============================================================================
// Property sets
// ============================================================================

/** Source-deal properties needed to build the clone. Wider than
 *  SESSION_CARD_PROPERTIES — includes billing-critical expert fields. */
const CLONE_SOURCE_PROPERTIES: ReadonlyArray<string> = [
  'dealname',
  'pipeline',
  'dealstage',
  'year1',
  'deal_key',
  'copied_from_deal_key',
  'program_id',
  'programname',
  'associated_child_id',
  'associated_household_id',
  'hubspot_owner_id',
  'deal_currency_code',
  // Billing-critical (Rule 2 fields — propagated to clone)
  'expertprofile',
  'referred_by',
  'split_type',
  'deal_split_email',
  'deal_split_pct',
  'commission_locked',
];

/** Sacred billing fields per UNIFIED_CARD_SPEC.md §1 Rule 2. If the
 *  source is locked, the rep must confirm before we propagate them. */
const SACRED_FIELDS: ReadonlyArray<string> = [
  'expertprofile',
  'referred_by',
  'split_type',
  'deal_split_email',
  'deal_split_pct',
];

// ============================================================================
// Helpers
// ============================================================================

interface SourceDeal {
  id: string;
  dealname: string;
  pipeline: string | null;
  dealstage: string | null;
  year1: string | null;
  deal_key: string | null;
  associated_child_id: string | null;
  associated_household_id: string | null;
  hubspot_owner_id: string | null;
  deal_currency_code: string | null;
  program_id: string | null;
  programname: string | null;
  expertprofile: string | null;
  referred_by: string | null;
  split_type: string | null;
  deal_split_email: string | null;
  deal_split_pct: string | null;
  commission_locked: string | null;
}

async function fetchSourceDeal(dealId: string): Promise<SourceDeal | null> {
  try {
    const deal = await hubspotClient.crm.deals.basicApi.getById(dealId, [
      ...CLONE_SOURCE_PROPERTIES,
    ]);
    const p = deal.properties as Record<string, string | null>;
    return {
      id: deal.id,
      dealname: p.dealname ?? '',
      pipeline: p.pipeline ?? null,
      dealstage: p.dealstage ?? null,
      year1: p.year1 ?? null,
      deal_key: p.deal_key ?? null,
      associated_child_id: p.associated_child_id ?? null,
      associated_household_id: p.associated_household_id ?? null,
      hubspot_owner_id: p.hubspot_owner_id ?? null,
      deal_currency_code: p.deal_currency_code ?? null,
      program_id: p.program_id ?? null,
      programname: p.programname ?? null,
      expertprofile: p.expertprofile ?? null,
      referred_by: p.referred_by ?? null,
      split_type: p.split_type ?? null,
      deal_split_email: p.deal_split_email ?? null,
      deal_split_pct: p.deal_split_pct ?? null,
      commission_locked: p.commission_locked ?? null,
    };
  } catch (err: any) {
    if (err?.code === 404 || err?.statusCode === 404) {
      return null;
    }
    console.error(`[clone] Failed to fetch source deal ${dealId}:`, err.message);
    throw err;
  }
}

/**
 * Belt-and-suspenders: search HubSpot for an existing clone whose
 * `copied_from_deal_key` matches `sourceKey` AND `year1` matches the
 * target. This catches deals created in past failed transactions
 * (HubSpot create succeeded but ledger insert/COMMIT didn't) so we
 * never double-create.
 *
 * NOTE: HubSpot Search has a 5-15s indexing lag. Don't trust this as
 * the primary dedup — it's a fallback for the recovery path.
 */
async function findExistingCloneInHubSpot(
  sourceKey: string,
  targetYear: number
): Promise<string | null> {
  try {
    const result = await hubspotClient.crm.deals.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'copied_from_deal_key',
              operator: 'EQ' as any,
              value: sourceKey,
            },
            {
              propertyName: 'year1',
              operator: 'EQ' as any,
              value: String(targetYear),
            },
          ],
        },
      ],
      properties: ['dealname'],
      sorts: [],
      limit: 1,
      after: '0',
    });
    return result.results[0]?.id ?? null;
  } catch (err: any) {
    console.warn(
      `[clone] HubSpot search fallback failed (continuing — ledger lock is the primary dedup):`,
      err.message
    );
    return null;
  }
}

function buildClonePayload(
  source: SourceDeal,
  targetYear: number
): Record<string, string> {
  // dealname: swap the year embedded in the source name
  const sourceYear = source.year1 ?? new Date().getFullYear().toString();
  const newDealName = source.dealname.replace(sourceYear, String(targetYear));
  const newDealKey = source.associated_child_id
    ? `${source.associated_child_id}|${targetYear}`
    : '';

  const props: Record<string, string> = {
    // Identity
    dealname: newDealName || `Cloned for ${targetYear}`,
    year1: String(targetYear),
    pipeline: 'default',
    // Spec open question #1: clones start at Tuition Undecided so the
    // rep just enters tuition (camp is pre-known from source).
    dealstage: config.stages.tuitionUndecided,
    deal_key: newDealKey,
    // Lineage — primary dedup key
    copied_from_deal_key: source.deal_key ?? '',
    // Camp / program — preserve from source
    program_id: source.program_id ?? '',
    programname: source.programname ?? '',
    // Owner + currency — preserve
    hubspot_owner_id: source.hubspot_owner_id ?? '',
    deal_currency_code: source.deal_currency_code ?? 'USD',
    // Billing-critical (Rule 2 fields) — propagate
    expertprofile: source.expertprofile ?? '',
    referred_by: source.referred_by ?? '',
    split_type: source.split_type ?? '',
    deal_split_email: source.deal_split_email ?? '',
    deal_split_pct: source.deal_split_pct ?? '',
    // Reset financial / session state
    tuition_at_enrollment: '',
    amount: '',
    lengthofstay: '',
    closedate: '',
    dateofsignup: '',
    session_start_date: '',
    session_end_date: '',
    session_name: '',
    session_id: '',
    note_1: '',
    // Mark as cloned (so ce-billing's pull-sync can see it's a clone)
    clone_handled_by_api: 'true',
  };

  // Rule 1: do NOT write ce_* fields or commission_locked. ce-billing's
  // pull-sync initializes those when it sees the new deal for the
  // first time.

  return props;
}

async function copyAssociationsBestEffort(
  sourceDealId: string,
  newDealId: string
): Promise<void> {
  // Each pair runs independently and swallows its own errors —
  // associations are nice-to-have, the deal already exists with the
  // correct foreign-key properties.
  const pairs: ReadonlyArray<[string, string]> = [
    [config.objectTypes.child, 'children'],
    [config.objectTypes.household, 'households'],
    ['companies', 'companies'],
    ['contacts', 'contacts'],
  ];

  for (const [objectType, label] of pairs) {
    try {
      const ids = await getAssociatedIds('deals', sourceDealId, objectType);
      for (const id of ids) {
        try {
          await hubspotClient.crm.associations.v4.basicApi.createDefault(
            'deals',
            newDealId,
            objectType,
            id
          );
        } catch (err: any) {
          console.warn(
            `[clone] Could not associate ${label} ${id} to new deal ${newDealId}:`,
            err.message
          );
        }
      }
    } catch (err: any) {
      console.warn(
        `[clone] Could not enumerate ${label} for source deal ${sourceDealId}:`,
        err.message
      );
    }
  }
}

// ============================================================================
// Orchestrator
// ============================================================================

export async function cloneForYear(input: CloneInput): Promise<CloneResult> {
  const { sourceDealId, targetYear, confirmExpertFields } = input;

  // Step 1: fetch source
  const source = await fetchSourceDeal(sourceDealId);
  if (!source) {
    return { success: false, message: 'Source deal not found.' };
  }
  if (!source.deal_key) {
    return {
      success: false,
      message:
        'Source deal has no deal_key set. Cannot dedup the clone — refusing.',
    };
  }

  // Step 1.5: locked-source pre-flight
  // If commission_locked is true, billing flagged something — making the
  // rep confirm before propagating expertprofile/referred_by/split_*
  // prevents silent reproduction of a known-bad state.
  if (source.commission_locked === 'true' && !confirmExpertFields) {
    return {
      success: false,
      requiresConfirmation: true,
      message:
        'Source deal is commission_locked. Confirm the expert assignment fields are correct before cloning — they will be copied to the new deal.',
      lockedFields: [...SACRED_FIELDS],
    };
  }

  const sourceKey = source.deal_key;
  const idempotencyKey = buildIdempotencyKey(sourceKey, targetYear);

  // Step 2: race-safe dedup + create inside one transaction
  return withTransaction(async (client): Promise<CloneResult> => {
    await acquireCloneLock(client, idempotencyKey);

    // 2a: ledger check (definitive)
    const existing = await findCloneLedger(client, sourceKey, targetYear);
    if (existing) {
      console.log(
        `[clone] Dedup hit (ledger): ${idempotencyKey} → ${existing.new_deal_id}`
      );
      return {
        success: true,
        deduped: true,
        newDealId: String(existing.new_deal_id),
        // We don't store dealname in the ledger; query a friendly default.
        newDealName: source.dealname.replace(
          source.year1 ?? '',
          String(targetYear)
        ),
      };
    }

    // 2b: HubSpot search (recovery path for failed past transactions)
    const orphaned = await findExistingCloneInHubSpot(sourceKey, targetYear);
    if (orphaned) {
      console.log(
        `[clone] Dedup hit (HubSpot recovery): ${idempotencyKey} → ${orphaned}`
      );
      await insertCloneLedger(client, sourceKey, targetYear, orphaned);
      return {
        success: true,
        deduped: true,
        newDealId: orphaned,
        newDealName: source.dealname.replace(
          source.year1 ?? '',
          String(targetYear)
        ),
      };
    }

    // Step 3: build payload + create in HubSpot
    const properties = buildClonePayload(source, targetYear);
    let newDeal: { id: string };
    try {
      newDeal = await hubspotClient.crm.deals.basicApi.create({
        properties,
        associations: [],
      });
    } catch (err: any) {
      console.error(`[clone] HubSpot deal create failed:`, err.message);
      throw err; // → ROLLBACK, lock released
    }

    // Step 4: ledger write (same transaction)
    await insertCloneLedger(client, sourceKey, targetYear, newDeal.id);

    console.log(
      `[clone] Created clone ${newDeal.id} from ${sourceDealId} for ${targetYear}`
    );

    // Step 5 (after COMMIT): copy associations best-effort
    // Doing this outside the txn means the deal is committed to the
    // ledger before we touch associations — if association copy fails,
    // the user retries (idempotent: ledger hit returns same deal).
    setTimeout(() => {
      void copyAssociationsBestEffort(sourceDealId, newDeal.id);
    }, 0);

    return {
      success: true,
      deduped: false,
      newDealId: newDeal.id,
      newDealName: properties.dealname,
    };
  });
}
