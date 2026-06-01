/**
 * Unit tests for POST /api/deals/[dealId]/advance-stage (spec §4.1, §4.6).
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
  requireDealAuthorization,
  DealAuthorizationError,
} from '../lib/require-deal-authorization';
import { POST } from '../app/api/deals/[dealId]/advance-stage/route';

const mockUpdateDeal = updateDeal as jest.Mock;
const mockRequireAuth = requireDealAuthorization as jest.Mock;

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/deals/100/advance-stage', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateDeal.mockResolvedValue(undefined);
  mockRequireAuth.mockResolvedValue(undefined);
});

describe('POST /api/deals/[dealId]/advance-stage', () => {
  test.each(['appointmentscheduled', 'presentationscheduled', 'closedlost'])(
    'accepts toStage=%s and writes dealstage',
    async (stage) => {
      const req = makeReq({ toStage: stage });
      const res = await POST(req, { params: { dealId: '100' } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ success: true });
      expect(mockUpdateDeal).toHaveBeenCalledWith('100', { dealstage: stage });
    }
  );

  test('rejects unknown toStage with 400', async () => {
    const req = makeReq({ toStage: 'qualifiedtobuy' });
    const res = await POST(req, { params: { dealId: '100' } });
    expect(res.status).toBe(400);
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  test('rejects missing toStage with 400', async () => {
    const req = makeReq({});
    const res = await POST(req, { params: { dealId: '100' } });
    expect(res.status).toBe(400);
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  test('rejects malformed dealId with 400', async () => {
    const req = makeReq({ toStage: 'closedlost' });
    const res = await POST(req, { params: { dealId: 'abc' } });
    expect(res.status).toBe(400);
  });

  test('applies requireDealAuthorization (returns 403 on failure)', async () => {
    mockRequireAuth.mockRejectedValueOnce(
      new DealAuthorizationError('bad sig')
    );
    const req = makeReq({ toStage: 'closedlost' });
    const res = await POST(req, { params: { dealId: '100' } });
    expect(res.status).toBe(403);
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  test('returns 500 on updateDeal failure', async () => {
    mockUpdateDeal.mockRejectedValueOnce(new Error('boom'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const req = makeReq({ toStage: 'closedlost' });
    const res = await POST(req, { params: { dealId: '100' } });
    expect(res.status).toBe(500);
    errorSpy.mockRestore();
  });
});
