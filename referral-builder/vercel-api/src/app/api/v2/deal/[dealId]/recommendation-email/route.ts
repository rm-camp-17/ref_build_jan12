/**
 * POST /api/v2/deal/[dealId]/recommendation-email
 *
 * Compose the quick recommendation email for the selected camps — the short,
 * parent-facing companion to the full memo. Deterministic (no AI), returns in
 * about a second:
 *
 *   Body:     { companyIds: string[] }
 *   Response: { success, subject, body, campsMissingSummary, noteId }
 *
 * Pulls each camp's short program name, website, location, and
 * "Four-Sentence Summary for Parents" straight from the company record,
 * composes a plain-text email the rep pastes into their mail client, and logs
 * it as a Note on the deal (best-effort) so the recommendation is on record.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDeal } from '@/lib/deals';
import { hubspotClient } from '@/lib/hubspot';
import {
  getEmailCamp,
  composeRecommendationEmail,
  logEmailToDeal,
} from '@/lib/recommendation-email';
import { parseRequestBody } from '@/lib/parse-request-body';
import {
  requireDealAuthorization,
  DealAuthorizationError,
} from '@/lib/require-deal-authorization';

export const runtime = 'nodejs';
export const maxDuration = 30;

interface Body {
  companyIds?: string[];
}

async function getOwnerName(ownerId: string | null): Promise<string> {
  if (!ownerId) return '';
  try {
    const owner: any = await hubspotClient.crm.owners.ownersApi.getById(
      Number(ownerId)
    );
    const name = [owner?.firstName, owner?.lastName].filter(Boolean).join(' ');
    return name || owner?.email || '';
  } catch {
    return '';
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { dealId: string } }
) {
  const { dealId } = params;
  if (!dealId) {
    return NextResponse.json(
      { success: false, message: 'No deal ID provided.' },
      { status: 400 }
    );
  }

  const rawBody = await req.text();
  let body: Body;
  try {
    body = parseRequestBody(rawBody) as Body;
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid JSON in request body.' },
      { status: 400 }
    );
  }

  try {
    await requireDealAuthorization(req, dealId, rawBody);
  } catch (err) {
    if (err instanceof DealAuthorizationError) {
      return NextResponse.json(err.body, { status: err.statusCode });
    }
    throw err;
  }

  const companyIds = Array.isArray(body.companyIds)
    ? body.companyIds.filter((x) => typeof x === 'string' && x.trim())
    : [];
  if (companyIds.length === 0) {
    return NextResponse.json(
      { success: false, message: 'Select at least one camp for the email.' },
      { status: 400 }
    );
  }

  try {
    const deal = await getDeal(dealId);
    if (!deal) {
      return NextResponse.json(
        { success: false, message: 'Deal not found.' },
        { status: 404 }
      );
    }

    const [expertName, camps] = await Promise.all([
      getOwnerName(deal.hubspot_owner_id),
      Promise.all(companyIds.map(getEmailCamp)),
    ]);

    const email = composeRecommendationEmail(camps, {
      summerYear: deal.year1 || '',
      expertName,
    });

    // Paper trail — best-effort; the compose still succeeds if this fails.
    const noteId = await logEmailToDeal(dealId, email);

    return NextResponse.json({
      success: true,
      subject: email.subject,
      body: email.body,
      campsMissingSummary: email.campsMissingSummary,
      noteId,
    });
  } catch (err: any) {
    console.error(
      `[v2/recommendation-email] error for deal ${dealId}:`,
      err?.message,
      err?.stack
    );
    return NextResponse.json(
      { success: false, message: 'Failed to compose the email. Please try again.' },
      { status: 500 }
    );
  }
}
