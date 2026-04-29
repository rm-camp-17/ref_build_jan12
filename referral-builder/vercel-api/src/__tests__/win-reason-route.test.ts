/**
 * Unit tests for PATCH /api/deals/[dealId]/win-reason (spec §4.4).
 */

jest.mock('../lib/deals', () => ({
  updateDeal: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/require-unlocked', () => {
  class RequireUnlockedError extends Error {
    statusCode = 409 as const;
    body: { locked: true; reason?: string };
    constructor(reason?: string) {
      super(reason ?? 'locked');
      this.body = { locked: true, ...(reason ? { reason } : {}) };
    }
  }
  return {
    requireUnlocked: jest.fn().mockResolvedValue(undefined),
    RequireUnlockedError,
  };
});

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
import { updateDeal } from '../lib/deals';
import {
  requireUnlocked,
  RequireUnlockedError,
} from '../lib/require-unlocked';
import {
  requireDealAuthorization,
  DealAuthorizationError,
} from '../lib/require-deal-authorization';
import { PATCH } from '../app/api/deals/[dealId]/win-reason/route';

const mockUpdateDeal = updateDeal as jest.Mock;
const mockRequireUnlocked = requireUnlocked as jest.Mock;
const mockRequireAuth = requireDealAuthorization as jest.Mock;

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/deals/100/win-reason', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateDeal.mockResolvedValue(undefined);
  mockRequireUnlocked.mockResolvedValue(undefined);
  mockRequireAuth.mockResolvedValue(undefined);
});

describe('PATCH /api/deals/[dealId]/win-reason', () => {
  test('valid PATCH writes category + reason and returns success', async () => {
    const req = makeReq({
      closed_won_category: 'RETURNING',
      closed_won_reason: 'Family came back from last year',
    });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
    expect(mockUpdateDeal).toHaveBeenCalledWith('100', {
      closed_won_category: 'RETURNING',
      closed_won_reason: 'Family came back from last year',
    });
  });

  test('valid PATCH without reason writes only category', async () => {
    const req = makeReq({ closed_won_category: 'NEW_PLACEMENT' });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(200);
    expect(mockUpdateDeal).toHaveBeenCalledWith('100', {
      closed_won_category: 'NEW_PLACEMENT',
    });
  });

  test.each([
    'RETURNING',
    'NEW_PLACEMENT',
    'REFERRAL_DRIVEN',
    'CO_WORK',
    'OTHER',
  ])('accepts valid category %s', async (cat) => {
    const req = makeReq({ closed_won_category: cat });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(200);
  });

  test('rejects invalid category with 400', async () => {
    const req = makeReq({ closed_won_category: 'BOGUS' });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.message).toContain('closed_won_category');
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  test('rejects missing category with 400', async () => {
    const req = makeReq({});
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(400);
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  test('rejects malformed dealId with 400', async () => {
    const req = makeReq({ closed_won_category: 'RETURNING' });
    const res = await PATCH(req, { params: { dealId: 'abc' } });
    expect(res.status).toBe(400);
  });

  test('rejects invalid JSON with 400', async () => {
    const req = new NextRequest('http://localhost/api/deals/100/win-reason', {
      method: 'PATCH',
      body: 'not-json',
      headers: { 'content-type': 'application/json' },
    });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(400);
  });

  test('applies requireDealAuthorization (returns 403 on failure)', async () => {
    mockRequireAuth.mockRejectedValueOnce(
      new DealAuthorizationError('bad sig')
    );
    const req = makeReq({ closed_won_category: 'RETURNING' });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(403);
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  test('applies requireUnlocked (with empty mutating fields, pattern stays uniform)', async () => {
    const req = makeReq({ closed_won_category: 'RETURNING' });
    await PATCH(req, { params: { dealId: '100' } });
    expect(mockRequireUnlocked).toHaveBeenCalledWith('100', []);
  });

  test('returns 409 when requireUnlocked throws (defensive — closed_won_* aren\'t sacred so this is unlikely)', async () => {
    mockRequireUnlocked.mockRejectedValueOnce(
      new RequireUnlockedError('locked by billing')
    );
    const req = makeReq({ closed_won_category: 'RETURNING' });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(409);
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  test('returns 500 on unexpected updateDeal error', async () => {
    mockUpdateDeal.mockRejectedValueOnce(new Error('hubspot down'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const req = makeReq({ closed_won_category: 'RETURNING' });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    errorSpy.mockRestore();
  });
});
