/**
 * Handler B — Renewal auto-creator.
 *
 * Spec: when a Deal moves into Program Selected (= Won, in the active
 * pipeline), check whether the camp's commission_logic_type is in the
 * renewal-eligible set. If so, create a next-year deal at New Lead with
 * the same Child / Household / Contacts / Company associations.
 *
 * Distinct from `cloneForYear` (lib/clone.ts):
 *   - cloneForYear lands at Tuition Undecided because it resurrects a
 *     family that already chose a camp ("wait until next year"). The
 *     family is warm; only tuition remains.
 *   - This spawns a SPECULATIVE next-year deal. The family hasn't been
 *     contacted about next year. New Lead is honest about that state and
 *     keeps the deal out of stage-based revenue forecasts until a rep
 *     actually engages.
 *
 * Idempotent: before creating, we search for an existing deal at
 * deal_key = `${childId}|${targetYear}` in the active pipeline. If found,
 * we return that deal's id and skip the create. This protects against
 * webhook retries, manual pre-creates by reps, and the Won → Lost → Won
 * stage-rollback edge case.
 *
 * Loop protection: the spawned deal lands at New Lead, which is NOT in
 * RENEWAL_ELIGIBLE_LOGIC_TYPES' trigger set (we only fire on Program
 * Selected). The new-deal creation event will fan out to Handler A
 * (Child.Year mirror), but that handler excludes New Lead from the active
 * stage set, so the mirror is a no-op. Net: one webhook event in,
 * one new deal out, no further work.
 */

import { hubspotClient } from './hubspot';
import {
  config,
  RENEWAL_ELIGIBLE_LOGIC_TYPES,
} from './config';
import { getAssociatedIds } from './associations';

// ============================================================================
// Types
// ============================================================================

export type SpawnReason =
  | 'wrong-stage'
  | 'wrong-pipeline'
  | 'no-source-year'
  | 'no-child'
  | 'no-company'
  | 'company-not-eligible'
  | 'already-exists'
  | 'created';

export interface SpawnResult {
  reason: SpawnReason;
  /** Trigger deal — for log correlation. */
  sourceDealId: string;
  /** Resolved next year (year1 + 1). null when we couldn't parse. */
  targetYear: number | null;
  /** New deal id when we created one or found a pre-existing match. */
  newDealId: string | null;
  /** Logic type read off the company; null when we couldn't read. */
  commissionLogicType: string | null;
}

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
}

const SOURCE_PROPERTIES: ReadonlyArray<string> = [
  'dealname',
  'pipeline',
  'dealstage',
  'year1',
  'deal_key',
  'associated_child_id',
  'associated_household_id',
  'hubspot_owner_id',
  'deal_currency_code',
];

// ============================================================================
// Public API
// ============================================================================

export async function spawnRenewalForDeal(
  sourceDealId: string
): Promise<SpawnResult> {
  // 1. Fetch source.
  const source = await fetchSource(sourceDealId);
  if (!source) {
    return result(sourceDealId, 'no-source-year', null, null, null);
  }

  // 2. Pipeline + stage gate.
  if (source.pipeline !== config.pipeline.active) {
    return result(sourceDealId, 'wrong-pipeline', null, null, null);
  }
  if (source.dealstage !== config.stages.programSelected) {
    return result(sourceDealId, 'wrong-stage', null, null, null);
  }

  // 3. Year math.
  const sourceYear = parseYear(source.year1);
  if (sourceYear === null) {
    return result(sourceDealId, 'no-source-year', null, null, null);
  }
  const targetYear = sourceYear + 1;

  // 4. Need a child (associations + dedup key both depend on it).
  if (!source.associated_child_id) {
    return result(sourceDealId, 'no-child', targetYear, null, null);
  }

  // 5. Find the camp + read its commission_logic_type.
  const companyIds = await getAssociatedIds(
    'deals',
    sourceDealId,
    'companies'
  );
  if (companyIds.length === 0) {
    return result(sourceDealId, 'no-company', targetYear, null, null);
  }
  const logicType = await readCompanyLogicType(companyIds[0]);
  if (!logicType || !RENEWAL_ELIGIBLE_LOGIC_TYPES.has(logicType)) {
    return result(
      sourceDealId,
      'company-not-eligible',
      targetYear,
      null,
      logicType
    );
  }

  // 6. Idempotency — has a deal already been created for this child + year?
  const existingId = await findExistingDeal(
    source.associated_child_id,
    targetYear
  );
  if (existingId) {
    return result(
      sourceDealId,
      'already-exists',
      targetYear,
      existingId,
      logicType
    );
  }

  // 7. Create the new deal.
  const props = buildPayload(source, targetYear);
  const created = await hubspotClient.crm.deals.basicApi.create({
    properties: props,
    associations: [],
  });
  const newDealId = created.id;

  // 8. Copy associations best-effort. The deal is already valid without
  //    these (the property-level lineage is enough for ce-billing) but
  //    UI surfaces in HubSpot rely on the associations.
  await copyAssociations(sourceDealId, newDealId);

  return result(sourceDealId, 'created', targetYear, newDealId, logicType);
}

// ============================================================================
// Internals
// ============================================================================

async function fetchSource(dealId: string): Promise<SourceDeal | null> {
  try {
    const deal = await hubspotClient.crm.deals.basicApi.getById(
      dealId,
      [...SOURCE_PROPERTIES]
    );
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
    };
  } catch (err: any) {
    if (err?.code === 404 || err?.statusCode === 404) return null;
    throw err;
  }
}

async function readCompanyLogicType(
  companyId: string
): Promise<string | null> {
  try {
    const company = await hubspotClient.crm.companies.basicApi.getById(
      companyId,
      [config.properties.company.commissionLogicType]
    );
    const raw = (company.properties as Record<string, string | null>)[
      config.properties.company.commissionLogicType
    ];
    return raw && raw.trim() !== '' ? raw.trim() : null;
  } catch {
    return null;
  }
}

async function findExistingDeal(
  childId: string,
  targetYear: number
): Promise<string | null> {
  const dealKey = `${childId}|${targetYear}`;
  try {
    const result = await hubspotClient.crm.deals.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            { propertyName: 'deal_key', operator: 'EQ' as any, value: dealKey },
            {
              propertyName: 'pipeline',
              operator: 'EQ' as any,
              value: config.pipeline.active,
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
    // Search has eventual-consistency lag (~5-15s). On error we let the
    // create proceed; the worst case is one duplicate that an admin can
    // clean up, vs. failing closed and missing legitimate spawns.
    console.warn(
      `[renewal-spawner] dedup search failed for ${dealKey} (proceeding):`,
      err.message
    );
    return null;
  }
}

function buildPayload(
  source: SourceDeal,
  targetYear: number
): Record<string, string> {
  // Re-derive the dealname by replacing the year token. Matches the
  // convention used by clone.ts so renewals look uniform with manual
  // clones and auto-clones.
  const sourceYearStr = source.year1 ?? '';
  const newDealName =
    sourceYearStr && source.dealname.includes(sourceYearStr)
      ? source.dealname.replace(sourceYearStr, String(targetYear))
      : source.dealname || `Renewal for ${targetYear}`;

  const newDealKey = source.associated_child_id
    ? `${source.associated_child_id}|${targetYear}`
    : '';

  return {
    dealname: newDealName,
    year1: String(targetYear),
    pipeline: config.pipeline.active,
    // Renewal spawns land at New Lead — the family hasn't engaged about
    // next year yet. Distinct from clone.ts which lands at Tuition
    // Undecided for warm "wait next year" deferrals.
    dealstage: config.stages.newLead,
    deal_key: newDealKey,
    copied_from_deal_key: source.deal_key ?? '',
    hubspot_owner_id: source.hubspot_owner_id ?? '',
    deal_currency_code: source.deal_currency_code ?? 'USD',
    associated_child_id: source.associated_child_id ?? '',
    associated_household_id: source.associated_household_id ?? '',
    // Mark so ce-billing's pull-sync can distinguish renewal spawns from
    // organic deals. Same property the clone path uses.
    clone_handled_by_api: 'true',
  };
}

async function copyAssociations(
  sourceDealId: string,
  newDealId: string
): Promise<void> {
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
            `[renewal-spawner] could not associate ${label} ${id} → deal ${newDealId}:`,
            err.message
          );
        }
      }
    } catch (err: any) {
      console.warn(
        `[renewal-spawner] could not list ${label} associations for source ${sourceDealId}:`,
        err.message
      );
    }
  }
}

function parseYear(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 1900 && n < 2100 ? n : null;
}

function result(
  sourceDealId: string,
  reason: SpawnReason,
  targetYear: number | null,
  newDealId: string | null,
  logicType: string | null
): SpawnResult {
  return {
    sourceDealId,
    reason,
    targetYear,
    newDealId,
    commissionLogicType: logicType,
  };
}
