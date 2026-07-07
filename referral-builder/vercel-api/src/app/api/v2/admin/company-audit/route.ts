/**
 * GET /api/v2/admin/company-audit — Safeguard D (deal↔company monitoring).
 *
 * Scans every deal at the two "signed up" stages (Program Selected +
 * Tuition Undecided) for the given years and verifies the enrollment-email
 * invariant: exactly ONE deal→company association whose name matches the
 * deal's programname.
 *
 * Query:
 *   years=2026,2027   (default: current + next year)
 *   fix=1             also auto-reconcile multi-company deals with a
 *                     confident programname match (never guesses; zero-company
 *                     and no-match deals are only reported)
 *   notify=1          email the admin (error-notifier) when problems found —
 *                     used by the daily cron so a re-appearing leak is loud
 *
 * Response: { checked, ok, broken: { multi, zero, mismatch, noProgram },
 *             fixed, offenders: [...] }
 *
 * Uses batch APIs (association batch read: 1000/call; company batch read:
 * 100/call) so a ~3k-deal scan stays well inside maxDuration.
 */

import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';
import {
  reconcileDealCompany,
  scoreCompanyMatch,
  CONFIDENT_SCORE,
  type DealCompany,
} from '@/lib/deal-company-guard';
import { notifyPipelineFailure } from '@/lib/error-notifier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const PAGE_LIMIT = 200;
const MAX_DEALS = 6000;
const MAX_FIXES_PER_RUN = 50;

interface AuditDeal {
  id: string;
  dealname: string;
  programname: string;
  companies: DealCompany[];
}

async function fetchSelectedDeals(years: string[]): Promise<
  Array<{ id: string; dealname: string; programname: string }>
> {
  const out: Array<{ id: string; dealname: string; programname: string }> = [];
  let after: string | undefined = undefined;
  while (out.length < MAX_DEALS) {
    const page: any = await hubspotClient.crm.deals.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'dealstage',
              operator: 'IN' as any,
              values: [config.stages.programSelected, config.stages.tuitionUndecided],
            },
            { propertyName: 'year1', operator: 'IN' as any, values: years },
          ],
        },
      ],
      properties: ['dealname', 'programname'],
      sorts: ['hs_object_id'],
      limit: PAGE_LIMIT,
      ...(after ? { after } : {}),
    } as any);
    for (const r of page.results || []) {
      out.push({
        id: String(r.id),
        dealname: r.properties?.dealname || '',
        programname: r.properties?.programname || '',
      });
    }
    after = page?.paging?.next?.after;
    if (!after) break;
  }
  return out;
}

/** deal id → associated company ids, via the v4 batch association read. */
async function batchDealCompanies(dealIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (let i = 0; i < dealIds.length; i += 1000) {
    const chunk = dealIds.slice(i, i + 1000);
    const resp: any = await hubspotClient.crm.associations.v4.batchApi.getPage(
      'deals',
      'companies',
      { inputs: chunk.map((id) => ({ id })) } as any
    );
    for (const row of resp?.results || []) {
      const from = String(row?._from?.id ?? row?.from?.id ?? '');
      const tos = (row?.to || []).map((t: any) => String(t.toObjectId ?? t.id));
      if (from) map.set(from, tos);
    }
  }
  for (const id of dealIds) if (!map.has(id)) map.set(id, []);
  return map;
}

async function batchCompanyNames(companyIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = Array.from(new Set(companyIds));
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    try {
      const resp: any = await hubspotClient.crm.companies.batchApi.read({
        inputs: chunk.map((id) => ({ id })),
        properties: ['name'],
        propertiesWithHistory: [],
      } as any);
      for (const r of resp?.results || []) {
        names.set(String(r.id), r.properties?.name || '');
      }
    } catch (err: any) {
      console.warn('[company-audit] company batch read failed:', err?.message);
    }
  }
  return names;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const fix = searchParams.get('fix') === '1';
  const notify = searchParams.get('notify') === '1';
  const now = new Date().getFullYear();
  const years = (searchParams.get('years') || `${now},${now + 1}`)
    .split(',')
    .map((y) => y.trim())
    .filter((y) => /^\d{4}$/.test(y));

  try {
    const deals = await fetchSelectedDeals(years);
    const companyMap = await batchDealCompanies(deals.map((d) => d.id));
    const nameMap = await batchCompanyNames(
      Array.from(companyMap.values()).flat()
    );

    const audit: AuditDeal[] = deals.map((d) => ({
      ...d,
      companies: (companyMap.get(d.id) || []).map((cid) => ({
        id: cid,
        name: nameMap.get(cid) || '',
      })),
    }));

    let ok = 0;
    let fixed = 0;
    const offenders: Array<Record<string, unknown>> = [];
    const broken = { multi: 0, zero: 0, mismatch: 0, noProgram: 0 };

    for (const d of audit) {
      const n = d.companies.length;
      if (!d.programname.trim()) {
        if (n === 1) {
          // No program yet (Tuition Undecided can predate the program write);
          // a single company is the expected steady state — count as ok.
          ok++;
          continue;
        }
        broken.noProgram++;
        offenders.push({ dealId: d.id, dealname: d.dealname, issue: 'no_program', companies: d.companies });
        continue;
      }
      if (n === 1) {
        if (scoreCompanyMatch(d.programname, d.companies[0].name) >= CONFIDENT_SCORE) {
          ok++;
        } else {
          broken.mismatch++;
          offenders.push({
            dealId: d.id,
            dealname: d.dealname,
            issue: 'single_mismatch',
            programname: d.programname,
            companies: d.companies,
          });
        }
        continue;
      }
      if (n === 0) {
        broken.zero++;
        offenders.push({
          dealId: d.id,
          dealname: d.dealname,
          issue: 'zero_companies',
          programname: d.programname,
        });
        continue;
      }
      // Multi-company — the wrong-camp-email condition.
      broken.multi++;
      const entry: Record<string, unknown> = {
        dealId: d.id,
        dealname: d.dealname,
        issue: 'multi_company',
        programname: d.programname,
        companies: d.companies,
      };
      if (fix && fixed < MAX_FIXES_PER_RUN) {
        const result = await reconcileDealCompany(d.id, d.programname, {
          apply: true,
        });
        entry.fix = result.status;
        if (result.status === 'fixed') {
          fixed++;
          entry.kept = result.kept;
          entry.removed = result.removed;
        }
      }
      offenders.push(entry);
    }

    const totalBroken =
      broken.multi + broken.zero + broken.mismatch + broken.noProgram;

    if (notify && totalBroken > 0) {
      await notifyPipelineFailure({
        action: 'company-audit',
        dealId: 'audit',
        error: `Deal↔company audit found ${totalBroken} problem deal(s): ${broken.multi} multi-company, ${broken.zero} zero-company, ${broken.mismatch} mismatched, ${broken.noProgram} missing program. Multi-company deals can email the WRONG CAMP.`,
        detail: offenders
          .slice(0, 15)
          .map((o) => `${o.dealId} ${o.issue} "${o.dealname}"`)
          .join(' | '),
      }).catch(() => {});
    }

    return NextResponse.json({
      years,
      checked: audit.length,
      ok,
      broken,
      fixed,
      offenders: offenders.slice(0, 200),
    });
  } catch (err: any) {
    console.error('[company-audit] error:', err?.message, err?.stack);
    return NextResponse.json(
      { error: `Audit failed: ${err?.message}` },
      { status: 500 }
    );
  }
}
