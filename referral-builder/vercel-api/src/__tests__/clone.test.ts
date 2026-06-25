/**
 * Unit tests for cloneForYear's invariants:
 *   - Locked-source pre-flight returns requiresConfirmation
 *   - Confirmed locked source proceeds
 *   - Ledger hit returns deduped without HubSpot create
 *   - HubSpot recovery hit (no ledger row, but search finds orphan)
 *     returns deduped + writes ledger
 *   - Happy path creates deal + ledger row + does NOT write ce_*
 *
 * Mocks the HubSpot client + the ledger ops + withTransaction so the
 * orchestrator's logic can be tested without DB or network.
 */

jest.mock('../lib/hubspot', () => ({
  hubspotClient: {
    crm: {
      deals: {
        basicApi: {
          getById: jest.fn(),
          create: jest.fn(),
        },
        searchApi: {
          doSearch: jest.fn(),
        },
      },
      objects: {
        basicApi: {
          create: jest.fn().mockResolvedValue({ id: 'NEWREF' }),
        },
      },
      associations: {
        v4: {
          basicApi: {
            createDefault: jest.fn().mockResolvedValue(undefined),
          },
        },
      },
    },
  },
}));

jest.mock('../lib/associations', () => ({
  getAssociatedIds: jest.fn().mockResolvedValue([]),
}));

const mockFetchReferrals = jest.fn().mockResolvedValue([]);
jest.mock('../lib/referrals', () => ({
  fetchReferralsForDeal: (...args: unknown[]) => mockFetchReferrals(...args),
}));

const mockClient = {
  query: jest.fn().mockResolvedValue({ rows: [] }),
};
jest.mock('../lib/pg', () => ({
  withTransaction: jest.fn(async (fn: any) => fn(mockClient)),
}));

const mockFindLedger = jest.fn();
const mockInsertLedger = jest.fn();
const mockAcquireLock = jest.fn();
jest.mock('../lib/clone-ledger', () => ({
  acquireCloneLock: (...args: unknown[]) => mockAcquireLock(...args),
  findCloneLedger: (...args: unknown[]) => mockFindLedger(...args),
  insertCloneLedger: (...args: unknown[]) => mockInsertLedger(...args),
  buildIdempotencyKey: (sourceKey: string, year: number) =>
    `clone:${sourceKey}:${year}`,
  ensureCloneLedgerTable: jest.fn().mockResolvedValue(undefined),
}));

import { hubspotClient } from '../lib/hubspot';
import { getAssociatedIds } from '../lib/associations';
import { cloneForYear } from '../lib/clone';
import { config } from '../lib/config';

const mockHubspot = hubspotClient as any;
const mockGetAssociatedIds = getAssociatedIds as jest.Mock;

function mockSourceDeal(overrides: Record<string, string | null> = {}) {
  mockHubspot.crm.deals.basicApi.getById.mockResolvedValue({
    id: '100',
    properties: {
      dealname: 'Acme Child | 2026',
      pipeline: 'default',
      dealstage: 'decisionmakerboughtin',
      year1: '2026',
      deal_key: 'CHILD123|2026',
      associated_child_id: 'CHILD123',
      associated_household_id: 'HH99',
      hubspot_owner_id: 'OWNER1',
      deal_currency_code: 'USD',
      program_id: '1544',
      programname: 'Camp Sunshine',
      expertprofile: 'Allison Aspis',
      referred_by: '',
      split_type: '',
      deal_split_email: '',
      deal_split_pct: '',
      commission_locked: 'false',
      ...overrides,
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFindLedger.mockResolvedValue(null);
  mockHubspot.crm.deals.searchApi.doSearch.mockResolvedValue({ results: [] });
  // clearAllMocks resets calls but not implementations — reset the
  // referral-count lookup to empty so per-test overrides don't leak.
  mockGetAssociatedIds.mockResolvedValue([]);
});

describe('cloneForYear — locked source pre-flight', () => {
  test('returns requiresConfirmation when source is locked and rep has not confirmed', async () => {
    mockSourceDeal({ commission_locked: 'true' });

    const result = await cloneForYear({
      sourceDealId: '100',
      targetYear: 2027,
    });

    expect(result.success).toBe(false);
    expect((result as any).requiresConfirmation).toBe(true);
    expect((result as any).lockedFields).toEqual([
      'expertprofile',
      'referred_by',
      'split_type',
      'deal_split_email',
      'deal_split_pct',
    ]);
    // Did NOT call create
    expect(mockHubspot.crm.deals.basicApi.create).not.toHaveBeenCalled();
  });

  test('proceeds past lock when confirmExpertFields is true', async () => {
    mockSourceDeal({ commission_locked: 'true' });
    mockHubspot.crm.deals.basicApi.create.mockResolvedValue({ id: '777' });

    const result = await cloneForYear({
      sourceDealId: '100',
      targetYear: 2027,
      confirmExpertFields: true,
    });

    expect(result.success).toBe(true);
    expect((result as any).newDealId).toBe('777');
    expect(mockHubspot.crm.deals.basicApi.create).toHaveBeenCalled();
  });
});

describe('cloneForYear — dedup', () => {
  test('returns deduped when ledger already has a row for (source, year)', async () => {
    mockSourceDeal();
    mockFindLedger.mockResolvedValue({
      source_key: 'CHILD123|2026',
      target_year: 2027,
      new_deal_id: '888',
      created_at: new Date(),
    });

    const result = await cloneForYear({
      sourceDealId: '100',
      targetYear: 2027,
    });

    expect(result.success).toBe(true);
    expect((result as any).deduped).toBe(true);
    expect((result as any).newDealId).toBe('888');
    // Did NOT create or insert
    expect(mockHubspot.crm.deals.basicApi.create).not.toHaveBeenCalled();
    expect(mockInsertLedger).not.toHaveBeenCalled();
  });

  test('HubSpot search recovery: orphaned deal in HubSpot but no ledger row → backfill ledger, return deduped', async () => {
    mockSourceDeal();
    mockFindLedger.mockResolvedValue(null);
    mockHubspot.crm.deals.searchApi.doSearch.mockResolvedValue({
      results: [{ id: '999', properties: {} }],
    });

    const result = await cloneForYear({
      sourceDealId: '100',
      targetYear: 2027,
    });

    expect(result.success).toBe(true);
    expect((result as any).deduped).toBe(true);
    expect((result as any).newDealId).toBe('999');
    expect(mockInsertLedger).toHaveBeenCalledWith(
      mockClient,
      'CHILD123|2026',
      2027,
      '999'
    );
    expect(mockHubspot.crm.deals.basicApi.create).not.toHaveBeenCalled();
  });
});

describe('cloneForYear — happy path', () => {
  test('creates new deal + ledger row, never writes ce_* fields (Rule 1)', async () => {
    mockSourceDeal();
    mockHubspot.crm.deals.basicApi.create.mockResolvedValue({ id: '777' });

    const result = await cloneForYear({
      sourceDealId: '100',
      targetYear: 2027,
    });

    expect(result.success).toBe(true);
    expect((result as any).deduped).toBe(false);
    expect((result as any).newDealId).toBe('777');
    expect((result as any).newDealName).toBe('Acme Child | 2027');

    // Verify the property payload
    const createCall = mockHubspot.crm.deals.basicApi.create.mock.calls[0][0];
    const props = createCall.properties;

    // Lineage + identity
    expect(props.copied_from_deal_key).toBe('CHILD123|2026');
    expect(props.deal_key).toBe('CHILD123|2027');
    expect(props.year1).toBe('2027');
    expect(props.dealname).toBe('Acme Child | 2027');
    expect(props.pipeline).toBe('default');
    // Item 1: no referrals on the source (getAssociatedIds mocked to []) →
    // the clone lands at New Lead.
    expect(props.dealstage).toBe('appointmentscheduled'); // newLead

    // Billing-critical fields propagated
    expect(props.expertprofile).toBe('Allison Aspis');
    expect(props.hubspot_owner_id).toBe('OWNER1');
    expect(props.program_id).toBe('1544');

    // Reset fields are empty
    expect(props.tuition_at_enrollment).toBe('');
    expect(props.amount).toBe('');
    expect(props.session_id).toBe('');

    // Marker
    expect(props.clone_handled_by_api).toBe('true');

    // Rule 1: NO ce_* writes
    expect(props.ce_amount_received).toBeUndefined();
    expect(props.ce_commission_amount).toBeUndefined();
    expect(props.ce_commission_paid).toBeUndefined();
    expect(props.ce_invoice_status).toBeUndefined();
    expect(props.commission_locked).toBeUndefined();

    // Ledger written with the new deal ID
    expect(mockInsertLedger).toHaveBeenCalledWith(
      mockClient,
      'CHILD123|2026',
      2027,
      '777'
    );
  });

  test('lands at Recommendation Plan Presented when the source has referrals (item 1)', async () => {
    mockSourceDeal();
    mockHubspot.crm.deals.basicApi.create.mockResolvedValue({ id: '777' });
    // Source has referrals → clone resumes from the recommendation stage.
    mockGetAssociatedIds.mockResolvedValue(['REF1', 'REF2']);

    const result = await cloneForYear({ sourceDealId: '100', targetYear: 2027 });

    expect(result.success).toBe(true);
    const props = mockHubspot.crm.deals.basicApi.create.mock.calls[0][0].properties;
    expect(props.dealstage).toBe('presentationscheduled'); // recommendationPresented
  });

  test('clones with a derived {child}|{year} key when deal_key is blank (item 1)', async () => {
    mockSourceDeal({ deal_key: '' }); // child id + year still present
    mockHubspot.crm.deals.basicApi.create.mockResolvedValue({ id: '777' });

    const result = await cloneForYear({ sourceDealId: '100', targetYear: 2027 });

    expect(result.success).toBe(true);
    const props = mockHubspot.crm.deals.basicApi.create.mock.calls[0][0].properties;
    expect(props.copied_from_deal_key).toBe('CHILD123|2026');
    expect(mockInsertLedger).toHaveBeenCalledWith(
      mockClient,
      'CHILD123|2026',
      2027,
      '777'
    );
  });

  test('falls back to deal:{id} key when deal_key and child id are both missing (item 1)', async () => {
    mockSourceDeal({ deal_key: '', associated_child_id: '' });
    mockHubspot.crm.deals.basicApi.create.mockResolvedValue({ id: '777' });

    const result = await cloneForYear({ sourceDealId: '100', targetYear: 2027 });

    expect(result.success).toBe(true);
    const props = mockHubspot.crm.deals.basicApi.create.mock.calls[0][0].properties;
    expect(props.copied_from_deal_key).toBe('deal:100');
  });

  test('preserves the child + household FK properties on the clone', async () => {
    mockSourceDeal();
    mockHubspot.crm.deals.basicApi.create.mockResolvedValue({ id: '777' });

    await cloneForYear({ sourceDealId: '100', targetYear: 2027 });

    const props = mockHubspot.crm.deals.basicApi.create.mock.calls[0][0].properties;
    expect(props.associated_child_id).toBe('CHILD123');
    expect(props.associated_household_id).toBe('HH99');
  });
});

describe('cloneForYear — post-commit copy is awaited (not fire-and-forget)', () => {
  // Regression guard: a prior version copied associations/referrals/activity in
  // a setTimeout(0) AFTER returning the response. Vercel freezes the function
  // once the response is sent, so only the first association (the child) landed
  // — household, parents, and referrals silently vanished. The copy must run
  // (and complete) before cloneForYear resolves.
  test('copies associations + clones referrals before resolving', async () => {
    mockSourceDeal();
    mockHubspot.crm.deals.basicApi.create.mockResolvedValue({ id: '777' });
    // One associated id per object type to enumerate/copy.
    mockGetAssociatedIds.mockResolvedValue(['SRC1']);
    // One referral on the source to clone onto the new deal.
    mockFetchReferrals.mockResolvedValue([
      { id: 'R1', company: { id: 'C1', name: 'Camp X' }, note: 'returning camper' },
    ]);

    await cloneForYear({ sourceDealId: '100', targetYear: 2027 });

    // The referral was cloned onto the new deal (copyReferralsToClone ran).
    expect(mockHubspot.crm.objects.basicApi.create).toHaveBeenCalledTimes(1);
    expect(mockHubspot.crm.objects.basicApi.create.mock.calls[0][0]).toBe(
      config.objectTypes.referral
    );

    // The cloned referral is linked to the new deal — proving the copy is
    // awaited, not deferred to a setTimeout the platform would freeze.
    const assocCalls =
      mockHubspot.crm.associations.v4.basicApi.createDefault.mock.calls;
    expect(assocCalls).toContainEqual([
      config.objectTypes.referral,
      'NEWREF',
      'deals',
      '777',
    ]);
    // Deal→child/household/contacts/companies associations were copied too.
    expect(assocCalls).toContainEqual(['deals', '777', config.objectTypes.child, 'SRC1']);
    expect(assocCalls).toContainEqual(['deals', '777', 'contacts', 'SRC1']);
  });

  test('skips the copy entirely on a deduped (ledger-hit) clone', async () => {
    mockSourceDeal();
    mockFindLedger.mockResolvedValue({
      source_key: 'CHILD123|2026',
      target_year: 2027,
      new_deal_id: '888',
      created_at: new Date(),
    });

    await cloneForYear({ sourceDealId: '100', targetYear: 2027 });

    expect(mockHubspot.crm.objects.basicApi.create).not.toHaveBeenCalled();
    expect(
      mockHubspot.crm.associations.v4.basicApi.createDefault
    ).not.toHaveBeenCalled();
  });
});
