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
