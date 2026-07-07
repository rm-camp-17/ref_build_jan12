/**
 * Deal↔Company guard — enrollment emails go to the camp resolved from the
 * deal's associated company, so a Program-Selected deal MUST have exactly one
 * deal→company association and it must be the `programname` camp.
 *
 * Historically referral creation associated EVERY referral's company to the
 * deal (and clones copied them wholesale), so some deals carried the child's
 * whole recommended-camp set and the enrollment email went to the wrong camp
 * (e.g. deal 61750196319 "SUMMER DISCOVERY" mailing ACA). The leak is fixed at
 * the source (workflow.ts / clone.ts); this module is the safety net:
 *
 *   - scoreCompanyMatch / pickCompanyForProgram — the programname→company
 *     matching rule (normalize-equal 100, substring 90, else shared tokens).
 *   - reconcileDealCompany — reduce a deal to its single matching company
 *     (keeps 341 default + 5 Primary), or flag when no confident match.
 *   - enrollmentSendGate — pre-send validation: allow / auto-fix / block.
 */

import { hubspotClient } from './hubspot';
import { getAssociatedIds } from './associations';

// ============================================================================
// Matching rule
// ============================================================================

/** lowercase, all non-alphanumerics removed. */
export function normName(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokens(s: string): Set<string> {
  return new Set(
    (s || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}

/** 100 exact (normalized), 90 substring either way, else shared-token count. */
export function scoreCompanyMatch(programname: string, companyName: string): number {
  const np = normName(programname);
  const nc = normName(companyName);
  if (!np || !nc) return 0;
  if (np === nc) return 100;
  if (np.includes(nc) || nc.includes(np)) return 90;
  let shared = 0;
  const ct = tokens(companyName);
  for (const t of tokens(programname)) if (ct.has(t)) shared++;
  return shared;
}

export interface DealCompany {
  id: string;
  name: string;
}

/**
 * Pick the company matching programname. Confident only when the best score
 * is >= 1 AND no *different* company ties it (an ambiguous tie is not a
 * confident match). Returns null when not confident.
 */
export function pickCompanyForProgram(
  programname: string,
  companies: DealCompany[]
): DealCompany | null {
  if (!programname || companies.length === 0) return null;
  let best: DealCompany | null = null;
  let bestScore = 0;
  let tie = false;
  for (const c of companies) {
    const s = scoreCompanyMatch(programname, c.name);
    if (s > bestScore) {
      best = c;
      bestScore = s;
      tie = false;
    } else if (s === bestScore && s > 0 && best && normName(c.name) !== normName(best.name)) {
      tie = true;
    }
  }
  if (!best || bestScore < 1 || tie) return null;
  return best;
}

/** "Matching" for allow/keep decisions: exact or substring, not token-only. */
export const CONFIDENT_SCORE = 90;

// ============================================================================
// HubSpot reads/writes
// ============================================================================

export async function getDealCompanies(dealId: string): Promise<DealCompany[]> {
  const ids = await getAssociatedIds('deals', dealId, 'companies');
  return Promise.all(
    ids.map(async (id) => {
      try {
        const c: any = await hubspotClient.crm.companies.basicApi.getById(id, ['name']);
        return { id, name: c?.properties?.name ?? '' };
      } catch {
        return { id, name: '' };
      }
    })
  );
}

/** Remove every deal→company association except `keepId`. */
async function removeOtherCompanies(
  dealId: string,
  companies: DealCompany[],
  keepId: string
): Promise<string[]> {
  const removed: string[] = [];
  for (const c of companies) {
    if (c.id === keepId) continue;
    try {
      await hubspotClient.crm.associations.v4.basicApi.archive(
        'deals',
        dealId,
        'companies',
        c.id
      );
      removed.push(c.id);
    } catch (err: any) {
      console.warn(
        `[deal-company-guard] could not remove company ${c.id} from deal ${dealId}:`,
        err?.message
      );
    }
  }
  return removed;
}

/** Ensure the kept company carries the default (341) + Primary (5) types. */
async function ensurePrimaryCompany(dealId: string, companyId: string): Promise<void> {
  try {
    await hubspotClient.crm.associations.v4.basicApi.create(
      'deals',
      dealId,
      'companies',
      companyId,
      [
        { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 341 },
        { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 5 },
      ] as any
    );
  } catch (err: any) {
    console.warn(
      `[deal-company-guard] could not set primary company ${companyId} on deal ${dealId}:`,
      err?.message
    );
  }
}

// ============================================================================
// Reconciler (Safeguard B)
// ============================================================================

export type ReconcileStatus =
  | 'ok' // exactly one company, matches programname
  | 'fixed' // reduced to the matching company (apply=true)
  | 'would_fix' // reduction possible (apply=false)
  | 'zero_companies'
  | 'no_program'
  | 'single_mismatch' // one company but it doesn't match programname
  | 'no_confident_match'; // multiple companies, none/tied match

export interface ReconcileResult {
  status: ReconcileStatus;
  programname: string;
  companies: DealCompany[];
  kept?: DealCompany;
  removed: string[];
}

export async function reconcileDealCompany(
  dealId: string,
  programname: string,
  opts: { apply: boolean }
): Promise<ReconcileResult> {
  const companies = await getDealCompanies(dealId);
  const base = { programname, companies, removed: [] as string[] };

  if (companies.length === 0) return { ...base, status: 'zero_companies' };
  if (!programname.trim()) return { ...base, status: 'no_program' };

  if (companies.length === 1) {
    const s = scoreCompanyMatch(programname, companies[0].name);
    return {
      ...base,
      kept: companies[0],
      status: s >= CONFIDENT_SCORE ? 'ok' : 'single_mismatch',
    };
  }

  // Multiple companies: keep the confident match, drop the rest.
  const keep = pickCompanyForProgram(programname, companies);
  if (!keep || scoreCompanyMatch(programname, keep.name) < CONFIDENT_SCORE) {
    return { ...base, status: 'no_confident_match' };
  }
  if (!opts.apply) return { ...base, kept: keep, status: 'would_fix' };

  const removed = await removeOtherCompanies(dealId, companies, keep.id);
  await ensurePrimaryCompany(dealId, keep.id);
  console.log(
    `[deal-company-guard] deal ${dealId}: kept company ${keep.id} ("${keep.name}") for program "${programname}", removed ${removed.length} (${removed.join(', ')})`
  );
  return { ...base, kept: keep, removed, status: 'fixed' };
}

// ============================================================================
// Pre-send gate (Safeguard A)
// ============================================================================

export interface GateResult {
  allowed: boolean;
  autoFixed: boolean;
  status: ReconcileStatus;
  message: string;
  companies: DealCompany[];
}

/**
 * Validate (and when safely possible, repair) the deal's company link before
 * an enrollment email is queued. Never guesses: zero companies, a
 * non-matching single company, or an ambiguous multi-company set all block.
 */
export async function enrollmentSendGate(
  dealId: string,
  programname: string
): Promise<GateResult> {
  const result = await reconcileDealCompany(dealId, programname, { apply: true });
  switch (result.status) {
    case 'ok':
      return {
        allowed: true,
        autoFixed: false,
        status: result.status,
        message: 'Company link verified.',
        companies: result.companies,
      };
    case 'fixed':
      return {
        allowed: true,
        autoFixed: true,
        status: result.status,
        message: `Deal had ${result.companies.length} companies; kept "${result.kept?.name}" (matches the selected program) and removed ${result.removed.length}.`,
        companies: result.companies,
      };
    case 'zero_companies':
      return {
        allowed: false,
        autoFixed: false,
        status: result.status,
        message:
          'No camp (company) is linked to this deal, so the enrollment email has no recipient. Link the selected program\'s company to the deal, then retry.',
        companies: result.companies,
      };
    case 'no_program':
      return {
        allowed: false,
        autoFixed: false,
        status: result.status,
        message:
          'The deal has no program name set, so the right camp can\'t be verified. Set the program, then retry.',
        companies: result.companies,
      };
    case 'single_mismatch':
      return {
        allowed: false,
        autoFixed: false,
        status: result.status,
        message: `The company linked to this deal ("${result.companies[0]?.name}") doesn't match the selected program ("${programname}"). Fix the company link, then retry.`,
        companies: result.companies,
      };
    default:
      return {
        allowed: false,
        autoFixed: false,
        status: result.status,
        message: `This deal is linked to ${result.companies.length} companies and none clearly matches the selected program ("${programname}"). Remove the extra companies, then retry.`,
        companies: result.companies,
      };
  }
}
