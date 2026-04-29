/**
 * PATCH /api/deals/[dealId]/win-reason
 *
 * Closed Won capture (UNIFIED_CARD_SPEC.md §4.4) — writes the rep-supplied
 * `closed_won_category` enum + optional free-text `closed_won_reason` to
 * the deal.
 *
 * Body:
 *   {
 *     closed_won_category: 'RETURNING' | 'NEW_PLACEMENT' | 'REFERRAL_DRIVEN'
 *                          | 'CO_WORK' | 'OTHER',
 *     closed_won_reason?: string
 *   }
 *
 * Neither field is in SACRED_FIELDS, so `requireUnlocked` short-circuits
 * — but we still call it with an empty mutating-fields list so the
 * middleware pattern stays uniform across mutating routes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { updateDeal } from '@/lib/deals';
import {
  requireUnlocked,
  RequireUnlockedError,
} from '@/lib/require-unlocked';
import {
  requireDealAuthorization,
  DealAuthorizationError,
} from '@/lib/require-deal-authorization';

const VALID_WIN_CATEGORIES = [
  'RETURNING',
  'NEW_PLACEMENT',
  'REFERRAL_DRIVEN',
  'CO_WORK',
  'OTHER',
] as const;

type WinCategory = (typeof VALID_WIN_CATEGORIES)[number];

export async function PATCH(
  req: NextRequest,
  { params }: { params: { dealId: string } }
) {
  const { dealId } = params;

  if (!dealId || !/^\d+$/.test(dealId)) {
    return NextResponse.json(
      { success: false, message: 'Valid Deal ID is required.' },
      { status: 400 }
    );
  }

  const rawBody = await req.text();
  let body: { closed_won_category?: string; closed_won_reason?: string };
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid JSON in request body.' },
      { status: 400 }
    );
  }

  const category = body.closed_won_category;
  if (!category || !VALID_WIN_CATEGORIES.includes(category as WinCategory)) {
    return NextResponse.json(
      {
        success: false,
        message: `closed_won_category must be one of: ${VALID_WIN_CATEGORIES.join(', ')}.`,
      },
      { status: 400 }
    );
  }

  // Spec §5.1, §6.1 — pattern stays consistent even though closed_won_*
  // are not sacred. requireUnlocked will short-circuit on empty mutating
  // fields.
  try {
    await requireDealAuthorization(req, dealId, rawBody);
    await requireUnlocked(dealId, []);
  } catch (err) {
    if (err instanceof DealAuthorizationError) {
      return NextResponse.json(err.body, { status: err.statusCode });
    }
    if (err instanceof RequireUnlockedError) {
      return NextResponse.json(err.body, { status: err.statusCode });
    }
    throw err;
  }

  const properties: Record<string, string> = {
    closed_won_category: category,
  };
  if (typeof body.closed_won_reason === 'string') {
    properties.closed_won_reason = body.closed_won_reason;
  }

  try {
    await updateDeal(dealId, properties);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error(
      `[win-reason] error for deal ${dealId}:`,
      err.message,
      err.stack
    );
    return NextResponse.json(
      { success: false, message: 'Failed to update deal.' },
      { status: 500 }
    );
  }
}
