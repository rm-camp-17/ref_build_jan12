/**
 * POST /api/v2/deal/[dealId]/send-referral-email
 *
 * Item 4: (re)sends the referral email to the camp from the deal stage.
 * Like the enrollment email, the actual send is owned by an existing
 * referral-email process; we set the trigger by flipping the referral's
 * outreach status to "ready to send" (config.defaults.referralStatus).
 *
 * Target: the deal's Selected referral (the camp the family chose). If no
 * referral is Selected, every referral on the deal is queued.
 *
 * NOTE: the exact trigger value is assumed to mirror the enrollment-email
 * pattern (status flip picked up by a poller). Override the value via
 * HS_REFERRAL_* env if your referral-email automation keys off a different
 * status.
 *
 * Body: none required.
 * Response: { success: true, queued: number } | { success: false, message }
 */

import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';
import { fetchReferralsForDeal } from '@/lib/referrals';
import { dualWriteReferralProperty } from '@/lib/property-aliases';
import {
  requireUnlocked,
  RequireUnlockedError,
} from '@/lib/require-unlocked';
import {
  requireDealAuthorization,
  DealAuthorizationError,
} from '@/lib/require-deal-authorization';
import { notifyPipelineFailure } from '@/lib/error-notifier';

export async function POST(
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

  try {
    const referrals = await fetchReferralsForDeal(dealId);
    if (referrals.length === 0) {
      return NextResponse.json(
        { success: false, message: 'No referrals on this deal to email.' },
        { status: 400 }
      );
    }

    const selected = referrals.filter(
      (r) => (r.clientInterest || '').toLowerCase() === 'selected'
    );
    const targets = selected.length > 0 ? selected : referrals;

    const trigger = dualWriteReferralProperty(
      'outreach',
      config.defaults.referralStatus
    );
    let queued = 0;
    for (const r of targets) {
      try {
        await hubspotClient.crm.objects.basicApi.update(
          config.objectTypes.referral,
          r.id,
          { properties: trigger }
        );
        queued += 1;
      } catch (err: any) {
        console.warn(
          `[v2/send-referral-email] could not queue referral ${r.id}:`,
          err.message
        );
      }
    }

    if (queued === 0) {
      throw new Error('No referrals could be queued for the referral email.');
    }
    return NextResponse.json({ success: true, queued });
  } catch (err: any) {
    console.error(
      `[v2/send-referral-email] error for deal ${dealId}:`,
      err.message,
      err.stack
    );
    await notifyPipelineFailure({
      action: 'send-referral-email',
      dealId,
      error: err?.message ?? String(err),
    });
    return NextResponse.json(
      { success: false, message: 'Failed to queue referral email.' },
      { status: 500 }
    );
  }
}
