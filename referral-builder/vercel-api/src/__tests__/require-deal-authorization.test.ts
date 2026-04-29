/**
 * Unit tests for requireDealAuthorization — UNIFIED_CARD_SPEC.md §6.1.
 *
 * Implementation is degraded (HMAC v3 signature verification) — the
 * full bound-deal check is a Phase 4 follow-up. Tests cover what's
 * actually implemented:
 *
 *   - Default behavior (STRICT_DEAL_AUTH != 'true') — no-op
 *   - Strict mode without HUBSPOT_CLIENT_SECRET — rejects
 *   - Strict mode without signature header — rejects
 *   - Strict mode without timestamp header — rejects
 *   - Strict mode with stale timestamp — rejects
 *   - Strict mode with valid HMAC — passes
 *   - Strict mode with tampered body — rejects
 */

import crypto from 'crypto';
import {
  requireDealAuthorization,
  DealAuthorizationError,
  __resetLooseAuthWarning,
} from '../lib/require-deal-authorization';

const ORIGINAL_ENV = { ...process.env };

interface MockReqOpts {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
}

function mockReq(opts: MockReqOpts = {}): any {
  const headerMap = new Map<string, string>();
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    headerMap.set(k.toLowerCase(), v);
  }
  return {
    url: opts.url ?? 'https://card-api.example.com/api/v2/deal/123/select-session',
    method: opts.method ?? 'POST',
    headers: {
      get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
    },
  };
}

function signRequest(opts: {
  method: string;
  url: string;
  body: string;
  timestamp: number;
  secret: string;
}): string {
  const stringToSign = `${opts.method}${opts.url}${opts.body}${opts.timestamp}`;
  return crypto
    .createHmac('sha256', opts.secret)
    .update(stringToSign, 'utf8')
    .digest('base64');
}

describe('requireDealAuthorization', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.STRICT_DEAL_AUTH;
    delete process.env.HUBSPOT_CLIENT_SECRET;
    process.env.NODE_ENV = 'test';
    __resetLooseAuthWarning();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
    process.env = { ...ORIGINAL_ENV };
  });

  describe('default behavior (STRICT_DEAL_AUTH disabled)', () => {
    it('returns without throwing when STRICT_DEAL_AUTH is unset', async () => {
      await expect(
        requireDealAuthorization(mockReq(), '123')
      ).resolves.toBeUndefined();
    });

    it('returns without throwing when STRICT_DEAL_AUTH is "false"', async () => {
      process.env.STRICT_DEAL_AUTH = 'false';
      await expect(
        requireDealAuthorization(mockReq(), '123')
      ).resolves.toBeUndefined();
    });

    it('logs a one-time warning per process about loose auth', async () => {
      __resetLooseAuthWarning();
      await requireDealAuthorization(mockReq(), '123');
      await requireDealAuthorization(mockReq(), '456');
      // Only the first call should warn
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('strict deal auth disabled')
      );
    });
  });

  describe('strict mode (STRICT_DEAL_AUTH=true)', () => {
    beforeEach(() => {
      process.env.STRICT_DEAL_AUTH = 'true';
    });

    it('throws DealAuthorizationError when HUBSPOT_CLIENT_SECRET is missing', async () => {
      delete process.env.HUBSPOT_CLIENT_SECRET;
      const req = mockReq();
      await expect(requireDealAuthorization(req, '123')).rejects.toMatchObject(
        {
          statusCode: 403,
        }
      );
    });

    it('throws when X-HubSpot-Signature-v3 is missing', async () => {
      process.env.HUBSPOT_CLIENT_SECRET = 'shh';
      const req = mockReq({
        headers: {
          'x-hubspot-request-timestamp': String(Date.now()),
        },
      });
      await expect(
        requireDealAuthorization(req, '123', '{}')
      ).rejects.toBeInstanceOf(DealAuthorizationError);
    });

    it('throws when X-HubSpot-Request-Timestamp is missing', async () => {
      process.env.HUBSPOT_CLIENT_SECRET = 'shh';
      const req = mockReq({
        headers: { 'x-hubspot-signature-v3': 'whatever' },
      });
      await expect(
        requireDealAuthorization(req, '123', '{}')
      ).rejects.toBeInstanceOf(DealAuthorizationError);
    });

    it('throws when timestamp is non-numeric', async () => {
      process.env.HUBSPOT_CLIENT_SECRET = 'shh';
      const req = mockReq({
        headers: {
          'x-hubspot-signature-v3': 'whatever',
          'x-hubspot-request-timestamp': 'not-a-number',
        },
      });
      await expect(
        requireDealAuthorization(req, '123', '{}')
      ).rejects.toBeInstanceOf(DealAuthorizationError);
    });

    it('throws when timestamp is older than 5 minutes', async () => {
      process.env.HUBSPOT_CLIENT_SECRET = 'shh';
      const staleTs = Date.now() - 10 * 60 * 1_000; // 10 min ago
      const url = 'https://card-api.example.com/api/v2/deal/123/select-session';
      const body = '{}';
      const sig = signRequest({
        method: 'POST',
        url,
        body,
        timestamp: staleTs,
        secret: 'shh',
      });
      const req = mockReq({
        url,
        headers: {
          'x-hubspot-signature-v3': sig,
          'x-hubspot-request-timestamp': String(staleTs),
        },
      });
      await expect(
        requireDealAuthorization(req, '123', body)
      ).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('throws when HMAC signature does not match', async () => {
      process.env.HUBSPOT_CLIENT_SECRET = 'shh';
      const ts = Date.now();
      const url = 'https://card-api.example.com/api/v2/deal/123/select-session';
      const body = '{"sessionId":"99"}';
      const wrongSig = signRequest({
        method: 'POST',
        url,
        body,
        timestamp: ts,
        secret: 'WRONG-SECRET',
      });
      const req = mockReq({
        url,
        headers: {
          'x-hubspot-signature-v3': wrongSig,
          'x-hubspot-request-timestamp': String(ts),
        },
      });
      await expect(
        requireDealAuthorization(req, '123', body)
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('passes for a valid HMAC signature', async () => {
      process.env.HUBSPOT_CLIENT_SECRET = 'shh';
      const ts = Date.now();
      const url = 'https://card-api.example.com/api/v2/deal/123/select-session';
      const body = '{"sessionId":"99"}';
      const sig = signRequest({
        method: 'POST',
        url,
        body,
        timestamp: ts,
        secret: 'shh',
      });
      const req = mockReq({
        url,
        headers: {
          'x-hubspot-signature-v3': sig,
          'x-hubspot-request-timestamp': String(ts),
        },
      });
      await expect(
        requireDealAuthorization(req, '123', body)
      ).resolves.toBeUndefined();
    });

    it('throws when body is tampered after signing', async () => {
      process.env.HUBSPOT_CLIENT_SECRET = 'shh';
      const ts = Date.now();
      const url = 'https://card-api.example.com/api/v2/deal/123/select-session';
      const sig = signRequest({
        method: 'POST',
        url,
        body: '{"sessionId":"99"}',
        timestamp: ts,
        secret: 'shh',
      });
      const req = mockReq({
        url,
        headers: {
          'x-hubspot-signature-v3': sig,
          'x-hubspot-request-timestamp': String(ts),
        },
      });
      // Pass a different body than what was signed
      await expect(
        requireDealAuthorization(req, '123', '{"sessionId":"OTHER"}')
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('honors X-Forwarded-Proto / X-Forwarded-Host when reconstructing the signed URL', async () => {
      process.env.HUBSPOT_CLIENT_SECRET = 'shh';
      const ts = Date.now();
      // HubSpot signed the public URL; the function sees the internal Vercel URL
      const publicUrl =
        'https://card-api.example.com/api/v2/deal/123/select-session';
      const body = '{}';
      const sig = signRequest({
        method: 'POST',
        url: publicUrl,
        body,
        timestamp: ts,
        secret: 'shh',
      });
      const req = mockReq({
        url: 'https://internal-vercel.com/api/v2/deal/123/select-session',
        headers: {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'card-api.example.com',
          'x-hubspot-signature-v3': sig,
          'x-hubspot-request-timestamp': String(ts),
        },
      });
      await expect(
        requireDealAuthorization(req, '123', body)
      ).resolves.toBeUndefined();
    });
  });
});
