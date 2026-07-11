/**
 * Company (camp/provider) lookups via HubSpot.
 *
 * The unified card needs company data in two situations:
 *   1. Looking up commission/billing fields by `programid` (the legacy ID
 *      that joins to the external session DB) — used by the clone-for-year
 *      flow to copy commission settings.
 *   2. Resolving the company associated to a deal — already covered by the
 *      v4 associations API in `lib/associations.ts`.
 *
 * Hub side of the contract:
 *   Deal.program_id  →  Company.programid  →  companies.access_id (Postgres)
 */

import { hubspotClient } from './hubspot';
import { config } from './config';
import {
  pickCompanyForProgram,
  scoreCompanyMatch,
  CONFIDENT_SCORE,
} from './deal-company-guard';

// ============================================================================
// Types
// ============================================================================

export interface CompanyForBilling {
  hsObjectId: string;
  programid: string | null;
  name: string | null;
  commissionRate: string | null;
  commissionType: string | null;
  tfsWeeks: string | null;
  fixedFeeOptions: string | null;
}

const COMPANY_COMMISSION_PROPERTIES: ReadonlyArray<string> = [
  config.properties.company.programId, // 'programid'
  'name',
  'commission_rate',
  'commission_type',
  'tfs_weeks',
  'fixed_fee_options',
];

// ============================================================================
// Lookups
// ============================================================================

/**
 * Find a company by its `programid` (the legacy external ID — same value
 * that lives on `companies.access_id` in the session Postgres). Returns
 * `null` if no match. Throws on transport errors.
 */
export async function getCompanyByProgramId(
  programId: string | number
): Promise<CompanyForBilling | null> {
  const programIdStr = String(programId);

  try {
    const response = await hubspotClient.crm.companies.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            {
              propertyName: config.properties.company.programId,
              operator: 'EQ' as any,
              value: programIdStr,
            },
          ],
        },
      ],
      properties: [...COMPANY_COMMISSION_PROPERTIES],
      sorts: [],
      limit: 1,
      after: '0',
    });

    if (!response.results || response.results.length === 0) {
      console.warn(`[companies] No company found for programid=${programIdStr}`);
      return null;
    }

    const result = response.results[0];
    const props = result.properties;

    return {
      hsObjectId: result.id,
      programid: props[config.properties.company.programId] ?? null,
      name: props.name ?? null,
      commissionRate: props.commission_rate ?? null,
      commissionType: props.commission_type ?? null,
      tfsWeeks: props.tfs_weeks ?? null,
      fixedFeeOptions: props.fixed_fee_options ?? null,
    };
  } catch (err: any) {
    console.error(
      `[companies] Error searching company by programid=${programIdStr}:`,
      err.message
    );
    throw err;
  }
}

/**
 * Resolve a company id by (program) name — the backstop for the
 * deal→company association when `program_id` is missing or doesn't match
 * any company. `programname` on deals is written from the company's name,
 * so an exact match usually hits; otherwise a token search scored by the
 * §8 matching rule (deal-company-guard) picks a single confident match.
 * Ambiguity returns null — for a billing-critical link we never guess.
 */
export async function findCompanyIdByName(name: string): Promise<string | null> {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;
  try {
    const exact: any = await hubspotClient.crm.companies.searchApi.doSearch({
      filterGroups: [
        { filters: [{ propertyName: 'name', operator: 'EQ' as any, value: trimmed }] },
      ],
      properties: ['name'],
      sorts: [],
      limit: 2,
      after: '0',
    });
    if (exact?.results?.length === 1) return String(exact.results[0].id);

    const firstToken = trimmed.split(/[^A-Za-z0-9]+/).filter(Boolean)[0];
    if (!firstToken) return null;
    const tokens: any = await hubspotClient.crm.companies.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            { propertyName: 'name', operator: 'CONTAINS_TOKEN' as any, value: firstToken },
          ],
        },
      ],
      properties: ['name'],
      sorts: [],
      limit: 20,
      after: '0',
    });
    const candidates = (tokens?.results || []).map((r: any) => ({
      id: String(r.id),
      name: r.properties?.name || '',
    }));
    const pick = pickCompanyForProgram(trimmed, candidates);
    if (pick && scoreCompanyMatch(trimmed, pick.name) >= CONFIDENT_SCORE) {
      return pick.id;
    }
    return null;
  } catch (err: any) {
    console.warn(`[companies] name lookup failed for "${trimmed}":`, err?.message);
    return null;
  }
}
