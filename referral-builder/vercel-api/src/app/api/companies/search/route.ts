/**
 * GET /api/companies/search?q={query} - Search companies by name
 *
 * Searches for companies matching the query string.
 *
 * HubSpot SDK v11.x compatible.
 */

import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';

interface CompanyData {
  id: string;
  name: string;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get('q')?.trim();
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100);

  if (!query || query.length < 2) {
    return NextResponse.json(
      { error: 'Search query must be at least 2 characters' },
      { status: 400 }
    );
  }

  try {
    const searchResults = await hubspotClient.crm.companies.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            {
              propertyName: 'name',
              operator: 'CONTAINS_TOKEN' as any,
              value: query.endsWith('*') ? query : `${query}*`,
            },
            {
              propertyName: config.properties.company.status,
              operator: 'EQ' as any,
              value: 'Active',
            },
          ],
        },
      ],
      properties: ['name', config.properties.company.status],
      sorts: ['name'],
      after: '0',
      limit,
    });

    const results: CompanyData[] = (searchResults.results || []).map((company: any) => ({
      id: company.id,
      name: company.properties.name || `Company ${company.id}`,
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
