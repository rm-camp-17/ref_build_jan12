/**
 * GET /api/companies/:companyId/programs - Get programs for a company
 *
 * Fetches all programs associated with the specified company.
 *
 * HubSpot SDK v11.x compatible with correct API signatures.
 */

import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';
import { getAssociatedIds } from '@/lib/associations';

type Params = { companyId: string };

interface ProgramData {
  id: string;
  name: string;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Params }
) {
  const { companyId } = params;

  if (!companyId || !/^\d+$/.test(companyId)) {
    return NextResponse.json(
      { error: 'Valid Company ID is required' },
      { status: 400 }
    );
  }

  try {
    // Get program IDs associated with company using v4 API
    const programIds = await getAssociatedIds('companies', companyId, config.objectTypes.program);

    if (programIds.length === 0) {
      return NextResponse.json({ results: [] });
    }

    // Fetch program details
    const programs: ProgramData[] = await Promise.all(
      programIds.map(async (programId: string) => {
        try {
          const program = await hubspotClient.crm.objects.basicApi.getById(
            config.objectTypes.program,
            programId,
            [config.properties.program.name]
          );
          return {
            id: program.id,
            name: program.properties[config.properties.program.name] || 'Unnamed Program',
          };
        } catch (e: any) {
          console.warn(`[programs] Failed to fetch program ${programId}:`, e.message);
          return {
            id: programId,
            name: `Program ${programId}`,
          };
        }
      })
    );

    // Sort by name
    programs.sort((a, b) => a.name.localeCompare(b.name));

    console.log(`[GET /api/companies/${companyId}/programs] Found ${programs.length} programs`);
    return NextResponse.json({ results: programs });
  } catch (error: any) {
    console.error('[GET /api/companies/*/programs] Error:', error.message);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch programs' },
      { status: 500 }
    );
  }
}
