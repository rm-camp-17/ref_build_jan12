/**
 * Unit tests for requireUnlocked — UNIFIED_CARD_SPEC.md §5.1.
 *
 * Mocks the global `fetch` so we can exercise every soft-fail path
 * without hitting the network.
 */

import {
  requireUnlocked,
  RequireUnlockedError,
  SACRED_FIELDS,
  hasSacredField,
} from '../lib/require-unlocked';

const ORIGINAL_ENV = { ...process.env };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('requireUnlocked', () => {
  let fetchMock: jest.Mock;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.CE_BILLING_API_URL;
    delete process.env.CARD_API_KEY;

    fetchMock = jest.fn();
    (globalThis as any).fetch = fetchMock;

    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env = { ...ORIGINAL_ENV };
  });

  it('exports the canonical SACRED_FIELDS list', () => {
    expect(SACRED_FIELDS).toEqual([
      'expertprofile',
      'referred_by',
      'split_type',
      'deal_split_email',
      'deal_split_pct',
      'tuition_at_enrollment',
      'lengthofstay',
    ]);
  });

  it('hasSacredField detects sacred + non-sacred', () => {
    expect(hasSacredField([])).toBe(false);
    expect(hasSacredField(['dealstage'])).toBe(false);
    expect(hasSacredField(['dealstage', 'expertprofile'])).toBe(true);
    expect(hasSacredField(['lengthofstay'])).toBe(true);
  });

  it('returns without throwing when CE_BILLING_API_URL is not set (soft fail)', async () => {
    delete process.env.CE_BILLING_API_URL;
    await expect(
      requireUnlocked('123', ['expertprofile'])
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CE_BILLING_API_URL not set')
    );
  });

  it('does not call ce-billing if no sacred fields are being mutated (short-circuits)', async () => {
    process.env.CE_BILLING_API_URL = 'https://ce-billing.example.com';
    await expect(
      requireUnlocked('123', ['dealstage', 'closed_lost_reason'])
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns without throwing when ce-billing returns { locked: false }', async () => {
    process.env.CE_BILLING_API_URL = 'https://ce-billing.example.com';
    fetchMock.mockResolvedValue(jsonResponse(200, { locked: false }));

    await expect(
      requireUnlocked('123', ['expertprofile'])
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe(
      'https://ce-billing.example.com/api/health/check-locked?dealId=123'
    );
    expect(calledOpts.method).toBe('GET');
  });

  it('strips trailing slash from CE_BILLING_API_URL', async () => {
    process.env.CE_BILLING_API_URL = 'https://ce-billing.example.com/';
    fetchMock.mockResolvedValue(jsonResponse(200, { locked: false }));
    await requireUnlocked('123', ['expertprofile']);
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(calledUrl).toBe(
      'https://ce-billing.example.com/api/health/check-locked?dealId=123'
    );
  });

  it('sends X-Card-API-Key when CARD_API_KEY is set', async () => {
    process.env.CE_BILLING_API_URL = 'https://ce-billing.example.com';
    process.env.CARD_API_KEY = 'secret-key';
    fetchMock.mockResolvedValue(jsonResponse(200, { locked: false }));

    await requireUnlocked('123', ['expertprofile']);
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)['X-Card-API-Key']).toBe(
      'secret-key'
    );
  });

  it('throws RequireUnlockedError when locked=true and a sacred field is being mutated', async () => {
    process.env.CE_BILLING_API_URL = 'https://ce-billing.example.com';
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        locked: true,
        reason: 'commission already paid',
      })
    );

    await expect(
      requireUnlocked('123', ['tuition_at_enrollment'])
    ).rejects.toMatchObject({
      statusCode: 409,
      body: { locked: true, reason: 'commission already paid' },
    });

    // confirm it's the right class
    try {
      await requireUnlocked('123', ['tuition_at_enrollment']);
    } catch (err) {
      expect(err).toBeInstanceOf(RequireUnlockedError);
    }
  });

  it('throws RequireUnlockedError without reason when ce-billing omits it', async () => {
    process.env.CE_BILLING_API_URL = 'https://ce-billing.example.com';
    fetchMock.mockResolvedValue(jsonResponse(200, { locked: true }));

    let caught: unknown;
    try {
      await requireUnlocked('123', ['expertprofile']);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RequireUnlockedError);
    expect((caught as RequireUnlockedError).body).toEqual({ locked: true });
  });

  it('does NOT throw when locked=true but no sacred fields are being mutated', async () => {
    process.env.CE_BILLING_API_URL = 'https://ce-billing.example.com';
    // Sacred-field check short-circuits BEFORE the fetch, so this also
    // verifies fetch isn't called for non-sacred mutations.
    await expect(
      requireUnlocked('123', ['closed_won_reason', 'dealstage'])
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('soft-fails (no throw) on network error', async () => {
    process.env.CE_BILLING_API_URL = 'https://ce-billing.example.com';
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      requireUnlocked('123', ['expertprofile'])
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('network error'),
      expect.anything()
    );
  });

  it('soft-fails (no throw) on AbortError / timeout', async () => {
    process.env.CE_BILLING_API_URL = 'https://ce-billing.example.com';
    const abortErr = Object.assign(new Error('aborted'), {
      name: 'AbortError',
    });
    fetchMock.mockRejectedValue(abortErr);

    await expect(
      requireUnlocked('123', ['expertprofile'])
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('timed out')
    );
  });

  it('soft-fails (no throw) on non-2xx response', async () => {
    process.env.CE_BILLING_API_URL = 'https://ce-billing.example.com';
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'oops' }));

    await expect(
      requireUnlocked('123', ['expertprofile'])
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('returned 500')
    );
  });

  it('soft-fails (no throw) on malformed JSON response', async () => {
    process.env.CE_BILLING_API_URL = 'https://ce-billing.example.com';
    const badResp = new Response('not-json', { status: 200 });
    fetchMock.mockResolvedValue(badResp);

    await expect(
      requireUnlocked('123', ['expertprofile'])
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('non-JSON'),
      expect.anything()
    );
  });

  it('passes a 5-second AbortSignal to fetch', async () => {
    process.env.CE_BILLING_API_URL = 'https://ce-billing.example.com';
    fetchMock.mockResolvedValue(jsonResponse(200, { locked: false }));

    await requireUnlocked('123', ['expertprofile']);
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});
