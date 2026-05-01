/**
 * Tests for /api/webhooks/hubspot/deal route handler.
 *
 * Mocks the two pure handlers + the HMAC verifier so we can drive the
 * dispatch logic without producing real signatures.
 *
 * Coverage:
 *   - Missing HUBSPOT_CLIENT_SECRET → 500 (fail closed)
 *   - HMAC verification failure → 401, no handler runs
 *   - Non-array body → 400
 *   - deal.creation event → mirror runs, spawn does not
 *   - deal.propertyChange · dealstage → both run
 *   - deal.propertyChange · year1 → mirror only
 *   - deal.propertyChange · unrelated property → neither
 */

const mockMirror = jest.fn();
const mockSpawn = jest.fn();
const mockVerifySignature = jest.fn();

jest.mock('../lib/child-year-mirror', () => ({
  mirrorChildYearForDeal: (...args: unknown[]) => mockMirror(...args),
}));
jest.mock('../lib/renewal-spawner', () => ({
  spawnRenewalForDeal: (...args: unknown[]) => mockSpawn(...args),
}));
jest.mock('../lib/require-deal-authorization', () => {
  // Re-export DealAuthorizationError so the route's instanceof check
  // matches our thrown errors. The real class is a normal subclass.
  class DealAuthorizationError extends Error {
    readonly statusCode = 403 as const;
    readonly body: { error: string; reason: string };
    constructor(reason: string) {
      super(reason);
      this.name = 'DealAuthorizationError';
      this.body = { error: 'Forbidden', reason };
      Object.setPrototypeOf(this, DealAuthorizationError.prototype);
    }
  }
  return {
    DealAuthorizationError,
    verifyHubspotSignatureV3: (...args: unknown[]) => mockVerifySignature(...args),
  };
});

import { NextRequest } from 'next/server';
import { POST } from '../app/api/webhooks/hubspot/deal/route';

const ORIGINAL_SECRET = process.env.HUBSPOT_CLIENT_SECRET;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.HUBSPOT_CLIENT_SECRET = 'test-secret';
  mockVerifySignature.mockResolvedValue(undefined);
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.HUBSPOT_CLIENT_SECRET;
  } else {
    process.env.HUBSPOT_CLIENT_SECRET = ORIGINAL_SECRET;
  }
});

function buildRequest(body: unknown): NextRequest {
  return new NextRequest(
    new Request('http://localhost/api/webhooks/hubspot/deal', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

describe('webhook · auth', () => {
  test('returns 500 when HUBSPOT_CLIENT_SECRET is unset', async () => {
    delete process.env.HUBSPOT_CLIENT_SECRET;
    const res = await POST(buildRequest([]));
    expect(res.status).toBe(500);
    expect(mockVerifySignature).not.toHaveBeenCalled();
    expect(mockMirror).not.toHaveBeenCalled();
  });

  test('returns 401 when HMAC verification throws', async () => {
    const { DealAuthorizationError } = jest.requireMock(
      '../lib/require-deal-authorization'
    ) as any;
    mockVerifySignature.mockRejectedValueOnce(
      new DealAuthorizationError('bad sig')
    );
    const res = await POST(buildRequest([]));
    expect(res.status).toBe(401);
    expect(mockMirror).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('webhook · body shape', () => {
  test('returns 400 when body is not an array', async () => {
    const res = await POST(buildRequest({ not: 'an array' }));
    expect(res.status).toBe(400);
  });

  test('returns 200 with empty outcomes when array is empty', async () => {
    const res = await POST(buildRequest([]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number };
    expect(body.processed).toBe(0);
  });
});

describe('webhook · dispatch', () => {
  test('deal.creation runs mirror, not spawn', async () => {
    mockMirror.mockResolvedValue({
      childId: 'C1',
      computedYear: 2026,
      previousYear: null,
      wrote: true,
      reason: 'updated',
    });
    const res = await POST(
      buildRequest([
        {
          eventId: 1,
          subscriptionType: 'deal.creation',
          objectId: 999,
        },
      ])
    );
    expect(res.status).toBe(200);
    expect(mockMirror).toHaveBeenCalledWith('999');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test('deal.propertyChange · dealstage runs both handlers', async () => {
    mockMirror.mockResolvedValue({
      childId: 'C1',
      computedYear: 2026,
      previousYear: 2025,
      wrote: true,
      reason: 'updated',
    });
    mockSpawn.mockResolvedValue({
      sourceDealId: '999',
      reason: 'created',
      targetYear: 2027,
      newDealId: 'NEW1',
      commissionLogicType: 'yearly',
    });
    const res = await POST(
      buildRequest([
        {
          eventId: 2,
          subscriptionType: 'deal.propertyChange',
          propertyName: 'dealstage',
          objectId: 999,
        },
      ])
    );
    expect(res.status).toBe(200);
    expect(mockMirror).toHaveBeenCalledWith('999');
    expect(mockSpawn).toHaveBeenCalledWith('999');
  });

  test('deal.propertyChange · year1 runs mirror only', async () => {
    mockMirror.mockResolvedValue({
      childId: 'C1',
      computedYear: null,
      previousYear: null,
      wrote: false,
      reason: 'no-active-deals',
    });
    await POST(
      buildRequest([
        {
          eventId: 3,
          subscriptionType: 'deal.propertyChange',
          propertyName: 'year1',
          objectId: 42,
        },
      ])
    );
    expect(mockMirror).toHaveBeenCalledWith('42');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test('deal.propertyChange · unrelated property runs neither handler', async () => {
    await POST(
      buildRequest([
        {
          eventId: 4,
          subscriptionType: 'deal.propertyChange',
          propertyName: 'amount',
          objectId: 42,
        },
      ])
    );
    expect(mockMirror).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test('one event throwing does not stop the rest', async () => {
    mockMirror.mockResolvedValueOnce({
      childId: 'C1',
      computedYear: 2026,
      previousYear: null,
      wrote: true,
      reason: 'updated',
    });
    mockMirror.mockRejectedValueOnce(new Error('hubspot 500'));
    mockMirror.mockResolvedValueOnce({
      childId: 'C2',
      computedYear: 2027,
      previousYear: null,
      wrote: true,
      reason: 'updated',
    });

    const res = await POST(
      buildRequest([
        { eventId: 1, subscriptionType: 'deal.creation', objectId: 1 },
        { eventId: 2, subscriptionType: 'deal.creation', objectId: 2 },
        { eventId: 3, subscriptionType: 'deal.creation', objectId: 3 },
      ])
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { processed: number; outcomes: any[] };
    expect(body.processed).toBe(3);
    expect(body.outcomes[1].error).toContain('hubspot 500');
    expect(body.outcomes[2].mirrorReason).toBe('updated');
  });
});
