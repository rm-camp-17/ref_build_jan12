/**
 * POST /api/v2/deal/[dealId]/generate-memo
 *
 * Generates a client-facing Word document of camp recommendations from the
 * deal's selected associated companies (camps). For each camp we gather its
 * write-up (committed Drive mirror) + structured session/tuition data, compose
 * the memo with Claude (Conway-quality rules), render a .docx, upload it to
 * HubSpot Files, and attach it to the deal.
 *
 * Body:
 *   {
 *     companyIds: string[]            (required — selected camp company IDs)
 *     specialInstructions?: string    (rep steering for tone/framing)
 *   }
 *
 * Response:
 *   { success: true, fileUrl, fileId, noteId, campsIncluded, limitedInfoCamps }
 *   { success: false, message }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDeal } from '@/lib/deals';
import { hubspotClient } from '@/lib/hubspot';
import { getSessionsForProgram } from '@/lib/sessions';
import { getWriteupForCompany } from '@/lib/writeups';
import {
  composeMemo,
  MemoComposeError,
  type MemoCampInput,
  type MemoContext,
} from '@/lib/memo-compose';
import { renderMemoDocx, memoFileName } from '@/lib/memo-docx';
import { deliverMemoToDeal } from '@/lib/hubspot-files';
import { parseRequestBody } from '@/lib/parse-request-body';
import { notifyPipelineFailure } from '@/lib/error-notifier';
import { config } from '@/lib/config';
import {
  requireDealAuthorization,
  DealAuthorizationError,
} from '@/lib/require-deal-authorization';

// Memo generation calls Claude + renders a doc + uploads — give it room and
// keep it on the Node runtime (Files multipart, docx, Anthropic SDK).
export const runtime = 'nodejs';
export const maxDuration = 300;

interface Body {
  companyIds?: string[];
  specialInstructions?: string;
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

async function getCompanyMeta(
  companyId: string
): Promise<{ name: string; programId: string | null }> {
  try {
    const c: any = await hubspotClient.crm.companies.basicApi.getById(companyId, [
      'name',
      config.properties.company.programId,
    ]);
    return {
      name: c?.properties?.name ?? `Company ${companyId}`,
      programId: c?.properties?.[config.properties.company.programId] ?? null,
    };
  } catch {
    return { name: `Company ${companyId}`, programId: null };
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

  // Authorization (proves the request came from HubSpot). Memo generation does
  // not write sacred fields, so no commission-lock check is needed.
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
      { success: false, message: 'Select at least one camp for the memo.' },
      { status: 400 }
    );
  }

  if (!config.memo.anthropicApiKey) {
    return NextResponse.json(
      {
        success: false,
        message:
          'Memo generation is not configured: ANTHROPIC_API_KEY is missing in Vercel.',
      },
      { status: 503 }
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

    const summerYear = deal.year1 || '';
    const yearNum = Number(summerYear);
    const expertName = await getOwnerName(deal.hubspot_owner_id);

    // Gather per-camp source material in parallel.
    const camps: MemoCampInput[] = await Promise.all(
      companyIds.map(async (companyId) => {
        const meta = await getCompanyMeta(companyId);
        const [sessions, writeup] = await Promise.all([
          meta.programId && Number.isFinite(yearNum)
            ? getSessionsForProgram(meta.programId, yearNum).catch(() => [])
            : Promise.resolve([]),
          getWriteupForCompany(meta.name),
        ]);
        return {
          companyId,
          name: meta.name,
          writeupText: writeup?.text ?? null,
          writeupType: writeup?.docType ?? null,
          sessions: sessions.map((s) => ({
            name: s.name,
            weeks: s.weeks,
            tuition: s.tuition,
            currency: s.currency,
            startDate: s.startDate,
            endDate: s.endDate,
            ageMin: s.ageMin,
            ageMax: s.ageMax,
            notes: s.notes,
          })),
        };
      })
    );

    const limitedInfoCamps = camps
      .filter((c) => !c.writeupText)
      .map((c) => c.name);

    // The deal name often carries the family/child + year; pass it as a hint so
    // Claude can build the header even without an explicit forLine.
    const repInstructions = (body.specialInstructions || '').trim();
    const dealNameHint = deal.dealname
      ? `Deal name (may contain the family and/or child names): "${deal.dealname}".`
      : '';
    const specialInstructions = [dealNameHint, repInstructions]
      .filter(Boolean)
      .join('\n');

    const ctx: MemoContext = {
      preparedFor: '',
      expertName,
      summerYear,
      forLine: '',
      specialInstructions,
    };

    const memo = await composeMemo(camps, ctx);
    const buffer = await renderMemoDocx(memo);
    const fileName = memoFileName(memo, dealId);

    const noteBody = `Camp recommendation memo generated for ${
      camps.length
    } camp(s): ${camps.map((c) => c.name).join(', ')}.`;
    const delivered = await deliverMemoToDeal(
      dealId,
      buffer,
      fileName,
      noteBody
    );

    return NextResponse.json({
      success: true,
      fileUrl: delivered.url,
      fileId: delivered.fileId,
      noteId: delivered.noteId,
      fileName,
      campsIncluded: camps.map((c) => c.name),
      limitedInfoCamps,
    });
  } catch (err: any) {
    const message =
      err instanceof MemoComposeError
        ? err.message
        : 'Failed to generate the memo. Please try again.';
    console.error(`[v2/generate-memo] error for deal ${dealId}:`, err?.message, err?.stack);
    await notifyPipelineFailure({
      action: 'generate-memo',
      dealId,
      error: err?.message ?? String(err),
      detail: `companies=${companyIds.join(',')}`,
    });
    return NextResponse.json({ success: false, message }, { status: 500 });
  }
}
