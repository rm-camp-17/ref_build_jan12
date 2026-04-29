/**
 * Cross-deal write authorization middleware.
 *
 * Implements UNIFIED_CARD_SPEC.md §6.1 — every mutating route must verify
 * that the authenticated HubSpot user has access to the dealId being
 * mutated, and that the request is bound to that same deal in HubSpot's
 * iframe context (so a rep on deal X can't be tricked into PATCHing
 * deal Y).
 *
 * --------------------------------------------------------------------
 * IMPORTANT — DEGRADED IMPLEMENTATION (Phase 4 follow-up required)
 * --------------------------------------------------------------------
 *
 * Research summary (2026-04, HubSpot docs + community threads):
 *
 *   1. `hubspot.fetch()` from a UI Extension iframe DOES NOT attach a JWT
 *      that encodes the bound CRM record. The signed metadata HubSpot
 *      attaches is a v3 HMAC over (method, uri, body, timestamp) using
 *      the app's client secret. Headers are:
 *         - X-HubSpot-Signature-v3
 *         - X-HubSpot-Request-Timestamp  (ms since epoch)
 *      Plus query-param metadata: userId, portalId, userEmail, appId.
 *
 *   2. The signed payload does NOT include the bound dealId. The card
 *      itself supplies the dealId in the URL path / body, so a malicious
 *      / rogue card could pass a different dealId than the iframe is
 *      mounted against. HubSpot doesn't expose the bound record ID to
 *      external backends through a verifiable channel.
 *
 *   3. There is no "iframe context JWT" served by HubSpot today that the
 *      backend can independently verify against the URL dealId.
 *
 * What this means for the spec's §6.1 invariant:
 *   - We CAN verify the request originated from HubSpot (HMAC v3).
 *   - We CANNOT, without a server-side HubSpot API call, verify the
 *     authenticated user actually has access to the dealId in the URL.
 *     A future Phase 4 follow-up should either:
 *       (a) call HubSpot's `/crm/v3/objects/deals/{id}` from the
 *           backend on every mutation as a permission probe, OR
 *       (b) wait for HubSpot to expose a verifiable iframe-context
 *           token that includes the bound CRM record ID.
 *
 * Behavior controlled by STRICT_DEAL_AUTH:
 *
 *   - STRICT_DEAL_AUTH !== 'true' (DEFAULT)
 *       Logs a one-time warning per process and returns. No-op. Keeps
 *       the current dev/staging flow working while ce-billing and the
 *       new card are being wired up.
 *
 *   - STRICT_DEAL_AUTH === 'true'
 *       Verifies the X-HubSpot-Signature-v3 HMAC against the request
 *       and rejects if missing or invalid. Also rejects requests with a
 *       stale timestamp (> 5 minutes old) per HubSpot's recommendation.
 *
 *       **This is partial verification.** It blocks unauthenticated
 *       traffic but does NOT enforce the cross-deal binding the spec
 *       calls for. The dealId argument is accepted for API symmetry and
 *       will be load-bearing once Phase 4 lands the bound-record check.
 *
 * Either way, throws DealAuthorizationError (statusCode 403) when the
 * request fails verification under strict mode.
 *
 * Phase 4 follow-up: full bound-deal verification (see options (a)/(b)
 * above). Track via UNIFIED_CARD_SPEC.md §6.1.
 */

import crypto from 'crypto';
import type { NextRequest } from 'next/server';

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1_000; // 5 minutes

let warnedAboutLooseAuth = false;

export class DealAuthorizationError extends Error {
  readonly statusCode = 403 as const;
  readonly body: { error: string; reason: string };

  constructor(reason: string) {
    super(`Deal authorization failed: ${reason}`);
    this.name = 'DealAuthorizationError';
    this.body = {
      error: 'Forbidden: deal authorization failed.',
      reason,
    };
    Object.setPrototypeOf(this, DealAuthorizationError.prototype);
  }
}

/**
 * Reconstruct the URL HubSpot signed against. We trust the proxy headers
 * (X-Forwarded-Proto / X-Forwarded-Host) when present because Vercel
 * terminates TLS upstream of the function and the raw `req.url` host
 * may be the internal Vercel URL.
 */
function getRequestUrl(req: NextRequest): string {
  const forwardedProto = req.headers.get('x-forwarded-proto');
  const forwardedHost = req.headers.get('x-forwarded-host');
  if (forwardedProto && forwardedHost) {
    const u = new URL(req.url);
    return `${forwardedProto}://${forwardedHost}${u.pathname}${u.search}`;
  }
  return req.url;
}

/**
 * Verify HubSpot's X-HubSpot-Signature-v3 HMAC against the request.
 *
 * Returns true if valid; throws DealAuthorizationError if invalid /
 * missing / expired. Exported for tests; route handlers should call
 * `requireDealAuthorization` instead.
 */
export async function verifyHubspotSignatureV3(
  req: NextRequest,
  rawBody: string,
  clientSecret: string
): Promise<void> {
  const signature = req.headers.get('x-hubspot-signature-v3');
  const timestampHeader = req.headers.get('x-hubspot-request-timestamp');

  if (!signature) {
    throw new DealAuthorizationError('missing X-HubSpot-Signature-v3 header');
  }
  if (!timestampHeader) {
    throw new DealAuthorizationError(
      'missing X-HubSpot-Request-Timestamp header'
    );
  }

  const timestampMs = Number(timestampHeader);
  if (!Number.isFinite(timestampMs)) {
    throw new DealAuthorizationError(
      'X-HubSpot-Request-Timestamp is not numeric'
    );
  }
  if (Math.abs(Date.now() - timestampMs) > TIMESTAMP_TOLERANCE_MS) {
    throw new DealAuthorizationError(
      'X-HubSpot-Request-Timestamp outside 5-minute tolerance window'
    );
  }

  const url = getRequestUrl(req);
  const method = req.method.toUpperCase();
  const stringToSign = `${method}${url}${rawBody}${timestampHeader}`;

  const expected = crypto
    .createHmac('sha256', clientSecret)
    .update(stringToSign, 'utf8')
    .digest('base64');

  // Constant-time comparison
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new DealAuthorizationError('X-HubSpot-Signature-v3 mismatch');
  }
}

/**
 * Cross-deal authorization middleware.
 *
 * @param req     The incoming NextRequest.
 * @param dealId  The dealId from the URL path (or body, for /api/referrals).
 *                Currently used only for log correlation — see top-of-file
 *                JSDoc on the Phase 4 follow-up that makes this load-bearing.
 * @param rawBody The raw, un-parsed request body string. Required for
 *                signature verification when STRICT_DEAL_AUTH=true. Pass
 *                an empty string for routes that don't read the body
 *                (none today, but future GETs).
 */
export async function requireDealAuthorization(
  req: NextRequest,
  dealId: string,
  rawBody: string = ''
): Promise<void> {
  const strict = process.env.STRICT_DEAL_AUTH === 'true';

  if (!strict) {
    if (!warnedAboutLooseAuth) {
      warnedAboutLooseAuth = true;
      console.warn(
        '[requireDealAuthorization] strict deal auth disabled — skipping verification. ' +
          'Set STRICT_DEAL_AUTH=true (and HUBSPOT_CLIENT_SECRET) to enable HMAC v3 signature checks. ' +
          'Note: cross-deal bound-record verification is a Phase 4 follow-up (see UNIFIED_CARD_SPEC.md §6.1).'
      );
    }
    return;
  }

  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
  if (!clientSecret) {
    // Strict mode demands real verification. Without a secret we can't
    // verify, so the safe behavior is to reject rather than silently
    // pass. Surface the misconfiguration to ops loudly.
    console.error(
      '[requireDealAuthorization] STRICT_DEAL_AUTH=true but HUBSPOT_CLIENT_SECRET is not set; rejecting request for deal ' +
        dealId
    );
    throw new DealAuthorizationError(
      'server misconfigured: HUBSPOT_CLIENT_SECRET missing'
    );
  }

  await verifyHubspotSignatureV3(req, rawBody, clientSecret);

  // PHASE 4 FOLLOW-UP: bound-deal check.
  //
  // We've now confirmed the request originated from HubSpot, but we have
  // not confirmed the iframe is rendering against `dealId`. A malicious
  // card could send a forged dealId in the URL and our HMAC would still
  // pass. Until HubSpot exposes the bound record ID in a verifiable
  // payload (or we add a server-side permission probe), this is a known
  // gap. See top-of-file JSDoc.
  //
  // Logging the dealId here so the gap is visible in audit trails.
  if (process.env.NODE_ENV !== 'test') {
    console.info(
      `[requireDealAuthorization] strict-mode HMAC verified for deal ${dealId} (bound-deal check is a Phase 4 follow-up)`
    );
  }
}

/**
 * Test-only helper — resets the "warned about loose auth" flag so each
 * test starts from a clean slate.
 */
export function __resetLooseAuthWarning(): void {
  warnedAboutLooseAuth = false;
}
