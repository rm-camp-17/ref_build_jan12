/**
 * GET /api/programs/search?q={query} - Search programs by name
 *
 * Searches for programs matching the query string.
 *
 * HubSpot SDK v11.x compatible.
 */

import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';

interface ProgramData {
  id: string;
  name: string;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get('q')?.trim();

  if (!query || query.length < 2) {
    return NextResponse.json(
      { error: 'Search query must be at least 2 characters' },
      { status: 400 }
    );
  }

  try {
    // Search programs by name
    const searchResult = await hubspotClient.crm.objects.searchApi.doSearch(
      config.objectTypes.program,
      {
        filterGroups: [
          {
            filters: [
              {
                propertyName: config.properties.program.name,
                operator: 'CONTAINS_TOKEN' as any,
                value: query,
              },
            ],
          },
        ],
        properties: [config.properties.program.name],
        sorts: [config.properties.program.name],
        after: '0',
        limit: 50,
      }
    );

    const programs: ProgramData[] = (searchResult.results || []).map((p: any) => ({
      id: p.id,
      name: p.properties[config.properties.program.name] || `Program ${p.id}`,
    }));

    console.log(`[GET /api/programs/search?q=${query}] Found ${programs.length} programs`);
    return NextResponse.json({ results: programs });
  } catch (error: any) {
    console.error('[GET /api/programs/search] Error:', error.message);
    return NextResponse.json(
      { error: error.message || 'Failed to search programs' },
      { status: 500 }
    );
  }
}
