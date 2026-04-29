/**
 * Tests for the 5-step Selected-transition saga (UNIFIED_CARD_SPEC §4.2).
 *
 * Coverage:
 *   - Happy path: all 5 steps run in order, no compensation.
 *   - STEP 4 failure: deal PATCH fails → compensating revert (referral
 *     interest restored, association deleted).
 *   - STEP 5 race: concurrent rep beats us inside the advisory lock →
 *     compensation fires for STEP 1, 2, AND the just-written STEP 4
 *     deal patch.
 *
 * The saga makes calls in this order:
 *   STEP 2: associations.createAssociationsBatch (label = Selected_Referral)
 *   STEP 4: hubspot.deals.basicApi.update
 *   STEP 5: pg.withTransaction → findExistingSelectedReferral
 *
 * Compensation fires:
 *   - STEP 4 revert: hubspot.deals.basicApi.update (clear program_id, etc.)
 *   - STEP 2 revert: associations.v4.batchApi.archive
 *   - STEP 1 revert: hubspot.objects.basicApi.update (interest = previous)
 *
 * The create-flow path skips STEP 1 (interest is set in the create
 * payload), so STEP 1 compensation is exercised via the update-flow
 * (transition TO Selected) tests.
 */

// ============================================================================
// Mocks
// ============================================================================

jest.mock('../lib/hubspot', () => ({
  hubspotClient: {
    crm: {
      deals: {
        basicApi: {
          getById: jest.fn(),
          update: jest.fn(),
        },
      },
      companies: {
        basicApi: {
          getById: jest.fn(),
        },
      },
      objects: {
        basicApi: {
          getById: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
        },
        searchApi: {
          doSearch: jest.fn(),
        },
        batchApi: {
          read: jest.fn(),
        },
      },
      associations: {
        v4: {
          schema: {
            definitionsApi: {
              getAll: jest.fn(),
            },
          },
          batchApi: {
            create: jest.fn(),
            archive: jest.fn().mockResolvedValue(undefined),
          },
        },
      },
    },
  },
}));

const mockCreateAssocBatch = jest.fn();
const mockGetAssociatedIds = jest.fn();
jest.mock('../lib/associations', () => ({
  createAssociationsBatch: (...args: unknown[]) =>
    mockCreateAssocBatch(...args),
  getAssociatedIds: (...args: unknown[]) => mockGetAssociatedIds(...args),
}));

const mockPgClient = {
  query: jest.fn().mockResolvedValue({ rows: [] }),
};
const mockWithTransaction = jest.fn(async (fn: any) => fn(mockPgClient));
jest.mock('../lib/pg', () => ({
  withTransaction: (...args: unknown[]) =>
    mockWithTransaction(...(args as [any])),
}));

import { hubspotClient } from '../lib/hubspot';
import { createReferralWorkflow, updateReferralWorkflow } from '../lib/workflow';

const mockHubspot = hubspotClient as any;

// ============================================================================
// Helpers
// ============================================================================

function mockDealFetch(overrides: Record<string, string> = {}) {
  mockHubspot.crm.deals.basicApi.getById.mockResolvedValue({
    properties: {
      hubspot_owner_id: 'owner-1',
      deal_key: 'dk-1',
      dealname: 'Alex',
      year1: '2026',
      dealstage: 'presentationscheduled',
      program_id: '',
      tuition_at_enrollment: '',
      ...overrides,
    },
  });
}

function mockCompanyFetch(programid = '1544', name = 'Camp Sunshine') {
  mockHubspot.crm.companies.basicApi.getById.mockResolvedValue({
    properties: { name, programid: programid || '' },
  });
}

function mockReferralSearchEmpty() {
  mockHubspot.crm.objects.searchApi.doSearch.mockResolvedValue({ results: [] });
}

function mockReferralCreate(id = '99901') {
  mockHubspot.crm.objects.basicApi.create.mockResolvedValue({ id });
}

beforeEach(() => {
  jest.clearAllMocks();

  // Default: STEP 2 association creation succeeds.
  mockCreateAssocBatch.mockResolvedValue({
    successful: [{}],
    failed: [],
    allSucceeded: true,
  });
  // Default: no other Selected referrals on the deal.
  mockGetAssociatedIds.mockResolvedValue([]);
  // Default: batchApi.read returns empty (no other Selecteds in pre-flight).
  mockHubspot.crm.objects.batchApi.read.mockResolvedValue({ results: [] });
  mockHubspot.crm.deals.basicApi.update.mockResolvedValue({});
  mockHubspot.crm.objects.basicApi.update.mockResolvedValue({});

  // Reset withTransaction to baseline behavior.
  mockWithTransaction.mockImplementation(async (fn: any) => fn(mockPgClient));
});

// ============================================================================
// Happy path
// ============================================================================

describe('Selected-transition saga — happy path (spec §4.2)', () => {
  test('all 5 steps run; no compensation', async () => {
    mockDealFetch();
    mockCompanyFetch('1544', 'Camp Sunshine');
    mockReferralSearchEmpty();
    mockReferralCreate('99901');

    const result = await createReferralWorkflow({
      dealId: '100',
      companyId: '200',
      clientInterest: 'Selected',
    });

    expect(result.success).toBe(true);
    expect(result.dealUpdated).toBe(true);

    // STEP 2: Selected_Referral association created.
    const labels = mockCreateAssocBatch.mock.calls
      .flat(2)
      .filter(Boolean)
      .map((s: any) => s?.label)
      .filter(Boolean);
    expect(labels).toContain('Selected_Referral');

    // STEP 4: deal patched with program_id, programname, dealstage.
    expect(mockHubspot.crm.deals.basicApi.update).toHaveBeenCalledWith(
      '100',
      expect.objectContaining({
        properties: expect.objectContaining({
          program_id: '1544',
          programname: 'Camp Sunshine',
          dealstage: '1282923123',
        }),
      })
    );

    // STEP 5: advisory lock acquired.
    expect(mockWithTransaction).toHaveBeenCalled();
    expect(mockPgClient.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['deal-selected:100']
    );

    // No compensation: archive (assoc delete) NOT called.
    expect(
      mockHubspot.crm.associations.v4.batchApi.archive
    ).not.toHaveBeenCalled();
  });
});

// ============================================================================
// STEP 4 failure → compensation
// ============================================================================

describe('Selected-transition saga — STEP 4 failure (spec §4.2)', () => {
  test('deal PATCH fails → compensating revert (interest, association deleted)', async () => {
    mockDealFetch();
    mockCompanyFetch('1544', 'Camp Sunshine');
    mockReferralSearchEmpty();

    // STEP 4: deal update rejects.
    mockHubspot.crm.deals.basicApi.update.mockRejectedValueOnce(
      new Error('HubSpot API error: invalid stage')
    );

    const result = await updateReferralWorkflow(
      '99901',
      { referral_client_interest: 'Selected' },
      {
        dealId: '100',
        companyId: '200',
        previousClientInterest: 'Active / considering',
      }
    );

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toMatch(/STEP 4 failed/);

    // Compensation: STEP 2 association archived
    expect(
      mockHubspot.crm.associations.v4.batchApi.archive
    ).toHaveBeenCalled();

    // Compensation: STEP 1 referral interest reverted to "Active / considering"
    const updateCalls = mockHubspot.crm.objects.basicApi.update.mock.calls;
    const revertCall = updateCalls.find(
      (c: any[]) =>
        c[2]?.properties?.referral_client_interest === 'Active / considering'
    );
    expect(revertCall).toBeDefined();
  });
});

// ============================================================================
// STEP 5 race → compensation cascade
// ============================================================================

describe('Selected-transition saga — STEP 5 race (spec §4.2)', () => {
  test('concurrent rep wins lock → full compensation runs', async () => {
    mockDealFetch();
    mockCompanyFetch('1544', 'Camp Sunshine');
    mockReferralSearchEmpty();

    // Race scenario:
    //   Pre-flight `findExistingSelectedReferral` (called from
    //     updateReferralWorkflow before the saga): returns null —
    //     `getAssociatedIds` returns [] (call 1) so batchApi.read is
    //     never reached.
    //   Inside-the-lock recheck (called from saga STEP 5):
    //     `getAssociatedIds` now returns ['99902'] (call 2),
    //     `batchApi.read` (call 1, since read wasn't reached on
    //     pre-flight) returns 99902 with Selected — concurrent rep won.
    let assocCallCount = 0;
    mockGetAssociatedIds.mockImplementation(async () => {
      assocCallCount += 1;
      if (assocCallCount === 1) return []; // pre-flight
      return ['99902']; // inside-the-lock recheck
    });

    mockHubspot.crm.objects.batchApi.read.mockImplementation(async () => {
      // Only ever called inside the lock (pre-flight short-circuited).
      return {
        results: [
          {
            id: '99902',
            properties: { referral_client_interest: 'Selected' },
          },
        ],
      };
    });

    const result = await updateReferralWorkflow(
      '99901',
      { referral_client_interest: 'Selected' },
      {
        dealId: '100',
        companyId: '200',
        previousClientInterest: 'Active / considering',
      }
    );

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toMatch(/STEP 5 race/);

    // STEP 4 already ran (deal PATCH succeeded), so compensation must
    // include the deal revert: another deals.update call clearing
    // program_id/programname.
    const dealUpdateCalls = mockHubspot.crm.deals.basicApi.update.mock.calls;
    const revertDealCall = dealUpdateCalls.find(
      (c: any[]) => c[1]?.properties?.program_id === ''
    );
    expect(revertDealCall).toBeDefined();
    expect(revertDealCall![1].properties.dealstage).toBe(
      'presentationscheduled' // recommendationPresented stage
    );

    // STEP 2 archive ran.
    expect(
      mockHubspot.crm.associations.v4.batchApi.archive
    ).toHaveBeenCalled();

    // STEP 1 interest reverted.
    const updateCalls = mockHubspot.crm.objects.basicApi.update.mock.calls;
    const revertCall = updateCalls.find(
      (c: any[]) =>
        c[2]?.properties?.referral_client_interest === 'Active / considering'
    );
    expect(revertCall).toBeDefined();
  });
});
