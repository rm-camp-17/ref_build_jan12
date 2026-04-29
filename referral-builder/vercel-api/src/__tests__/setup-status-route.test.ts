/**
 * Unit tests for GET /api/deals/[dealId]/setup-status (spec §4.1).
 *
 * Mocks lib/deals + lib/associations + lib/require-deal-authorization so
 * the route's branching (deal not found, all-associated, none-associated,
 * partial) can be tested without HubSpot.
 */

jest.mock('../lib/deals', () => ({
  getDeal: jest.fn(),
}));

jest.mock('../lib/associations', () => ({
  getAssociatedIds: jest.fn(),
}));

jest.mock('../lib/require-deal-authorization', () => {
  class DealAuthorizationError extends Error {
    statusCode = 403 as const;
    body: { error: string; reason: string };
    constructor(reason: string) {
      super(reason);
      this.body = { error: 'Forbidden', reason };
    }
  }
  return {
    requireDealAuthorization: jest.fn().mockResolvedValue(undefined),
    DealAuthorizationError,
  };
});

import { NextRequest } from 'next/server';
import { getDeal } from '../lib/deals';
import { getAssociatedIds } from '../lib/associations';
import {
  requireDealAuthorization,
  DealAuthorizationError,
} from '../lib/require-deal-authorization';
import { GET } from '../app/api/deals/[dealId]/setup-status/route';

const mockGetDeal = getDeal as jest.Mock;
const mockGetAssociatedIds = getAssociatedIds as jest.Mock;
const mockRequireAuth = requireDealAuthorization as jest.Mock;

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/deals/100/setup-status', {
    method: 'GET',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireAuth.mockResolvedValue(undefined);
});

describe('GET /api/deals/[dealId]/setup-status', () => {
  test('rejects malformed dealId with 400', async () => {
    const req = new NextRequest(
      'http://localhost/api/deals/abc/setup-status',
      { method: 'GET' }
    );
    const res = await GET(req, { params: { dealId: 'abc' } });
    expect(res.status).toBe(400);
  });

  test('returns 404 when deal not found', async () => {
    mockGetDeal.mockResolvedValue(null);
    mockGetAssociatedIds.mockResolvedValue([]);

    const res = await GET(makeReq(), { params: { dealId: '100' } });
    expect(res.status).toBe(404);
  });

  test('all three associated → isReady true', async () => {
    mockGetDeal.mockResolvedValue({
      id: '100',
      dealname: 'Smith | 2026',
      year1: '2026',
      hubspot_owner_id: 'OWNER1',
    });
    mockGetAssociatedIds
      .mockResolvedValueOnce(['CHILD1']) // child
      .mockResolvedValueOnce(['HH1']) // household
      .mockResolvedValueOnce(['CONTACT1', 'CONTACT2']); // contacts

    const res = await GET(makeReq(), { params: { dealId: '100' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      dealname: 'Smith | 2026',
      year1: '2026',
      hubspot_owner_id: 'OWNER1',
      child: { associated: true, count: 1, ids: ['CHILD1'] },
      household: { associated: true, count: 1, ids: ['HH1'] },
      contacts: { associated: true, count: 2, ids: ['CONTACT1', 'CONTACT2'] },
      isReady: true,
    });
  });

  test('none associated → isReady false, all empty', async () => {
    mockGetDeal.mockResolvedValue({
      id: '100',
      dealname: 'Smith | 2026',
      year1: '2026',
      hubspot_owner_id: null,
    });
    mockGetAssociatedIds.mockResolvedValue([]);

    const res = await GET(makeReq(), { params: { dealId: '100' } });
    const body = await res.json();
    expect(body.isReady).toBe(false);
    expect(body.child).toEqual({ associated: false, count: 0, ids: [] });
    expect(body.household).toEqual({ associated: false, count: 0, ids: [] });
    expect(body.contacts).toEqual({ associated: false, count: 0, ids: [] });
  });

  test('mixed (child+household but no contacts) → isReady false', async () => {
    mockGetDeal.mockResolvedValue({
      id: '100',
      dealname: 'Smith | 2026',
      year1: '2026',
      hubspot_owner_id: 'OWNER1',
    });
    mockGetAssociatedIds
      .mockResolvedValueOnce(['CHILD1'])
      .mockResolvedValueOnce(['HH1'])
      .mockResolvedValueOnce([]);

    const res = await GET(makeReq(), { params: { dealId: '100' } });
    const body = await res.json();
    expect(body.isReady).toBe(false);
    expect(body.child.associated).toBe(true);
    expect(body.household.associated).toBe(true);
    expect(body.contacts.associated).toBe(false);
  });

  test('queries the three correct object types', async () => {
    mockGetDeal.mockResolvedValue({
      id: '100',
      dealname: 'X',
      year1: '2026',
      hubspot_owner_id: null,
    });
    mockGetAssociatedIds.mockResolvedValue([]);

    await GET(makeReq(), { params: { dealId: '100' } });

    const calls = mockGetAssociatedIds.mock.calls;
    expect(calls).toHaveLength(3);
    const toTypes = calls.map((c) => c[2]);
    expect(toTypes).toContain('2-50911061'); // child
    expect(toTypes).toContain('2-53610744'); // household
    expect(toTypes).toContain('contacts');
  });

  test('rejects with 403 when requireDealAuthorization fails', async () => {
    mockRequireAuth.mockRejectedValueOnce(
      new DealAuthorizationError('bad sig')
    );

    const res = await GET(makeReq(), { params: { dealId: '100' } });
    expect(res.status).toBe(403);
    expect(mockGetDeal).not.toHaveBeenCalled();
  });

  test('returns 500 on unexpected getDeal error', async () => {
    mockGetDeal.mockRejectedValue(new Error('boom'));
    mockGetAssociatedIds.mockResolvedValue([]);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(makeReq(), { params: { dealId: '100' } });
    expect(res.status).toBe(500);
    errorSpy.mockRestore();
  });
});
