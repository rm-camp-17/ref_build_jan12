/**
 * Handler A — Child.Year mirror.
 *
 * Spec: Child.Year = max(Deal.Year) across all deals associated with the
 * child, filtered to stages in {Intro Call Completed, Recommendation Plan
 * Presented, Program Selected – Tuition Undecided, Program Selected} on
 * the active Deal Pipeline. New Lead and Closed Lost are excluded.
 *
 * Sticky semantics: if no deal qualifies (e.g. all deals lost, or only New
 * Lead renewals exist), Child.Year is left untouched. We never write a
 * blank or zero — the field keeps its prior value.
 *
 * Idempotent: we read the current Child.Year before writing and skip the
 * PATCH when the computed max matches. This avoids needless HubSpot API
 * calls and removes any chance of webhook loops (Child writes are not
 * subscribed to anyway, but the no-op write skip is still cheap insurance).
 *
 * Trigger: webhook receiver should call this after any deal property
 * change involving { dealstage, year1, associated_child_id } and on deal
 * creation. Pass the dealId; this function takes care of resolving the
 * child and recomputing.
 */

import { hubspotClient } from './hubspot';
import { config, ACTIVE_DEAL_STAGES } from './config';
import { getAssociatedIds } from './associations';

export interface MirrorResult {
  /** The childId we resolved from the deal, or null if the deal had none. */
  childId: string | null;
  /** Year we computed (null if the active set was empty — sticky path). */
  computedYear: number | null;
  /** What Child.Year was before this run (null if the child had no value). */
  previousYear: number | null;
  /** True iff we actually issued a PATCH against HubSpot. */
  wrote: boolean;
  /** Free-form reason used by the webhook log. */
  reason:
    | 'no-child'
    | 'no-active-deals'
    | 'unchanged'
    | 'updated'
    | 'invalid-deal-year';
}

interface DealStageYear {
  id: string;
  pipeline: string | null;
  dealstage: string | null;
  year1: string | null;
}

/**
 * Resolve the child for a deal, recompute the mirror, write if changed.
 * Returns a MirrorResult describing what happened. Throws only on
 * unexpected HubSpot errors — caller (the webhook route) should swallow.
 */
export async function mirrorChildYearForDeal(
  dealId: string
): Promise<MirrorResult> {
  // 1. Fetch the trigger deal just to get its associated_child_id. We use
  //    the property here rather than the association because that's what
  //    the legacy code (clone.ts) does, and it's already populated by an
  //    existing HubSpot workflow on every deal that matters. If the
  //    property is empty AND the association exists, we still pick the
  //    child up via the association list below.
  let childId: string | null = null;
  try {
    const deal = await hubspotClient.crm.deals.basicApi.getById(dealId, [
      'associated_child_id',
    ]);
    const v = (deal.properties as Record<string, string | null>)
      .associated_child_id;
    if (v && v.trim() !== '') childId = v.trim();
  } catch (err: any) {
    if (err?.code === 404 || err?.statusCode === 404) {
      return {
        childId: null,
        computedYear: null,
        previousYear: null,
        wrote: false,
        reason: 'no-child',
      };
    }
    throw err;
  }

  // Fall back to the actual association if the property was unset.
  if (!childId) {
    const ids = await getAssociatedIds(
      'deals',
      dealId,
      config.objectTypes.child
    );
    if (ids.length === 0) {
      return {
        childId: null,
        computedYear: null,
        previousYear: null,
        wrote: false,
        reason: 'no-child',
      };
    }
    // A deal has at most one child in our model. If somehow there's more
    // than one, picking the first is consistent with what the rest of the
    // codebase does.
    childId = ids[0];
  }

  // 2. Find every deal associated with this child.
  const dealIds = await getAssociatedIds(
    config.objectTypes.child,
    childId,
    'deals'
  );

  // 3. Fetch stage + pipeline + year1 in a single batch read.
  const deals = await readDealsBatch(dealIds);

  // 4. Filter to active pipeline + active-stage deals, compute max year.
  let maxYear: number | null = null;
  for (const d of deals) {
    if (d.pipeline !== config.pipeline.active) continue;
    if (!d.dealstage || !ACTIVE_DEAL_STAGES.has(d.dealstage)) continue;
    if (!d.year1) continue;
    const parsed = Number.parseInt(d.year1, 10);
    if (!Number.isFinite(parsed)) continue;
    if (maxYear === null || parsed > maxYear) maxYear = parsed;
  }

  if (maxYear === null) {
    return {
      childId,
      computedYear: null,
      previousYear: null,
      wrote: false,
      reason: 'no-active-deals',
    };
  }

  // 5. Read the child's current Year and skip the PATCH if unchanged.
  const previousYear = await readChildYear(childId);
  if (previousYear === maxYear) {
    return {
      childId,
      computedYear: maxYear,
      previousYear,
      wrote: false,
      reason: 'unchanged',
    };
  }

  // 6. Write.
  await writeChildYear(childId, maxYear);
  return {
    childId,
    computedYear: maxYear,
    previousYear,
    wrote: true,
    reason: 'updated',
  };
}

// ============================================================================
// HubSpot helpers
// ============================================================================

async function readDealsBatch(dealIds: string[]): Promise<DealStageYear[]> {
  if (dealIds.length === 0) return [];
  const result = await hubspotClient.crm.deals.batchApi.read({
    inputs: dealIds.map((id) => ({ id })),
    properties: ['pipeline', 'dealstage', 'year1'],
    propertiesWithHistory: [],
  });
  return result.results.map((r: any) => {
    const p = (r.properties ?? {}) as Record<string, string | null>;
    return {
      id: r.id,
      pipeline: p.pipeline ?? null,
      dealstage: p.dealstage ?? null,
      year1: p.year1 ?? null,
    };
  });
}

async function readChildYear(childId: string): Promise<number | null> {
  const child = await hubspotClient.crm.objects.basicApi.getById(
    config.objectTypes.child,
    childId,
    [config.properties.child.year]
  );
  const raw = (child.properties as Record<string, string | null>)[
    config.properties.child.year
  ];
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

async function writeChildYear(childId: string, year: number): Promise<void> {
  await hubspotClient.crm.objects.basicApi.update(
    config.objectTypes.child,
    childId,
    {
      properties: {
        [config.properties.child.year]: String(year),
      },
    }
  );
}
