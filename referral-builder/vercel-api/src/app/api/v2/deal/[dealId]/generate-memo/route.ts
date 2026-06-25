/**
 * Memo generation — asynchronous (start + poll).
 *
 * Composing a memo (gather camps → Claude → .docx → HubSpot Files) takes
 * 20-60s, well past HubSpot's `hubspot.fetch` gateway timeout. So this route is
 * split:
 *
 *   POST /api/v2/deal/[dealId]/generate-memo
 *     Body: { companyIds: string[], specialInstructions?: string }
 *     → validates, creates a job, kicks the work off via Vercel `waitUntil`
 *       (runs after the response, up to maxDuration), returns immediately:
 *       { success: true, jobId, status: 'pending' }
 *
 *   GET  /api/v2/deal/[dealId]/generate-memo?jobId=<id>
 *     → { success, status: 'pending' | 'done' | 'error', ...result | message }
 *
 * The card polls the GET until done/error. No gateway timeout, and the real
 * failure (e.g. a missing Files scope) surfaces in the card.
 */

import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
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
  ensureMemoJobsTable,
  createMemoJob,
  getMemoJob,
  markMemoJobDone,
  markMemoJobError,
} from '@/lib/memo-jobs';
import {
  requireDealAuthorization,
  DealAuthorizationError,
} from '@/lib/require-deal-authorization';

// The heavy work runs in waitUntil after the response, so keep the Node runtime
// and give it room (Files multipart, docx, Anthropic SDK).
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

/**
 * The actual memo build. Runs in the background (waitUntil) and writes the
 * outcome to the job row. Never throws to the caller — failures are recorded on
 * the job so the card can show them.
 */
async function runMemoJob(
  jobId: string,
  dealId: string,
  companyIds: string[],
  specialInstructions: string
): Promise<void> {
  try {
    const deal = await getDeal(dealId);
    if (!deal) throw new Error('Deal not found.');

    const summerYear = deal.year1 || '';
    const yearNum = Number(summerYear);
    const expertName = await getOwnerName(deal.hubspot_owner_id);

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

    const repInstructions = (specialInstructions || '').trim();
    const dealNameHint = deal.dealname
      ? `Deal name (may contain the family and/or child names): "${deal.dealname}".`
      : '';
    const combinedInstructions = [dealNameHint, repInstructions]
      .filter(Boolean)
      .join('\n');

    const ctx: MemoContext = {
      preparedFor: '',
      expertName,
      summerYear,
      forLine: '',
      specialInstructions: combinedInstructions,
    };

    const memo = await composeMemo(camps, ctx);
    const buffer = await renderMemoDocx(memo);
    const fileName = memoFileName(memo, dealId);

    const noteBody = `Camp recommendation memo generated for ${
      camps.length
    } camp(s): ${camps.map((c) => c.name).join(', ')}.`;
    const delivered = await deliverMemoToDeal(dealId, buffer, fileName, noteBody);

    await markMemoJobDone(jobId, {
      fileUrl: delivered.url,
      fileName,
      noteId: delivered.noteId,
      campsIncluded: camps.map((c) => c.name),
      limitedInfoCamps,
    });
  } catch (err: any) {
    const message =
      err instanceof MemoComposeError
        ? err.message
        : err?.message || 'Failed to generate the memo. Please try again.';
    console.error(
      `[v2/generate-memo] job ${jobId} failed for deal ${dealId}:`,
      err?.message,
      err?.stack
    );
    await notifyPipelineFailure({
      action: 'generate-memo',
      dealId,
      error: err?.message ?? String(err),
      detail: `job=${jobId} companies=${companyIds.join(',')}`,
    }).catch(() => {});
    await markMemoJobError(jobId, message).catch(() => {});
  }
}

// ============================================================================
// POST — start a job
// ============================================================================

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

  // Create the job, then run the heavy work after responding. waitUntil keeps
  // the function alive (up to maxDuration) to finish it — unlike a bare
  // un-awaited promise, which Vercel would freeze the moment we respond.
  let jobId: string;
  try {
    await ensureMemoJobsTable();
    jobId = await createMemoJob(dealId);
  } catch (err: any) {
    console.error(`[v2/generate-memo] could not create job for ${dealId}:`, err?.message);
    return NextResponse.json(
      { success: false, message: 'Could not start memo generation. Please try again.' },
      { status: 500 }
    );
  }

  const specialInstructions = (body.specialInstructions || '').trim();
  waitUntil(runMemoJob(jobId, dealId, companyIds, specialInstructions));

  return NextResponse.json({ success: true, jobId, status: 'pending' });
}

// ============================================================================
// GET — poll job status
// ============================================================================

export async function GET(
  req: NextRequest,
  { params }: { params: { dealId: string } }
) {
  const { dealId } = params;
  const jobId = new URL(req.url).searchParams.get('jobId');

  try {
    await requireDealAuthorization(req, dealId, '');
  } catch (err) {
    if (err instanceof DealAuthorizationError) {
      return NextResponse.json(err.body, { status: err.statusCode });
    }
    throw err;
  }

  if (!jobId) {
    return NextResponse.json(
      { success: false, message: 'jobId is required.' },
      { status: 400 }
    );
  }

  let job;
  try {
    job = await getMemoJob(jobId);
  } catch (err: any) {
    console.error(`[v2/generate-memo] status lookup failed for job ${jobId}:`, err?.message);
    // Treat a transient lookup failure as still-pending so the card keeps polling.
    return NextResponse.json({ success: true, status: 'pending' });
  }

  if (!job) {
    return NextResponse.json(
      { success: false, status: 'unknown', message: 'Memo job not found.' },
      { status: 404 }
    );
  }

  if (job.status === 'pending') {
    return NextResponse.json({ success: true, status: 'pending' });
  }
  if (job.status === 'error') {
    return NextResponse.json({
      success: false,
      status: 'error',
      message: job.error || 'Failed to generate the memo.',
    });
  }

  return NextResponse.json({
    success: true,
    status: 'done',
    fileUrl: job.file_url,
    fileName: job.file_name,
    campsIncluded: job.camps_included ? JSON.parse(job.camps_included) : [],
    limitedInfoCamps: job.limited_info ? JSON.parse(job.limited_info) : [],
  });
}
