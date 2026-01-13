import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get('q') || '';
  const limit = parseInt(searchParams.get('limit') || '20', 10);

  if (!query) {
    return NextResponse.json(
      { error: 'Query parameter "q" is required' },
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
              operator: 'CONTAINS_TOKEN',
              value: query,
            },
          ],
        },
      ],
      properties: ['name'],
      limit,
      sorts: [{ propertyName: 'name', direction: 'ASCENDING' }],
    });

    const results = searchResults.results.map((company) => ({
      id: company.id,
      name: company.properties.name || 'Unnamed Company',
    }));

    return NextResponse.json({ results });
  } catch (error: any) {
    console.error('Company search failed:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to search companies' },
      { status: 500 }
    );
  }
}
