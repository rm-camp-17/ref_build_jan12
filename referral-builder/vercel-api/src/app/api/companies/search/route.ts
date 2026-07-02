/**
 * GET /api/companies/search?q={query}[&includeInactive=1]
 *
 * Search companies by name for the Create Referral form.
 *
 * By default only Active partners are returned — inactive camps shouldn't be
 * recommended to new families. `includeInactive=1` drops that filter so a rep
 * can create the billing referral for a RETURNING camper at an inactive
 * partner (e.g. Wa-Klo): the family re-enrolled directly, we still bill the
 * camp, and billing needs the referral → Selected → tuition chain on the
 * deal. Each result carries `partnerStatus` so the card can label non-Active
 * camps and default them to "don't send".
 *
 * HubSpot SDK v11.x compatible.
 */

import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';

interface CompanyData {
  id: string;
  name: string;
  partnerStatus: string | null;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get('q')?.trim();
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100);
  const includeInactive = searchParams.get('includeInactive') === '1';

  if (!query || query.length < 2) {
    return NextResponse.json(
      { error: 'Search query must be at least 2 characters' },
      { status: 400 }
    );
  }

  try {
    const filters: Array<Record<string, unknown>> = [
      {
        propertyName: 'name',
        operator: 'CONTAINS_TOKEN' as any,
        value: query.endsWith('*') ? query : `${query}*`,
      },
    ];
    if (!includeInactive) {
      filters.push({
        propertyName: config.properties.company.status,
        operator: 'EQ' as any,
        value: 'Active',
      });
    }

    const searchResults = await hubspotClient.crm.companies.searchApi.doSearch({
      filterGroups: [{ filters }],
      properties: ['name', config.properties.company.status],
      sorts: ['name'],
      after: '0',
      limit,
    } as any);

    const statusProp = config.properties.company.status;
    const results: CompanyData[] = (searchResults.results || []).map((company: any) => ({
      id: company.id,
      name: company.properties.name || `Company ${company.id}`,
      partnerStatus: company.properties?.[statusProp] ?? null,
    }));

    console.log(`[GET /api/companies/search?q=${query}] Found ${results.length} companies`);
    return NextResponse.json({ results });
  } catch (error: any) {
    console.error('[GET /api/companies/search] Error:', error.message);
    return NextResponse.json(
      { error: error.message || 'Failed to search companies' },
      { status: 500 }
    );
  }
}
