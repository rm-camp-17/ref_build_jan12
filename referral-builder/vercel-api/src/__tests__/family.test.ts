/**
 * Tests for the Family Deals backend: overview resolution (child / household /
 * contact), deal summarization + categorization, and one-click deal creation
 * (dedup, field set, associations).
 */

const mockCreateDeal = jest.fn();
const mockCreateDefault = jest.fn();
const mockGetByName = jest.fn();
const mockSchemaGetById = jest.fn();
jest.mock('../lib/hubspot', () => ({
  hubspotClient: {
    crm: {
      deals: { basicApi: { create: (...a: any[]) => mockCreateDeal(...a) } },
      associations: {
        v4: { basicApi: { createDefault: (...a: any[]) => mockCreateDefault(...a) } },
      },
      properties: { coreApi: { getByName: (...a: any[]) => mockGetByName(...a) } },
      schemas: { coreApi: { getById: (...a: any[]) => mockSchemaGetById(...a) } },
    },
  },
}));

const mockGetAssociatedIds = jest.fn();
jest.mock('../lib/associations', () => ({
  getAssociatedIds: (...a: any[]) => mockGetAssociatedIds(...a),
}));

const mockGetObject = jest.fn();
jest.mock('../lib/objects', () => ({
  getObject: (...a: any[]) => mockGetObject(...a),
}));

const mockGetOwnerByEmail = jest.fn();
jest.mock('../lib/owners', () => ({
  getOwnerByEmail: (...a: any[]) => mockGetOwnerByEmail(...a),
}));

import { getFamilyOverview, createFamilyDeal } from '../lib/family';
import { config } from '../lib/config';

const CHILD = config.objectTypes.child; // 2-50911061
const HH = config.objectTypes.household; // 2-53610744

/** Route getAssociatedIds calls by (fromType, toType). */
function wireAssociations(map: Record<string, string[]>) {
  mockGetAssociatedIds.mockImplementation(
    (fromType: string, fromId: string, toType: string) =>
      Promise.resolve(map[`${fromType}:${fromId}:${toType}`] ?? [])
  );
}

/** Route getObject calls by `${type}:${id}`. */
function wireObjects(map: Record<string, Record<string, string | null>>) {
  mockGetObject.mockImplementation((type: string, id: string) => {
    const props = map[`${type}:${id}`];
    if (!props) return Promise.reject(new Error('not found'));
    return Promise.resolve({ id, properties: props });
  });
}

const DEAL_OPEN = {
  dealname: 'Archie Conway | 2026',
  year1: '2026',
  pipeline: 'default',
  dealstage: 'presentationscheduled',
  hs_is_closed_won: 'false',
  hs_is_closed_lost: 'false',
  programname: '',
  tuition_at_enrollment: '',
  deal_currency_code: 'USD',
  lengthofstay: '',
  session_name: '',
  expertprofile: 'karen_meister',
  closed_lost_category: '',
  closed_lost_reason: '',
};
const DEAL_WON = {
  ...DEAL_OPEN,
  dealname: 'Archie Conway | 2025',
  year1: '2025',
  dealstage: '1282918770',
  pipeline: 'historic',
  hs_is_closed_won: 'true',
  programname: 'CAMP TOWANDA',
  tuition_at_enrollment: '12500',
  lengthofstay: '7',
};
const DEAL_LOST = {
  ...DEAL_OPEN,
  dealname: 'Luke Conway | 2025',
  year1: '2025',
  dealstage: 'closedlost',
  hs_is_closed_lost: 'true',
  closed_lost_category: 'RETURNING_CAMPER',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSchemaGetById.mockResolvedValue({ primaryDisplayProperty: 'child_name' });
  mockCreateDeal.mockResolvedValue({ id: '900' });
  mockCreateDefault.mockResolvedValue({});
});

describe('getFamilyOverview', () => {
  test('child: own deals categorized, household resolved', async () => {
    wireAssociations({
      [`${CHILD}:10:${HH}`]: ['77'],
      [`${CHILD}:10:deals`]: ['1', '2'],
      [`deals:1:${CHILD}`]: ['10'],
      [`deals:2:${CHILD}`]: ['10'],
    });
    wireObjects({
      [`${CHILD}:10`]: { child_name: 'Archie Conway' },
      'deals:1': DEAL_OPEN,
      'deals:2': DEAL_WON,
    });

    const ov = await getFamilyOverview('child', '10');
    expect(ov.householdId).toBe('77');
    expect(ov.kids).toEqual([{ id: '10', name: 'Archie Conway' }]);
    expect(ov.deals).toHaveLength(2);
    const open = ov.deals.find((d) => d.category === 'open')!;
    expect(open.statusLabel).toBe('Rec Plan Presented');
    const won = ov.deals.find((d) => d.category === 'won')!;
    expect(won.camp).toBe('CAMP TOWANDA');
    expect(won.tuition).toBe('12500');
    expect(won.weeks).toBe('7');
    expect(won.childName).toBe('Archie Conway');
  });

  test('household: all kids + all deals, historic lost labeled', async () => {
    wireAssociations({
      [`${HH}:77:${CHILD}`]: ['10', '11'],
      [`${HH}:77:deals`]: ['3'],
      [`deals:3:${CHILD}`]: ['11'],
    });
    wireObjects({
      [`${CHILD}:10`]: { child_name: 'Archie Conway' },
      [`${CHILD}:11`]: { child_name: 'Luke Conway' },
      'deals:3': DEAL_LOST,
    });

    const ov = await getFamilyOverview('household', '77');
    expect(ov.kids.map((k) => k.name)).toEqual(['Archie Conway', 'Luke Conway']);
    expect(ov.deals[0].category).toBe('lost');
    expect(ov.deals[0].childName).toBe('Luke Conway');
    expect(ov.deals[0].closedLostCategory).toBe('RETURNING_CAMPER');
  });

  test('contact: household via contact, deals unioned from household', async () => {
    wireAssociations({
      [`contacts:5:${HH}`]: ['77'],
      ['contacts:5:deals']: ['1'],
      [`${HH}:77:${CHILD}`]: ['10'],
      [`${HH}:77:deals`]: ['1', '2'],
      [`deals:1:${CHILD}`]: ['10'],
      [`deals:2:${CHILD}`]: ['10'],
    });
    wireObjects({
      [`${CHILD}:10`]: { child_name: 'Archie Conway' },
      'deals:1': DEAL_OPEN,
      'deals:2': DEAL_WON,
    });

    const ov = await getFamilyOverview('contact', '5');
    expect(ov.householdId).toBe('77');
    expect(ov.deals).toHaveLength(2); // union, deduped
  });
});

describe('createFamilyDeal', () => {
  test('creates with the standard field set and all associations', async () => {
    wireAssociations({
      [`${CHILD}:10:deals`]: [], // no existing deals
      [`${CHILD}:10:${HH}`]: ['77'],
      [`${HH}:77:contacts`]: ['5', '6'],
      [`${CHILD}:10:contacts`]: ['5'],
    });
    wireObjects({ [`${CHILD}:10`]: { child_name: 'Archie Conway' } });

    const result = await createFamilyDeal({
      childId: '10',
      year: 2027,
      expertProfile: 'karen_meister',
    });

    expect(result.success).toBe(true);
    const props = mockCreateDeal.mock.calls[0][0].properties;
    expect(props.dealname).toBe('Archie Conway | 2027');
    expect(props.pipeline).toBe('default');
    expect(props.dealstage).toBe(config.stages.newLead);
    expect(props.year1).toBe('2027');
    expect(props.deal_key).toBe('10|2027');
    expect(props.associated_child_id).toBe('10');
    expect(props.associated_household_id).toBe('77');
    expect(props.expertprofile).toBe('karen_meister');
    expect(props.deal_currency_code).toBe('USD');
    // No creatorEmail/ownerId given → unowned, and no lookup attempted.
    expect(props.hubspot_owner_id).toBeUndefined();
    expect(mockGetOwnerByEmail).not.toHaveBeenCalled();

    // Associations: child + household + two parents (deduped union).
    const assocCalls = mockCreateDefault.mock.calls.map((c) => `${c[2]}:${c[3]}`);
    expect(assocCalls).toEqual(
      expect.arrayContaining([`${CHILD}:10`, `${HH}:77`, 'contacts:5', 'contacts:6'])
    );
    expect(assocCalls).toHaveLength(4);
  });

  test('assigns the creating expert as deal owner via creatorEmail', async () => {
    wireAssociations({
      [`${CHILD}:10:deals`]: [],
      [`${CHILD}:10:${HH}`]: ['77'],
      [`${HH}:77:contacts`]: ['5'],
      [`${CHILD}:10:contacts`]: [],
    });
    wireObjects({ [`${CHILD}:10`]: { child_name: 'Archie Conway' } });
    mockGetOwnerByEmail.mockResolvedValue({
      id: '42',
      email: 'karen@campexperts.com',
      name: 'Karen Meister',
    });

    const result = await createFamilyDeal({
      childId: '10',
      year: 2027,
      expertProfile: 'karen_meister',
      creatorEmail: 'karen@campexperts.com',
    });

    expect(result.success).toBe(true);
    expect((result as any).ownerName).toBe('Karen Meister');
    expect(mockGetOwnerByEmail).toHaveBeenCalledWith('karen@campexperts.com');
    const props = mockCreateDeal.mock.calls[0][0].properties;
    expect(props.hubspot_owner_id).toBe('42');
  });

  test('owner lookup miss or failure still creates the deal (unowned)', async () => {
    wireAssociations({
      [`${CHILD}:10:deals`]: [],
      [`${CHILD}:10:${HH}`]: ['77'],
      [`${HH}:77:contacts`]: ['5'],
      [`${CHILD}:10:contacts`]: [],
    });
    wireObjects({ [`${CHILD}:10`]: { child_name: 'Archie Conway' } });
    mockGetOwnerByEmail.mockRejectedValue(new Error('owners API down'));

    const result = await createFamilyDeal({
      childId: '10',
      year: 2027,
      expertProfile: 'karen_meister',
      creatorEmail: 'karen@campexperts.com',
    });

    expect(result.success).toBe(true);
    expect((result as any).ownerName).toBeUndefined();
    const props = mockCreateDeal.mock.calls[0][0].properties;
    expect(props.hubspot_owner_id).toBeUndefined();
  });

  test('explicit ownerId wins over creatorEmail (no lookup)', async () => {
    wireAssociations({
      [`${CHILD}:10:deals`]: [],
      [`${CHILD}:10:${HH}`]: ['77'],
      [`${HH}:77:contacts`]: ['5'],
      [`${CHILD}:10:contacts`]: [],
    });
    wireObjects({ [`${CHILD}:10`]: { child_name: 'Archie Conway' } });

    const result = await createFamilyDeal({
      childId: '10',
      year: 2027,
      expertProfile: 'karen_meister',
      ownerId: '99',
      creatorEmail: 'karen@campexperts.com',
    });

    expect(result.success).toBe(true);
    expect(mockGetOwnerByEmail).not.toHaveBeenCalled();
    const props = mockCreateDeal.mock.calls[0][0].properties;
    expect(props.hubspot_owner_id).toBe('99');
  });

  test('asks for confirmation when the kid already has deals that year (no hard block)', async () => {
    wireAssociations({
      [`${CHILD}:10:deals`]: ['1'],
      [`${CHILD}:10:${HH}`]: ['77'],
    });
    wireObjects({
      [`${CHILD}:10`]: { child_name: 'Archie Conway' },
      'deals:1': { dealname: 'Archie Conway | 2027', year1: '2027' },
    });

    const result = await createFamilyDeal({
      childId: '10',
      year: 2027,
      expertProfile: 'karen_meister',
    });
    expect(result.success).toBe(false);
    expect((result as any).requiresConfirmation).toBe(true);
    expect((result as any).existingDeals).toEqual([
      { dealId: '1', dealName: 'Archie Conway | 2027' },
    ]);
    expect(mockCreateDeal).not.toHaveBeenCalled();
  });

  test('confirmDuplicate creates a second same-year deal (two programs in one summer)', async () => {
    wireAssociations({
      [`${CHILD}:10:deals`]: ['1'],
      [`${CHILD}:10:${HH}`]: ['77'],
      [`${HH}:77:contacts`]: ['5'],
      [`${CHILD}:10:contacts`]: [],
    });
    wireObjects({
      [`${CHILD}:10`]: { child_name: 'Archie Conway' },
      'deals:1': { dealname: 'Archie Conway | 2027', year1: '2027' },
    });

    const result = await createFamilyDeal({
      childId: '10',
      year: 2027,
      expertProfile: 'karen_meister',
      confirmDuplicate: true,
    });
    expect(result.success).toBe(true);
    expect(mockCreateDeal).toHaveBeenCalledTimes(1);
    const props = mockCreateDeal.mock.calls[0][0].properties;
    expect(props.dealname).toBe('Archie Conway | 2027');
  });
});
