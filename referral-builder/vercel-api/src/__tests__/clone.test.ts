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
const mockDeleteLedger = jest.fn();
const mockAcquireLock = jest.fn();
jest.mock('../lib/clone-ledger', () => ({
  acquireCloneLock: (...args: unknown[]) => mockAcquireLock(...args),
  findCloneLedger: (...args: unknown[]) => mockFindLedger(...args),
  insertCloneLedger: (...args: unknown[]) => mockInsertLedger(...args),
  deleteCloneLedger: (...args: unknown[]) => mockDeleteLedger(...args),
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
  mockFetchReferrals.mockReset();
  mockFetchReferrals.mockResolvedValue([]);
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

  test('recreates the clone when the ledger points to a deleted deal', async () => {
    // Source deal exists; the recorded 2027 clone (888) was deleted → 404.
    mockHubspot.crm.deals.basicApi.getById.mockImplementation((id: string) => {
      if (id === '888') {
        const err: any = new Error('not found');
        err.code = 404;
        return Promise.reject(err);
      }
      return Promise.resolve({
        id,
        properties: {
          dealname: 'Acme Child | 2026',
          pipeline: 'default',
          dealstage: 'closedlost',
          year1: '2026',
          deal_key: 'CHILD123|2026',
          associated_child_id: 'CHILD123',
          associated_household_id: 'HH99',
          hubspot_owner_id: 'OWNER1',
          deal_currency_code: 'USD',
          program_id: '1544',
          programname: 'Camp Sunshine',
          expertprofile: '',
          referred_by: '',
          split_type: '',
          deal_split_email: '',
          deal_split_pct: '',
          commission_locked: 'false',
        },
      });
    });
    mockFindLedger.mockResolvedValue({
      source_key: 'CHILD123|2026',
      target_year: 2027,
      new_deal_id: '888',
      created_at: new Date(),
    });
    mockHubspot.crm.deals.searchApi.doSearch.mockResolvedValue({ results: [] });
    mockHubspot.crm.deals.basicApi.create.mockResolvedValue({ id: '999' });

    const result = await cloneForYear({ sourceDealId: '100', targetYear: 2027 });

    // Recreated (not deduped to the phantom), stale row dropped, fresh ledger.
    expect(result.success).toBe(true);
    expect((result as any).deduped).toBe(false);
    expect((result as any).newDealId).toBe('999');
    expect(mockDeleteLedger).toHaveBeenCalledWith(mockClient, 'CHILD123|2026', 2027);
    expect(mockHubspot.crm.deals.basicApi.create).toHaveBeenCalled();
    expect(mockInsertLedger).toHaveBeenCalledWith(
      mockClient,
      'CHILD123|2026',
      2027,
      '999'
    );
  });
});

describe('cloneForYear — happy path', () => {
  test('creates new deal + ledger row, never writes ce_* fields (Rule 1)', async () => {
    // Non-won source (Closed Lost) with no referrals → New Lead landing stage.
    mockSourceDeal({ dealstage: 'closedlost' });
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
    // No referrals on the source (getAssociatedIds mocked to []) and the
    // source is not Closed Won → the clone lands at New Lead.
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

  test('lands at Recommendation Plan Presented when a non-won source has referrals', async () => {
    // Non-won source (Closed Lost) with referrals → resume at the recommendation.
    mockSourceDeal({ dealstage: 'closedlost' });
    mockHubspot.crm.deals.basicApi.create.mockResolvedValue({ id: '777' });
    mockGetAssociatedIds.mockResolvedValue(['REF1', 'REF2']);

    const result = await cloneForYear({ sourceDealId: '100', targetYear: 2027 });

    expect(result.success).toBe(true);
    const props = mockHubspot.crm.deals.basicApi.create.mock.calls[0][0].properties;
    expect(props.dealstage).toBe('presentationscheduled'); // recommendationPresented
  });

  test('lands at Tuition Undecided when the source is Closed Won', async () => {
    // Closed Won source (decisionmakerboughtin) → the family already chose this
    // camp; the clone resumes at Tuition Undecided to enter next year's tuition.
    mockSourceDeal({ dealstage: 'decisionmakerboughtin' });
    mockHubspot.crm.deals.basicApi.create.mockResolvedValue({ id: '777' });
    // Referrals present or not shouldn't matter for a won source.
    mockGetAssociatedIds.mockResolvedValue(['REF1', 'REF2']);

    const result = await cloneForYear({ sourceDealId: '100', targetYear: 2027 });

    expect(result.success).toBe(true);
    const props = mockHubspot.crm.deals.basicApi.create.mock.calls[0][0].properties;
    expect(props.dealstage).toBe('1282923123'); // tuitionUndecided
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
    // Source ('100') has one referral; the new deal ('777') has none yet.
    mockFetchReferrals.mockImplementation((id: string) =>
      Promise.resolve(
        id === '100'
          ? [
              {
                id: 'R1',
                company: { id: 'C1', name: 'Camp X' },
                note: 'returning camper',
                // Source status/interest — intentionally NOT carried over.
                outreachStatus: 'Sent',
                clientInterest: 'Selected',
              },
            ]
          : []
      )
    );

    await cloneForYear({ sourceDealId: '100', targetYear: 2027 });

    // The referral was cloned onto the new deal (copyReferralsToClone ran).
    expect(mockHubspot.crm.objects.basicApi.create).toHaveBeenCalledTimes(1);
    expect(mockHubspot.crm.objects.basicApi.create.mock.calls[0][0]).toBe(
      config.objectTypes.referral
    );
    // referral_name is REQUIRED — the create 400s without it. Guard it.
    const refProps =
      mockHubspot.crm.objects.basicApi.create.mock.calls[0][1].properties;
    expect(refProps[config.properties.referral.name]).toBeTruthy();
    // Copied referrals always default to "Don’t send (already sent)" /
    // "Active / considering" for the new year — NOT the source status, and
    // never the snake_case values that 400'd with INVALID_OPTION.
    expect(Object.values(refProps)).toContain(config.defaults.referralStatus);
    expect(Object.values(refProps)).toContain('Active / considering');
    expect(Object.values(refProps)).not.toContain('Sent');
    expect(Object.values(refProps)).not.toContain('Selected');
    expect(Object.values(refProps)).not.toContain('ready_to_send');

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

  test('back-fills a deduped clone idempotently — adds missing camps, no dupes', async () => {
    mockSourceDeal();
    // Ledger already has a clone (888) from a buggy earlier run.
    mockFindLedger.mockResolvedValue({
      source_key: 'CHILD123|2026',
      target_year: 2027,
      new_deal_id: '888',
      created_at: new Date(),
    });
    // Source has two camps (C1, C2); the existing clone already has C1.
    mockFetchReferrals.mockImplementation((id: string) =>
      Promise.resolve(
        id === '100'
          ? [
              { id: 'R1', company: { id: 'C1', name: 'Camp One' }, note: 'a' },
              { id: 'R2', company: { id: 'C2', name: 'Camp Two' }, note: 'b' },
            ]
          : id === '888'
          ? [{ id: 'RX', company: { id: 'C1', name: 'Camp One' }, note: 'a' }]
          : []
      )
    );

    const result = await cloneForYear({ sourceDealId: '100', targetYear: 2027 });

    expect((result as any).deduped).toBe(true);
    expect((result as any).newDealId).toBe('888');
    // Only the missing camp (C2) is cloned — C1 already present, not duplicated.
    expect(mockHubspot.crm.objects.basicApi.create).toHaveBeenCalledTimes(1);
    // The back-filled referral is linked to the existing clone (888).
    expect(
      mockHubspot.crm.associations.v4.basicApi.createDefault.mock.calls
    ).toContainEqual([config.objectTypes.referral, 'NEWREF', 'deals', '888']);
  });
});
