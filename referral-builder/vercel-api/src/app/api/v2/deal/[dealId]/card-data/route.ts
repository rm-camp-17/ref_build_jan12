/**
 * GET /api/v2/deal/[dealId]/card-data
 *
 * Stage-aware card data for the unified card's session-selection view.
 * Returns one of five status payloads depending on the deal's pipeline +
 * stage:
 *
 *   not-in-pipeline   — deal is on a different pipeline (historic, etc.)
 *   confirmed         — deal is at Closed Won (programSelected); show summary
 *   inactive          — deal is on the active pipeline but not yet at
 *                       Tuition Undecided; show a "waiting" message
 *   eligible          — deal is at Tuition Undecided; return sessions list
 *   error             — anything threw; return a soft error message
 *
 * Ports the legacy session-card route at
 * camp-experts-session-card/src/routes/api-v2.js GET /api/v2/deal/:dealId/card-data
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDeal } from '@/lib/deals';
import { lookupSessions } from '@/lib/session-lookup';
import { fetchReferralContext } from '@/lib/referral-context';
import { config } from '@/lib/config';

const ACTIVE_PIPELINE = 'default';

export async function GET(
  _req: NextRequest,
  { params }: { params: { dealId: string } }
) {
  const { dealId } = params;

  if (!dealId) {
    return NextResponse.json({
      status: 'error',
      message: 'No deal ID provided.',
    });
  }

  try {
    const deal = await getDeal(dealId);
    if (!deal) {
      return NextResponse.json({ status: 'error', message: 'Deal not found.' });
    }

    if (deal.pipeline !== ACTIVE_PIPELINE) {
      return NextResponse.json({ status: 'not-in-pipeline' });
    }

    // Closed Won (= "Program Selected" in the active pipeline)
    if (deal.dealstage === config.stages.programSelected) {
      return NextResponse.json({
        status: 'confirmed',
        tuition: deal.tuition_at_enrollment,
        weeks: deal.lengthofstay,
        currency: deal.deal_currency_code,
        sessionName: deal.session_name,
        sessionStartDate: deal.session_start_date,
        sessionEndDate: deal.session_end_date,
        notes: deal.note_1,
      });
    }

    // Stages other than Tuition Undecided: card is informational only
    if (deal.dealstage !== config.stages.tuitionUndecided) {
      return NextResponse.json({
        status: 'inactive',
        message:
          'Session selection available when deal reaches "Program Selected - Tuition Undecided" stage.',
      });
    }

    // Eligible: fetch sessions + referral-context in parallel
    // referralContext is non-blocking — null on failure, just used for the banner
    const [sessionResult, referralContext] = await Promise.all([
      lookupSessions({
        program_id: deal.program_id,
        programname: deal.programname,
        year1: deal.year1,
      }),
      fetchReferralContext(dealId),
    ]);

    const { sessions, programName, error } = sessionResult;

    // At Tuition Undecided the deal is ALWAYS eligible to set tuition. When no
    // sessions are on file (e.g. a freshly-cloned Won deal whose camp has no
    // sessions loaded for the new year), return an eligible payload with an
    // empty list plus a note, so the card shows the manual-entry path instead
    // of a dead-end "card not active" alert.
    return NextResponse.json({
      status: 'eligible',
      sessions,
      programName,
      programId: deal.program_id,
      year: deal.year1 ? parseInt(deal.year1, 10) : null,
      referralContext,
      sessionsNote: sessions.length === 0 ? error : null,
    });
  } catch (err: any) {
    console.error(
      `[v2/card-data] error for deal ${dealId}:`,
      err.message,
      err.stack
    );
    return NextResponse.json({
      status: 'error',
      message: 'Session data temporarily unavailable. Try again shortly.',
    });
  }
}
