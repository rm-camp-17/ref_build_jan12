/**
 * Tests for lib/renewal-spawner.ts.
 *
 * Mocks HubSpot client + getAssociatedIds.
 *
 * Coverage:
 *   - Wrong stage / wrong pipeline → reason flags, no create
 *   - No company → no-company
 *   - Non-eligible commission_logic_type → company-not-eligible
 *   - Eligible + no existing dedup match → creates at New Lead
 *   - Eligible + existing deal at deal_key → already-exists (no create)
 *   - dealname is rebuilt with the new year
 */

jest.mock('../lib/hubspot', () => ({
  hubspotClient: {
    crm: {
      deals: {
        basicApi: { getById: jest.fn(), create: jest.fn() },
        searchApi: { doSearch: jest.fn() },
      },
      companies: {
        basicApi: { getById: jest.fn() },
      },
      associations: {
        v4: { basicApi: { createDefault: jest.fn() } },
      },
    },
  },
}));

const mockGetAssociatedIds = jest.fn();
jest.mock('../lib/associations', () => ({
  getAssociatedIds: (...args: unknown[]) => mockGetAssociatedIds(...args),
}));

import { hubspotClient } from '../lib/hubspot';
import { spawnRenewalForDeal } from '../lib/renewal-spawner';
import { config } from '../lib/config';

const mockHs = hubspotClient as any;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: associations always return empty unless a test overrides.
  mockGetAssociatedIds.mockResolvedValue([]);
});

function setSourceDeal(overrides: Partial<{
  dealname: string;
  pipeline: string;
  dealstage: string;
  year1: string;
  deal_key: string;
  associated_child_id: string;
  associated_household_id: string;
  hubspot_owner_id: string;
}> = {}) {
  mockHs.crm.deals.basicApi.getById.mockResolvedValueOnce({
    id: 'SOURCE',
    properties: {
      dealname: 'Riley Smith | Lindsey - 2026',
      pipeline: 'default',
      dealstage: config.stages.programSelected,
      year1: '2026',
      deal_key: 'CHILD1|2026',
      associated_child_id: 'CHILD1',
      associated_household_id: 'HOUSE1',
      hubspot_owner_id: 'OWNER1',
      deal_currency_code: 'USD',
      ...overrides,
    },
  });
}

function setCompanyLogic(value: string | null) {
  mockHs.crm.companies.basicApi.getById.mockResolvedValue({
    id: 'COMP1',
    properties: {
      [config.properties.company.commissionLogicType]: value,
    },
  });
}

function setSearchExisting(existingId: string | null) {
  mockHs.crm.deals.searchApi.doSearch.mockResolvedValue({
    results: existingId ? [{ id: existingId }] : [],
  });
}

describe('renewal-spawner — early exits', () => {
  test('wrong-stage when source is not at programSelected', async () => {
    setSourceDeal({ dealstage: config.stages.tuitionUndecided });
    const r = await spawnRenewalForDeal('SOURCE');
    expect(r.reason).toBe('wrong-stage');
    expect(mockHs.crm.deals.basicApi.create).not.toHaveBeenCalled();
  });

  test('wrong-pipeline when source is in Historic', async () => {
    setSourceDeal({ pipeline: 'historic-2015-2025' });
    const r = await spawnRenewalForDeal('SOURCE');
    expect(r.reason).toBe('wrong-pipeline');
    expect(mockHs.crm.deals.basicApi.create).not.toHaveBeenCalled();
  });

  test('no-company when deal has no associated company', async () => {
    setSourceDeal();
    mockGetAssociatedIds.mockResolvedValueOnce([]); // companies query
    const r = await spawnRenewalForDeal('SOURCE');
    expect(r.reason).toBe('no-company');
    expect(mockHs.crm.deals.basicApi.create).not.toHaveBeenCalled();
  });

  test('company-not-eligible when commission_logic_type is one_time_only', async () => {
    setSourceDeal();
    mockGetAssociatedIds.mockResolvedValueOnce(['COMP1']);
    setCompanyLogic('one_time_only');
    const r = await spawnRenewalForDeal('SOURCE');
    expect(r.reason).toBe('company-not-eligible');
    expect(r.commissionLogicType).toBe('one_time_only');
    expect(mockHs.crm.deals.basicApi.create).not.toHaveBeenCalled();
  });
});

describe('renewal-spawner — happy path', () => {
  test('creates a New Lead deal for next year with rebuilt name', async () => {
    setSourceDeal();
    // associations: companies (for logic-type read), then per-pair copies
    // (children, households, companies, contacts) — return [] for the
    // copy phase since we only assert the create call here.
    mockGetAssociatedIds.mockResolvedValueOnce(['COMP1']);
    setCompanyLogic('yearly');
    setSearchExisting(null);
    mockHs.crm.deals.basicApi.create.mockResolvedValue({ id: 'NEWDEAL' });

    const r = await spawnRenewalForDeal('SOURCE');
    expect(r.reason).toBe('created');
    expect(r.targetYear).toBe(2027);
    expect(r.newDealId).toBe('NEWDEAL');

    expect(mockHs.crm.deals.basicApi.create).toHaveBeenCalledTimes(1);
    const arg = mockHs.crm.deals.basicApi.create.mock.calls[0][0];
    expect(arg.properties.year1).toBe('2027');
    expect(arg.properties.dealstage).toBe(config.stages.newLead);
    expect(arg.properties.pipeline).toBe('default');
    expect(arg.properties.deal_key).toBe('CHILD1|2027');
    expect(arg.properties.copied_from_deal_key).toBe('CHILD1|2026');
    expect(arg.properties.dealname).toBe('Riley Smith | Lindsey - 2027');
    expect(arg.properties.hubspot_owner_id).toBe('OWNER1');
  });

  test('skips create when a deal already exists at the target deal_key', async () => {
    setSourceDeal();
    mockGetAssociatedIds.mockResolvedValueOnce(['COMP1']);
    setCompanyLogic('second_year');
    setSearchExisting('PRE_EXISTING');

    const r = await spawnRenewalForDeal('SOURCE');
    expect(r.reason).toBe('already-exists');
    expect(r.newDealId).toBe('PRE_EXISTING');
    expect(mockHs.crm.deals.basicApi.create).not.toHaveBeenCalled();
  });
});
