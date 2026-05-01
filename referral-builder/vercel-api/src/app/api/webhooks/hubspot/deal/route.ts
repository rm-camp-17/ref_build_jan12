/**
 * POST /api/webhooks/hubspot/deal
 *
 * HubSpot webhook receiver for Deal events. Dispatches to:
 *   - mirrorChildYearForDeal       (Handler A — Child.Year aggregation)
 *   - spawnRenewalForDeal          (Handler B — next-year renewal create)
 *
 * Subscriptions to register in HubSpot Private App settings (target URL =
 * this endpoint):
 *   - deal.creation
 *   - deal.propertyChange · property: dealstage
 *   - deal.propertyChange · property: year1
 *   - deal.propertyChange · property: associated_child_id
 *
 * Auth: every request is HMAC-verified via X-HubSpot-Signature-v3 against
 * HUBSPOT_CLIENT_SECRET (same secret the unified card's authorization
 * middleware uses). Unsigned or stale requests get 401. The check is
 * unconditional here — webhooks have no other identity, so we can't fall
 * back to "loose" mode the way the card auth does.
 *
 * Reliability: returns 200 with a per-event status array even when
 * individual handlers fail. HubSpot retries on non-2xx, and a single
 * misbehaving event shouldn't trigger a delivery storm against every
 * other event in the batch.
 *
 * Body shape (per HubSpot webhook docs):
 *   [
 *     { eventId, subscriptionType, objectId, propertyName?, propertyValue?, ... },
 *     ...
 *   ]
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  verifyHubspotSignatureV3,
  DealAuthorizationError,
} from '@/lib/require-deal-authorization';
import { mirrorChildYearForDeal } from '@/lib/child-year-mirror';
import { spawnRenewalForDeal } from '@/lib/renewal-spawner';
import { parseRequestBody } from '@/lib/parse-request-body';

interface HubspotWebhookEvent {
  eventId?: number | string;
  subscriptionType?: string;
  objectId?: number | string;
  propertyName?: string;
  propertyValue?: string;
}

interface EventOutcome {
  eventId: string | number | null;
  dealId: string | null;
  subscriptionType: string | null;
  propertyName: string | null;
  ranMirror: boolean;
  ranSpawn: boolean;
  mirrorReason?: string;
  mirrorWrote?: boolean;
  spawnReason?: string;
  spawnNewDealId?: string | null;
  error?: string;
}

const STAGE_TRIGGER_PROPS = new Set(['dealstage', 'year1', 'associated_child_id']);

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // 1. Auth — HMAC-verify before doing anything else.
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
  if (!clientSecret) {
    console.error(
      '[webhook/hubspot/deal] HUBSPOT_CLIENT_SECRET not set; rejecting (fail closed)'
    );
    return NextResponse.json(
      { ok: false, error: 'server misconfigured: HUBSPOT_CLIENT_SECRET missing' },
      { status: 500 }
    );
  }
  try {
    await verifyHubspotSignatureV3(req, rawBody, clientSecret);
  } catch (err) {
    if (err instanceof DealAuthorizationError) {
      // Maps to 403 in the card flow; for webhooks 401 is the more
      // appropriate code (HubSpot doesn't have a way to "log in").
      return NextResponse.json(
        { ok: false, error: err.body.reason },
        { status: 401 }
      );
    }
    throw err;
  }

  // 2. Parse body. HubSpot proxy double-encoding doesn't apply here
  //    (webhooks are pushed by HubSpot directly with proper Content-Type),
  //    but parseRequestBody handles both shapes harmlessly.
  let events: HubspotWebhookEvent[];
  try {
    const parsed = parseRequestBody(rawBody);
    if (!Array.isArray(parsed)) {
      return NextResponse.json(
        { ok: false, error: 'expected JSON array' },
        { status: 400 }
      );
    }
    events = parsed as HubspotWebhookEvent[];
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid JSON body' },
      { status: 400 }
    );
  }

  // 3. Dispatch per-event. Fire mirror + spawn concurrently for the same
  //    dealId; handlers themselves early-exit on irrelevant input so the
  //    cost of running both is just two HubSpot reads in parallel.
  const outcomes: EventOutcome[] = [];
  for (const event of events) {
    outcomes.push(await dispatch(event));
  }

  return NextResponse.json({
    ok: true,
    processed: outcomes.length,
    outcomes,
  });
}

async function dispatch(event: HubspotWebhookEvent): Promise<EventOutcome> {
  const eventId = event.eventId ?? null;
  const subscriptionType = event.subscriptionType ?? null;
  const propertyName = event.propertyName ?? null;
  const objectId = event.objectId;
  const dealId =
    objectId !== undefined && objectId !== null ? String(objectId) : null;

  const outcome: EventOutcome = {
    eventId,
    dealId,
    subscriptionType,
    propertyName,
    ranMirror: false,
    ranSpawn: false,
  };

  if (!dealId || !subscriptionType) {
    outcome.error = 'missing dealId or subscriptionType';
    return outcome;
  }

  // Mirror runs on:
  //   - any deal creation
  //   - propertyChange on dealstage / year1 / associated_child_id
  const shouldMirror =
    subscriptionType === 'deal.creation' ||
    (subscriptionType === 'deal.propertyChange' &&
      propertyName !== null &&
      STAGE_TRIGGER_PROPS.has(propertyName));

  // Spawn runs only on stage changes. The handler itself verifies the
  // current stage is Program Selected — we don't trust propertyValue
  // because it may lag the deal's actual state.
  const shouldSpawn =
    subscriptionType === 'deal.propertyChange' && propertyName === 'dealstage';

  // Fan out. Each handler is wrapped so a failure in one doesn't poison
  // the other.
  const tasks: Array<Promise<void>> = [];
  if (shouldMirror) {
    outcome.ranMirror = true;
    tasks.push(
      (async () => {
        try {
          const r = await mirrorChildYearForDeal(dealId);
          outcome.mirrorReason = r.reason;
          outcome.mirrorWrote = r.wrote;
        } catch (err: any) {
          outcome.mirrorReason = 'error';
          outcome.error = (outcome.error ? `${outcome.error}; ` : '') +
            `mirror: ${err?.message ?? err}`;
        }
      })()
    );
  }
  if (shouldSpawn) {
    outcome.ranSpawn = true;
    tasks.push(
      (async () => {
        try {
          const r = await spawnRenewalForDeal(dealId);
          outcome.spawnReason = r.reason;
          outcome.spawnNewDealId = r.newDealId;
        } catch (err: any) {
          outcome.spawnReason = 'error';
          outcome.error = (outcome.error ? `${outcome.error}; ` : '') +
            `spawn: ${err?.message ?? err}`;
        }
      })()
    );
  }

  await Promise.all(tasks);
  return outcome;
}
