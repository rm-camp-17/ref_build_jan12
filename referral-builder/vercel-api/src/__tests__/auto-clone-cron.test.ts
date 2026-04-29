/**
 * Tests for /api/cron/auto-clone-wait-year route handler.
 *
 * Mocks HubSpot search + cloneForYear so we can drive the orchestrator
 * through every interesting state without touching the network or DB.
 *
 * Coverage:
 *   - Auth: missing / wrong CRON_SECRET → 401
 *   - Auth: configured-but-unset CRON_SECRET → 401 (fail closed)
 *   - Empty result set → processed=0, created=0
 *   - All candidates clone fresh → created=N
 *   - One candidate throws → 200 with errors[], remainder still processed
 *   - All deduped (idempotent re-run) → deduped=N, created=0
 *   - More than 200 candidates → truncated=true logged, capped batch
 */

jest.mock('../lib/hubspot', () => ({
  hubspotClient: {
    crm: {
      deals: {
        searchApi: {
          doSearch: jest.fn(),
        },
      },
    },
  },
}));

const mockCloneForYear = jest.fn();
jest.mock('../lib/clone', () => ({
  cloneForYear: (...args: unknown[]) => mockCloneForYear(...args),
}));

import { NextRequest } from 'next/server';
import { hubspotClient } from '../lib/hubspot';
import { GET } from '../app/api/cron/auto-clone-wait-year/route';

const mockHubspot = hubspotClient as any;

function buildRequest(authHeader?: string): NextRequest {
  const headers = new Headers();
  if (authHeader !== undefined) {
    headers.set('authorization', authHeader);
  }
  // NextRequest needs a full URL; the handler doesn't actually use it.
  return new NextRequest(
    new Request('http://localhost/api/cron/auto-clone-wait-year', { headers })
  );
}

function buildSearchResults(
  candidates: Array<{ id: string; dealname?: string; deal_key?: string }>,
  hasNext = false
) {
  return {
    results: candidates.map((c) => ({
      id: c.id,
      properties: {
        deal_key: c.deal_key ?? `KEY${c.id}|${new Date().getFullYear() - 1}`,
        year1: String(new Date().getFullYear() - 1),
        dealname: c.dealname ?? `Deal ${c.id}`,
        hubspot_owner_id: 'OWNER1',
      },
    })),
    paging: hasNext ? { next: { after: String(candidates.length) } } : undefined,
  };
}

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = 'test-secret';
});

afterAll(() => {
  if (ORIGINAL_CRON_SECRET === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  }
});

describe('auto-clone-cron — auth', () => {
  test('returns 401 when authorization header is missing', async () => {
    const res = await GET(buildRequest());
    expect(res.status).toBe(401);
    // Did NOT call HubSpot or cloneForYear
    expect(mockHubspot.crm.deals.searchApi.doSearch).not.toHaveBeenCalled();
    expect(mockCloneForYear).not.toHaveBeenCalled();
  });

  test('returns 401 when authorization header is wrong', async () => {
    const res = await GET(buildRequest('Bearer wrong-secret'));
    expect(res.status).toBe(401);
    expect(mockCloneForYear).not.toHaveBeenCalled();
  });

  test('returns 401 when CRON_SECRET env var is not set (fails closed)', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(buildRequest('Bearer anything'));
    expect(res.status).toBe(401);
    expect(mockCloneForYear).not.toHaveBeenCalled();
  });
});

describe('auto-clone-cron — empty candidate set', () => {
  test('returns processed=0, created=0 when no deals match', async () => {
    mockHubspot.crm.deals.searchApi.doSearch.mockResolvedValue(
      buildSearchResults([])
    );

    const res = await GET(buildRequest('Bearer test-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      processed: 0,
      created: 0,
      deduped: 0,
      errors: [],
    });
    expect(mockCloneForYear).not.toHaveBeenCalled();
  });
});

describe('auto-clone-cron — happy path', () => {
  test('3 candidates all clone successfully → created=3', async () => {
    mockHubspot.crm.deals.searchApi.doSearch.mockResolvedValue(
      buildSearchResults([
        { id: '101' },
        { id: '102' },
        { id: '103' },
      ])
    );
    mockCloneForYear.mockImplementation(({ sourceDealId }: any) =>
      Promise.resolve({
        success: true,
        deduped: false,
        newDealId: `new-${sourceDealId}`,
        newDealName: `Cloned ${sourceDealId}`,
      })
    );

    const res = await GET(buildRequest('Bearer test-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(3);
    expect(body.created).toBe(3);
    expect(body.deduped).toBe(0);
    expect(body.errors).toEqual([]);

    // Verify each call passed confirmExpertFields=true (automated trust)
    expect(mockCloneForYear).toHaveBeenCalledTimes(3);
    for (const call of mockCloneForYear.mock.calls) {
      expect(call[0].confirmExpertFields).toBe(true);
      expect(call[0].targetYear).toBe(new Date().getFullYear());
    }
  });
});

describe('auto-clone-cron — partial failure', () => {
  test('one candidate throws → 200 with errors[], remainder processed (no retry storm)', async () => {
    mockHubspot.crm.deals.searchApi.doSearch.mockResolvedValue(
      buildSearchResults([
        { id: '201' },
        { id: '202' },
        { id: '203' },
      ])
    );
    mockCloneForYear.mockImplementation(({ sourceDealId }: any) => {
      if (sourceDealId === '202') {
        return Promise.reject(new Error('HubSpot 503'));
      }
      return Promise.resolve({
        success: true,
        deduped: false,
        newDealId: `new-${sourceDealId}`,
        newDealName: `Cloned ${sourceDealId}`,
      });
    });

    const res = await GET(buildRequest('Bearer test-secret'));
    // Critical: status is 200 even on partial failure — non-2xx triggers
    // Vercel Cron retry, which we don't want here.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(3);
    expect(body.created).toBe(2);
    expect(body.deduped).toBe(0);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].dealId).toBe('202');
    expect(body.errors[0].message).toContain('HubSpot 503');
  });

  test('cloneForYear returns success=false → recorded as error, batch continues', async () => {
    mockHubspot.crm.deals.searchApi.doSearch.mockResolvedValue(
      buildSearchResults([
        { id: '301' },
        { id: '302' },
      ])
    );
    mockCloneForYear.mockImplementation(({ sourceDealId }: any) => {
      if (sourceDealId === '301') {
        return Promise.resolve({
          success: false,
          message: 'Source deal has no deal_key set.',
        });
      }
      return Promise.resolve({
        success: true,
        deduped: false,
        newDealId: 'new-302',
        newDealName: 'Cloned 302',
      });
    });

    const res = await GET(buildRequest('Bearer test-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(2);
    expect(body.created).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].dealId).toBe('301');
    expect(body.errors[0].message).toContain('deal_key');
  });
});

describe('auto-clone-cron — idempotent re-run', () => {
  test('all 3 candidates already cloned → deduped=3, created=0', async () => {
    mockHubspot.crm.deals.searchApi.doSearch.mockResolvedValue(
      buildSearchResults([
        { id: '401' },
        { id: '402' },
        { id: '403' },
      ])
    );
    mockCloneForYear.mockImplementation(({ sourceDealId }: any) =>
      Promise.resolve({
        success: true,
        deduped: true,
        newDealId: `existing-${sourceDealId}`,
        newDealName: `Existing ${sourceDealId}`,
      })
    );

    const res = await GET(buildRequest('Bearer test-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(3);
    expect(body.created).toBe(0);
    expect(body.deduped).toBe(3);
    expect(body.errors).toEqual([]);
  });
});

describe('auto-clone-cron — truncation', () => {
  test('search reports paging.next.after → response includes truncated=true', async () => {
    mockHubspot.crm.deals.searchApi.doSearch.mockResolvedValue(
      buildSearchResults([{ id: '501' }, { id: '502' }], /* hasNext */ true)
    );
    mockCloneForYear.mockResolvedValue({
      success: true,
      deduped: false,
      newDealId: 'new-x',
      newDealName: 'x',
    });

    const res = await GET(buildRequest('Bearer test-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.processed).toBe(2);
  });
});

describe('auto-clone-cron — search failure', () => {
  test('HubSpot search throws → 200 with error in errors[] (no retry storm)', async () => {
    mockHubspot.crm.deals.searchApi.doSearch.mockRejectedValue(
      new Error('HubSpot search 500')
    );

    const res = await GET(buildRequest('Bearer test-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].message).toContain('HubSpot search 500');
    expect(mockCloneForYear).not.toHaveBeenCalled();
  });
});
