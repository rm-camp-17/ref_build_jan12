/**
 * Family overview + one-click deal creation for the Family Deals card
 * (rendered on Child / Household / Parent-contact records).
 *
 * Resolution model (all via live HubSpot v4 associations):
 *   child     → its own deals; household via child→household
 *   household → its children + all household deals
 *   contact   → its deals; household via contact→household (fallback: the
 *               first deal's household); kids via the household
 *
 * Deal creation mirrors what the referral-builder card produces today:
 *   dealname  "{Child Name} | {Year}"
 *   pipeline  default, dealstage New Lead
 *   year1, deal_key "{childObjectId}|{year}", expertprofile
 *   associated_child_id / associated_household_id (FK properties)
 *   + default associations deal→child, deal→household, deal→parent contacts
 *
 * Dedup: creating is refused (409-style result) when the child already has a
 * deal for that year — checked against the child's live associated deals, so
 * it works for legacy deals whose FK properties predate object ids.
 */

import { hubspotClient } from './hubspot';
import { config } from './config';
import { getAssociatedIds } from './associations';
import { getObject } from './objects';

// ============================================================================
// Types
// ============================================================================

export type FamilyObjectType = 'child' | 'household' | 'contact';

export interface FamilyKid {
  id: string;
  name: string;
}

export interface FamilyDealSummary {
  dealId: string;
  dealName: string;
  dealUrl: string;
  year: string;
  pipeline: string;
  category: 'open' | 'won' | 'lost';
  statusLabel: string;
  camp: string; // programname (attended / selected camp)
  tuition: string;
  currency: string;
  weeks: string;
  sessionName: string;
  expertProfile: string;
  closedLostCategory: string;
  closedLostReason: string;
  childId: string | null;
  childName: string;
}

export interface FamilyOverview {
  objectType: FamilyObjectType;
  objectId: string;
  householdId: string | null;
  kids: FamilyKid[];
  deals: FamilyDealSummary[];
}

// ============================================================================
// Stage labels (both pipelines)
// ============================================================================

const STAGE_LABELS: Record<string, string> = {
  // Active "Deal Pipeline"
  appointmentscheduled: 'New Lead',
  qualifiedtobuy: 'Intro Call Completed',
  presentationscheduled: 'Rec Plan Presented',
  '1282923123': 'Tuition Undecided',
  decisionmakerboughtin: 'Program Selected',
  closedlost: 'Closed Lost',
  // Historic 2015-2025 pipeline
  '1323878986': 'New Lead',
  '1323878987': 'Rec Plan Presented',
  '1323878988': 'Tuition Undecided',
  '1323872786': 'Program Selected',
  '1282918770': 'Closed Won',
  '1282918771': 'Closed Lost',
};

function dealUrl(dealId: string): string {
  return `https://app.hubspot.com/contacts/${config.notifications.portalId}/record/0-3/${dealId}`;
}

// ============================================================================
// Display-name resolution for the custom objects
// ============================================================================

// Candidate name properties per object, tried in order against the schema's
// primaryDisplayProperty first, then as literal fetches. Cached per process.
const displayPropCache = new Map<string, string>();

async function resolveDisplayProperty(objectType: string): Promise<string> {
  const cached = displayPropCache.get(objectType);
  if (cached) return cached;
  try {
    const schema: any = await (hubspotClient.crm as any).schemas.coreApi.getById(
      objectType
    );
    const prop = schema?.primaryDisplayProperty;
    if (prop) {
      displayPropCache.set(objectType, prop);
      return prop;
    }
  } catch (err: any) {
    console.warn(
      `[family] schema lookup failed for ${objectType} (falling back to candidates):`,
      err?.message
    );
  }
  displayPropCache.set(objectType, 'hs_object_id');
  return 'hs_object_id';
}

async function getObjectDisplayName(
  objectType: string,
  objectId: string
): Promise<string> {
  const prop = await resolveDisplayProperty(objectType);
  try {
    const obj = await getObject(objectType, objectId, [prop]);
    return obj.properties[prop] || `#${objectId}`;
  } catch {
    return `#${objectId}`;
  }
}

// ============================================================================
// Overview
// ============================================================================

const DEAL_SUMMARY_PROPS = [
  'dealname',
  'year1',
  'pipeline',
  'dealstage',
  'hs_is_closed_won',
  'hs_is_closed_lost',
  'programname',
  'tuition_at_enrollment',
  'deal_currency_code',
  'lengthofstay',
  'session_name',
  'expertprofile',
  'closed_lost_category',
  'closed_lost_reason',
];

async function summarizeDeal(dealId: string): Promise<FamilyDealSummary> {
  const [obj, childIds] = await Promise.all([
    getObject('deals', dealId, [...DEAL_SUMMARY_PROPS]),
    getAssociatedIds('deals', dealId, config.objectTypes.child).catch(() => []),
  ]);
  const p = obj.properties;
  const category: FamilyDealSummary['category'] =
    p.hs_is_closed_won === 'true'
      ? 'won'
      : p.hs_is_closed_lost === 'true'
      ? 'lost'
      : 'open';
  return {
    dealId,
    dealName: p.dealname || `Deal ${dealId}`,
    dealUrl: dealUrl(dealId),
    year: p.year1 || '',
    pipeline: p.pipeline || '',
    category,
    statusLabel: STAGE_LABELS[p.dealstage || ''] || p.dealstage || 'Unknown',
    camp: p.programname || '',
    tuition: p.tuition_at_enrollment || '',
    currency: p.deal_currency_code || 'USD',
    weeks: p.lengthofstay || '',
    sessionName: p.session_name || '',
    expertProfile: p.expertprofile || '',
    closedLostCategory: p.closed_lost_category || '',
    closedLostReason: p.closed_lost_reason || '',
    childId: childIds[0] ?? null,
    childName: '', // filled by the caller from the kids map
  };
}

export async function getFamilyOverview(
  objectType: FamilyObjectType,
  objectId: string
): Promise<FamilyOverview> {
  const CHILD = config.objectTypes.child;
  const HOUSEHOLD = config.objectTypes.household;

  let householdId: string | null = null;
  let kidIds: string[] = [];
  let dealIds: string[] = [];

  if (objectType === 'child') {
    kidIds = [objectId];
    const [hh, deals] = await Promise.all([
      getAssociatedIds(CHILD, objectId, HOUSEHOLD).catch(() => []),
      getAssociatedIds(CHILD, objectId, 'deals').catch(() => []),
    ]);
    householdId = hh[0] ?? null;
    dealIds = deals;
  } else if (objectType === 'household') {
    householdId = objectId;
    const [kids, deals] = await Promise.all([
      getAssociatedIds(HOUSEHOLD, objectId, CHILD).catch(() => []),
      getAssociatedIds(HOUSEHOLD, objectId, 'deals').catch(() => []),
    ]);
    kidIds = kids;
    dealIds = deals;
  } else {
    // contact (parent)
    const [hh, deals] = await Promise.all([
      getAssociatedIds('contacts', objectId, HOUSEHOLD).catch(() => []),
      getAssociatedIds('contacts', objectId, 'deals').catch(() => []),
    ]);
    householdId = hh[0] ?? null;
    dealIds = deals;
    // Fallback: derive the household from the first deal.
    if (!householdId && dealIds.length > 0) {
      const viaDeal = await getAssociatedIds('deals', dealIds[0], HOUSEHOLD).catch(
        () => []
      );
      householdId = viaDeal[0] ?? null;
    }
    if (householdId) {
      kidIds = await getAssociatedIds(HOUSEHOLD, householdId, CHILD).catch(
        () => []
      );
      // The household may have deals beyond the contact's own (e.g. other
      // parent created them) — union for the full family picture.
      const hhDeals = await getAssociatedIds(HOUSEHOLD, householdId, 'deals').catch(
        () => []
      );
      dealIds = Array.from(new Set([...dealIds, ...hhDeals]));
    }
  }

  const [kids, deals] = await Promise.all([
    Promise.all(
      kidIds.map(async (id): Promise<FamilyKid> => ({
        id,
        name: await getObjectDisplayName(CHILD, id),
      }))
    ),
    Promise.all(dealIds.map(summarizeDeal)),
  ]);

  // Attach child names; discover any kid that appeared via a deal but isn't
  // linked to the household (data drift) so the card still shows them.
  const kidById = new Map(kids.map((k) => [k.id, k]));
  for (const deal of deals) {
    if (deal.childId && !kidById.has(deal.childId)) {
      const name = await getObjectDisplayName(CHILD, deal.childId);
      const kid = { id: deal.childId, name };
      kidById.set(kid.id, kid);
      kids.push(kid);
    }
    deal.childName = deal.childId ? kidById.get(deal.childId)?.name ?? '' : '';
  }

  // Newest year first inside each category; the card groups by category.
  deals.sort((a, b) => (b.year || '').localeCompare(a.year || ''));

  return { objectType, objectId, householdId, kids, deals };
}

// ============================================================================
// Create deal
// ============================================================================

export interface CreateFamilyDealInput {
  childId: string;
  year: number;
  expertProfile: string;
  /** Optional — resolved from the child when omitted. */
  householdId?: string | null;
  /** Optional HubSpot owner to assign. */
  ownerId?: string | null;
  /**
   * A kid CAN have multiple deals in one year (e.g. two programs in one
   * summer). When the kid already has deals for the target year we return
   * requiresConfirmation instead of creating; passing true creates anyway.
   */
  confirmDuplicate?: boolean;
}

export type CreateFamilyDealResult =
  | { success: true; dealId: string; dealName: string; dealUrl: string }
  | {
      success: false;
      requiresConfirmation: true;
      existingDeals: Array<{ dealId: string; dealName: string }>;
      message: string;
    }
  | { success: false; requiresConfirmation?: false; message: string };

export async function createFamilyDeal(
  input: CreateFamilyDealInput
): Promise<CreateFamilyDealResult> {
  const CHILD = config.objectTypes.child;
  const HOUSEHOLD = config.objectTypes.household;
  const { childId, year, expertProfile } = input;

  const childName = await getObjectDisplayName(CHILD, childId);
  if (childName.startsWith('#')) {
    return { success: false, message: 'Child record not found.' };
  }

  // Gentle same-year guide (NOT a hard block — a kid can attend two programs
  // in one year). Unless the caller confirmed, surface the kid's existing
  // deals for the target year and ask before creating another. Checked via
  // live associations so legacy deals count.
  if (!input.confirmDuplicate) {
    const existingDealIds = await getAssociatedIds(CHILD, childId, 'deals').catch(
      () => []
    );
    const sameYear: Array<{ dealId: string; dealName: string }> = [];
    for (const id of existingDealIds) {
      try {
        const d = await getObject('deals', id, ['dealname', 'year1']);
        if ((d.properties.year1 || '') === String(year)) {
          sameYear.push({
            dealId: id,
            dealName: d.properties.dealname || `Deal ${id}`,
          });
        }
      } catch {
        // unreadable deal — don't block creation on it
      }
    }
    if (sameYear.length > 0) {
      return {
        success: false,
        requiresConfirmation: true,
        existingDeals: sameYear,
        message: `${childName} already has ${sameYear.length} ${year} deal${
          sameYear.length === 1 ? '' : 's'
        }: ${sameYear.map((d) => `"${d.dealName}"`).join(', ')}. Create another (e.g. a second program)?`,
      };
    }
  }

  // Resolve the household + parent contacts.
  let householdId = input.householdId ?? null;
  if (!householdId) {
    const hh = await getAssociatedIds(CHILD, childId, HOUSEHOLD).catch(() => []);
    householdId = hh[0] ?? null;
  }
  const parentSets = await Promise.all([
    householdId
      ? getAssociatedIds(HOUSEHOLD, householdId, 'contacts').catch(() => [])
      : Promise.resolve([]),
    getAssociatedIds(CHILD, childId, 'contacts').catch(() => []),
  ]);
  const parentIds = Array.from(new Set(parentSets.flat()));

  // Create the deal with the card's standard field set.
  const properties: Record<string, string> = {
    dealname: `${childName} | ${year}`,
    pipeline: 'default',
    dealstage: config.stages.newLead,
    year1: String(year),
    deal_key: `${childId}|${year}`,
    associated_child_id: childId,
    associated_household_id: householdId ?? '',
    expertprofile: expertProfile,
    clone_handled_by_api: 'true',
  };
  if (input.ownerId) properties.hubspot_owner_id = input.ownerId;

  let dealId: string;
  try {
    const created: any = await hubspotClient.crm.deals.basicApi.create({
      properties,
    } as any);
    dealId = String(created.id);
  } catch (err: any) {
    console.error('[family] deal create failed:', err?.message);
    return { success: false, message: `Could not create the deal: ${err?.message}` };
  }

  // Associations — the deal exists with FK properties even if one fails.
  const targets: Array<[string, string]> = [
    [CHILD, childId],
    ...(householdId ? ([[HOUSEHOLD, householdId]] as Array<[string, string]>) : []),
    ...parentIds.map((id): [string, string] => ['contacts', id]),
  ];
  for (const [type, id] of targets) {
    try {
      await hubspotClient.crm.associations.v4.basicApi.createDefault(
        'deals',
        dealId,
        type,
        id
      );
    } catch (err: any) {
      console.warn(
        `[family] could not associate ${type} ${id} to new deal ${dealId}:`,
        err?.message
      );
    }
  }

  return {
    success: true,
    dealId,
    dealName: properties.dealname,
    dealUrl: dealUrl(dealId),
  };
}

// ============================================================================
// Expert profile options (deal enum, cached per process)
// ============================================================================

let _expertOptions: Array<{ label: string; value: string }> | null = null;

export async function getExpertProfileOptions(): Promise<
  Array<{ label: string; value: string }>
> {
  if (_expertOptions) return _expertOptions;
  const prop: any = await hubspotClient.crm.properties.coreApi.getByName(
    'deals',
    'expertprofile'
  );
  _expertOptions = (prop?.options || [])
    .filter((o: any) => !o.hidden)
    .map((o: any) => ({ label: o.label, value: o.value }));
  return _expertOptions!;
}
