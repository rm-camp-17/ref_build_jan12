/**
 * commission_locked enforcement middleware.
 *
 * Implements UNIFIED_CARD_SPEC.md §5.1 — every mutating route calls
 * `requireUnlocked(dealId, mutatingFields)` before touching HubSpot. The
 * card is informational; the actual security boundary lives in ce-billing,
 * which owns the lock state. This helper is a thin client that fetches and
 * respects the answer.
 *
 * Behavior:
 *   - GET ${CE_BILLING_API_URL}/api/health/check-locked?dealId={dealId}
 *   - Auth: X-Card-API-Key: ${CARD_API_KEY}
 *   - 5-second timeout
 *   - Soft-fail on missing CE_BILLING_API_URL, network error, or non-2xx
 *     response (logs but doesn't block writes — lets the codebase ship
 *     before the ce-billing endpoint is deployed)
 *   - Throws RequireUnlockedError (409) when ce-billing reports
 *     `{ locked: true }` AND any of the supplied `mutatingFields`
 *     intersects the SACRED_FIELDS set
 *
 * Apply at the top of every mutating route — see usage example in the
 * spec or in any of the v2/deal/[dealId]/* routes.
 */

export const SACRED_FIELDS: ReadonlyArray<string> = [
  'expertprofile',
  'referred_by',
  'split_type',
  'deal_split_email',
  'deal_split_pct',
  'tuition_at_enrollment',
  'lengthofstay',
] as const;

const SACRED_FIELDS_SET = new Set<string>(SACRED_FIELDS);

const CHECK_LOCKED_TIMEOUT_MS = 5_000;

export interface RequireUnlockedErrorBody {
  locked: true;
  reason?: string;
}

export class RequireUnlockedError extends Error {
  readonly statusCode = 409 as const;
  readonly body: RequireUnlockedErrorBody;

  constructor(reason?: string) {
    super(
      reason
        ? `Deal is commission_locked: ${reason}`
        : 'Deal is commission_locked. Contact billing.'
    );
    this.name = 'RequireUnlockedError';
    this.body = { locked: true, ...(reason ? { reason } : {}) };
    // Restore prototype chain (TS-ism for Error subclasses)
    Object.setPrototypeOf(this, RequireUnlockedError.prototype);
  }
}

interface CheckLockedResponse {
  locked: boolean;
  reason?: string;
}

/**
 * Returns true if any of the supplied mutating fields are sacred.
 * Exported for testability / route-level early exit.
 */
export function hasSacredField(mutatingFields: string[]): boolean {
  for (const field of mutatingFields) {
    if (SACRED_FIELDS_SET.has(field)) return true;
  }
  return false;
}

/**
 * Calls ce-billing's check-locked endpoint and throws if the deal is
 * commission_locked AND the request is mutating a sacred field.
 *
 * Soft-fails on any non-throwing error (missing env var, network failure,
 * timeout, non-2xx). Only RequireUnlockedError escapes this function.
 */
export async function requireUnlocked(
  dealId: string,
  mutatingFields: string[]
): Promise<void> {
  const baseUrl = process.env.CE_BILLING_API_URL;
  if (!baseUrl) {
    console.warn(
      '[requireUnlocked] CE_BILLING_API_URL not set — skipping commission_locked enforcement (soft fail)'
    );
    return;
  }

  // Optimization: if the request isn't touching any sacred fields, we
  // don't need to hit ce-billing at all. ce-billing's answer can't reject
  // a non-sacred mutation no matter what it returns.
  if (!hasSacredField(mutatingFields)) {
    return;
  }

  const url = `${baseUrl.replace(/\/$/, '')}/api/health/check-locked?dealId=${encodeURIComponent(dealId)}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (process.env.CARD_API_KEY) {
    headers['X-Card-API-Key'] = process.env.CARD_API_KEY;
  }

  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_LOCKED_TIMEOUT_MS);
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.warn(
        `[requireUnlocked] check-locked timed out after ${CHECK_LOCKED_TIMEOUT_MS}ms for deal ${dealId} (soft fail)`
      );
    } else {
      console.warn(
        `[requireUnlocked] check-locked network error for deal ${dealId} (soft fail):`,
        err?.message ?? err
      );
    }
    return;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    console.warn(
      `[requireUnlocked] check-locked returned ${response.status} for deal ${dealId} (soft fail)`
    );
    return;
  }

  let payload: CheckLockedResponse;
  try {
    payload = (await response.json()) as CheckLockedResponse;
  } catch (err: any) {
    console.warn(
      `[requireUnlocked] check-locked returned non-JSON for deal ${dealId} (soft fail):`,
      err?.message ?? err
    );
    return;
  }

  if (payload?.locked === true) {
    throw new RequireUnlockedError(payload.reason);
  }
}
