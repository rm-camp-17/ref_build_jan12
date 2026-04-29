/**
 * Unit tests for PATCH /api/deals/[dealId]/loss-reason (spec §4.5, §4.6).
 */

jest.mock('../lib/deals', () => ({
  getDeal: jest.fn(),
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
import { getDeal, updateDeal } from '../lib/deals';
import {
  requireDealAuthorization,
  DealAuthorizationError,
} from '../lib/require-deal-authorization';
import { PATCH } from '../app/api/deals/[dealId]/loss-reason/route';

const mockGetDeal = getDeal as jest.Mock;
const mockUpdateDeal = updateDeal as jest.Mock;
const mockRequireAuth = requireDealAuthorization as jest.Mock;

const CURRENT_YEAR = new Date().getUTCFullYear();

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/deals/100/loss-reason', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateDeal.mockResolvedValue(undefined);
  mockRequireAuth.mockResolvedValue(undefined);
  mockGetDeal.mockResolvedValue({
    id: '100',
    dealstage: 'presentationscheduled',
  });
});

describe('PATCH /api/deals/[dealId]/loss-reason', () => {
  test.each([
    'OTHER_PROGRAM',
    'OUT_OF_MARKET',
    'MONEY',
    'NON_RESPONSIVE',
    'OTHER',
  ])('accepts valid non-WAIT category %s', async (cat) => {
    const req = makeReq({
      closed_lost_category: cat,
      closed_lost_reason: 'reason text',
    });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, advancedToLost: false });
    expect(mockUpdateDeal).toHaveBeenCalledWith(
      '100',
      expect.objectContaining({
        closed_lost_category: cat,
        closed_lost_reason: 'reason text',
      })
    );
  });

  test('rejects invalid category with 400', async () => {
    const req = makeReq({ closed_lost_category: 'BOGUS' });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(400);
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  test('rejects missing category with 400', async () => {
    const req = makeReq({});
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(400);
  });

  test('WAIT_NEXT_YEAR with valid future year writes wait_until_year', async () => {
    const targetYear = CURRENT_YEAR + 1;
    const req = makeReq({
      closed_lost_category: 'WAIT_NEXT_YEAR',
      wait_until_year: targetYear,
    });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(200);
    expect(mockUpdateDeal).toHaveBeenCalledWith(
      '100',
      expect.objectContaining({
        closed_lost_category: 'WAIT_NEXT_YEAR',
        wait_until_year: String(targetYear),
      })
    );
  });

  test('WAIT_NEXT_YEAR with currentYear floors up to currentYear+1', async () => {
    const req = makeReq({
      closed_lost_category: 'WAIT_NEXT_YEAR',
      wait_until_year: CURRENT_YEAR,
    });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(200);
    expect(mockUpdateDeal).toHaveBeenCalledWith(
      '100',
      expect.objectContaining({
        wait_until_year: String(CURRENT_YEAR + 1),
      })
    );
  });

  test('WAIT_NEXT_YEAR with past year rejected with 400', async () => {
    const req = makeReq({
      closed_lost_category: 'WAIT_NEXT_YEAR',
      wait_until_year: CURRENT_YEAR - 1,
    });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('past');
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  test('WAIT_NEXT_YEAR without wait_until_year rejected with 400', async () => {
    const req = makeReq({ closed_lost_category: 'WAIT_NEXT_YEAR' });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('wait_until_year');
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  test('WAIT_NEXT_YEAR with non-integer wait_until_year rejected with 400', async () => {
    const req = makeReq({
      closed_lost_category: 'WAIT_NEXT_YEAR',
      wait_until_year: 'not-a-number',
    });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(400);
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  test('non-WAIT category with wait_until_year rejected with 400 (mismatch)', async () => {
    const req = makeReq({
      closed_lost_category: 'OTHER',
      wait_until_year: CURRENT_YEAR + 1,
    });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toContain('WAIT_NEXT_YEAR');
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  test('setStageToLost=true sets dealstage when not already lost', async () => {
    mockGetDeal.mockResolvedValue({
      id: '100',
      dealstage: 'presentationscheduled',
    });
    const req = makeReq({
      closed_lost_category: 'MONEY',
      setStageToLost: true,
    });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, advancedToLost: true });
    expect(mockUpdateDeal).toHaveBeenCalledWith(
      '100',
      expect.objectContaining({
        closed_lost_category: 'MONEY',
        dealstage: 'closedlost',
      })
    );
  });

  test('setStageToLost=true is a no-op when deal is already closedlost', async () => {
    mockGetDeal.mockResolvedValue({ id: '100', dealstage: 'closedlost' });
    const req = makeReq({
      closed_lost_category: 'MONEY',
      setStageToLost: true,
    });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.advancedToLost).toBe(false);
    const writtenProps = mockUpdateDeal.mock.calls[0][1];
    expect(writtenProps.dealstage).toBeUndefined();
  });

  test('setStageToLost=false (default) does not write dealstage', async () => {
    const req = makeReq({ closed_lost_category: 'MONEY' });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(200);
    const writtenProps = mockUpdateDeal.mock.calls[0][1];
    expect(writtenProps.dealstage).toBeUndefined();
  });

  test('rejects malformed dealId with 400', async () => {
    const req = makeReq({ closed_lost_category: 'OTHER' });
    const res = await PATCH(req, { params: { dealId: 'abc' } });
    expect(res.status).toBe(400);
  });

  test('applies requireDealAuthorization (returns 403 on failure)', async () => {
    mockRequireAuth.mockRejectedValueOnce(
      new DealAuthorizationError('bad sig')
    );
    const req = makeReq({ closed_lost_category: 'OTHER' });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(403);
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  test('returns 500 on updateDeal failure', async () => {
    mockUpdateDeal.mockRejectedValueOnce(new Error('boom'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const req = makeReq({ closed_lost_category: 'OTHER' });
    const res = await PATCH(req, { params: { dealId: '100' } });
    expect(res.status).toBe(500);
    errorSpy.mockRestore();
  });
});
