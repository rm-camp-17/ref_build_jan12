/**
 * Tests for the referral-to-session integration logic in workflow.ts
 *
 * These tests mock the HubSpot API client and verify:
 * - Deal property writes when client_interest = "Selected"
 * - Existing Selected referral check (duplicate prevention)
 * - Company programid validation (block if empty)
 * - Program name fallback logic
 * - Three-tier de-selection behavior
 * - Error handling for partial writes
 */

// Mock the HubSpot client before importing workflow
jest.mock('../lib/hubspot', () => {
  const mockClient = {
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
          },
        },
      },
    },
  };
  return { hubspotClient: mockClient };
});

// Mock associations module
jest.mock('../lib/associations', () => ({
  createAssociationsBatch: jest.fn().mockResolvedValue({
    successful: [],
    failed: [],
    allSucceeded: true,
  }),
  getAssociatedIds: jest.fn().mockResolvedValue([]),
}));

import { hubspotClient } from '../lib/hubspot';
import { getAssociatedIds } from '../lib/associations';
import { createReferralWorkflow, updateReferralWorkflow } from '../lib/workflow';

const mockHubspot = hubspotClient as any;
const mockGetAssociatedIds = getAssociatedIds as jest.Mock;

// Helper to set up standard deal fetch mock
function mockDealFetch(overrides: Record<string, string> = {}) {
  mockHubspot.crm.deals.basicApi.getById.mockResolvedValue({
    properties: {
      hubspot_owner_id: 'owner-123',
      deal_key: 'dk-1',
      dealname: 'Test Child',
      year1: '2026',
      dealstage: 'presentationscheduled',
      program_id: '',
      tuition_at_enrollment: '',
      ...overrides,
    },
  });
}

// Helper to set up company fetch mock
// Note: getById is called multiple times with different property lists
// (once for programid, once for name). Return all properties each time.
function mockCompanyFetch(programid: string | null = '1544', name: string = 'Camp Sunshine') {
  mockHubspot.crm.companies.basicApi.getById.mockResolvedValue({
    properties: {
      name,
      programid: programid || '',
    },
  });
}

// Helper for referral search (findExistingReferral)
function mockReferralSearch(existingId: string | null = null) {
  mockHubspot.crm.objects.searchApi.doSearch.mockResolvedValue({
    results: existingId ? [{ id: existingId }] : [],
  });
}

// Helper for referral create
function mockReferralCreate(id: string = '99901') {
  mockHubspot.crm.objects.basicApi.create.mockResolvedValue({ id });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createReferralWorkflow — Selected integration', () => {
  test('writes program_id, programname (= company name), dealstage when interest is Selected', async () => {
    mockDealFetch();
    mockCompanyFetch('1544', 'Camp Sunshine');
    mockReferralSearch(null);
    mockReferralCreate('99901');
    mockHubspot.crm.deals.basicApi.update.mockResolvedValue({});
    mockHubspot.crm.objects.batchApi.read.mockResolvedValue({ results: [] });

    const result = await createReferralWorkflow({
      dealId: '100',
      companyId: '200',
      clientInterest: 'Selected',
    });

    expect(result.success).toBe(true);
    expect(result.dealUpdated).toBe(true);

    // Verify deal was updated with correct properties.
    // programname now uses Company.name directly — Program HubSpot object
    // doesn't exist in this portal.
    expect(mockHubspot.crm.deals.basicApi.update).toHaveBeenCalledWith('100', {
      properties: {
        program_id: '1544',
        programname: 'Camp Sunshine',
        dealstage: '1282923123',
      },
    });
  });

  test('blocks when company has no programid', async () => {
    mockDealFetch();
    mockCompanyFetch(null, 'Camp No Program');
    mockReferralSearch(null);
    mockHubspot.crm.objects.batchApi.read.mockResolvedValue({ results: [] });

    const result = await createReferralWorkflow({
      dealId: '100',
      companyId: '200',
      clientInterest: 'Selected',
    });

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain('does not have a program ID');
    // Deal should NOT have been updated
    expect(mockHubspot.crm.deals.basicApi.update).not.toHaveBeenCalled();
  });

  test('blocks when another referral is already Selected on the deal', async () => {
    mockDealFetch();
    mockGetAssociatedIds.mockResolvedValue(['99902']);
    mockHubspot.crm.objects.batchApi.read.mockResolvedValue({
      results: [
        {
          id: '99902',
          properties: { referral_client_interest: 'Selected' },
        },
      ],
    });

    const result = await createReferralWorkflow({
      dealId: '100',
      companyId: '200',
      clientInterest: 'Selected',
    });

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain('already marked Selected');
  });

  test('uses company name as programname (no Program HubSpot object exists)', async () => {
    mockDealFetch();
    mockCompanyFetch('1544', 'Camp Sunshine');
    mockReferralSearch(null);
    mockReferralCreate('99901');
    mockHubspot.crm.deals.basicApi.update.mockResolvedValue({});
    mockHubspot.crm.objects.batchApi.read.mockResolvedValue({ results: [] });

    const result = await createReferralWorkflow({
      dealId: '100',
      companyId: '200',
      clientInterest: 'Selected',
    });

    expect(result.success).toBe(true);
    expect(mockHubspot.crm.deals.basicApi.update).toHaveBeenCalledWith('100', {
      properties: expect.objectContaining({
        programname: 'Camp Sunshine',
      }),
    });
  });

  test('returns error when deal PATCH fails', async () => {
    mockDealFetch();
    mockCompanyFetch('1544', 'Camp Sunshine');
    mockReferralSearch(null);
    mockReferralCreate('99901');
    mockHubspot.crm.objects.batchApi.read.mockResolvedValue({ results: [] });
    mockHubspot.crm.deals.basicApi.update.mockRejectedValue(
      new Error('HubSpot API error: invalid stage')
    );

    const result = await createReferralWorkflow({
      dealId: '100',
      companyId: '200',
      clientInterest: 'Selected',
    });

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain('Failed to update deal');
  });

  test('does not write to deal when interest is not Selected', async () => {
    mockDealFetch();
    mockCompanyFetch();
    mockReferralSearch(null);
    mockReferralCreate('99901');

    const result = await createReferralWorkflow({
      dealId: '100',
      companyId: '200',
      clientInterest: 'Active / considering',
    });

    expect(result.success).toBe(true);
    expect(result.dealUpdated).toBeFalsy();
    expect(mockHubspot.crm.deals.basicApi.update).not.toHaveBeenCalled();
  });
});

describe('updateReferralWorkflow — de-selection tiers', () => {
  test('Tier 1: allows de-selection and resets deal when no tuition entered', async () => {
    mockDealFetch({ dealstage: '1282923123', tuition_at_enrollment: '' });
    mockHubspot.crm.objects.basicApi.update.mockResolvedValue({});
    mockHubspot.crm.deals.basicApi.update.mockResolvedValue({});

    const result = await updateReferralWorkflow(
      '99901',
      { referral_client_interest: 'Active / considering' },
      {
        dealId: '100',
        previousClientInterest: 'Selected',
      }
    );

    expect(result.success).toBe(true);

    // Verify deal was reset
    expect(mockHubspot.crm.deals.basicApi.update).toHaveBeenCalledWith('100', {
      properties: {
        program_id: '',
        programname: '',
        dealstage: 'presentationscheduled',
      },
    });
  });

  test('Tier 2: blocks de-selection when tuition has been entered', async () => {
    mockDealFetch({
      dealstage: 'decisionmakerboughtin',
      tuition_at_enrollment: '5000',
    });

    const result = await updateReferralWorkflow(
      '99901',
      { referral_client_interest: 'Unlikely' },
      {
        dealId: '100',
        previousClientInterest: 'Selected',
      }
    );

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain('Tuition has been entered');
    // Referral should NOT have been updated
    expect(mockHubspot.crm.objects.basicApi.update).not.toHaveBeenCalled();
  });

  test('Tier 3: hard blocks de-selection when deal is Closed Won', async () => {
    mockDealFetch({
      dealstage: '1282918770',
      tuition_at_enrollment: '5000',
    });

    const result = await updateReferralWorkflow(
      '99901',
      { referral_client_interest: 'Declined' },
      {
        dealId: '100',
        previousClientInterest: 'Selected',
      }
    );

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain('finalized');
    expect(mockHubspot.crm.objects.basicApi.update).not.toHaveBeenCalled();
  });

  test('standard update (no selection transition) works without context', async () => {
    mockHubspot.crm.objects.basicApi.update.mockResolvedValue({});

    const result = await updateReferralWorkflow(
      '99901',
      { referral_note_to_company: 'Updated note' }
    );

    expect(result.success).toBe(true);
    expect(mockHubspot.crm.objects.basicApi.update).toHaveBeenCalledWith(
      '2-55790899',
      '99901',
      { properties: { referral_note_to_company: 'Updated note' } }
    );
  });
});

describe('updateReferralWorkflow — transition TO Selected', () => {
  test('validates and updates deal when editing referral to Selected', async () => {
    mockDealFetch();
    mockCompanyFetch('1544', 'Camp Sunshine');
    mockGetAssociatedIds.mockResolvedValue([]);
    mockHubspot.crm.objects.batchApi.read.mockResolvedValue({ results: [] });
    mockHubspot.crm.objects.basicApi.update.mockResolvedValue({});
    mockHubspot.crm.deals.basicApi.update.mockResolvedValue({});

    const result = await updateReferralWorkflow(
      '99901',
      { referral_client_interest: 'Selected' },
      {
        dealId: '100',
        companyId: '200',
        previousClientInterest: 'Active / considering',
      }
    );

    expect(result.success).toBe(true);
    expect(mockHubspot.crm.deals.basicApi.update).toHaveBeenCalledWith('100', {
      properties: expect.objectContaining({
        program_id: '1544',
        dealstage: '1282923123',
      }),
    });
  });

  test('blocks when another referral is already Selected (edit flow)', async () => {
    mockGetAssociatedIds.mockResolvedValue(['99903']);
    mockHubspot.crm.objects.batchApi.read.mockResolvedValue({
      results: [
        { id: '99903', properties: { referral_client_interest: 'Selected' } },
      ],
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
    expect(result.errors?.[0]).toContain('already marked Selected');
  });
});
