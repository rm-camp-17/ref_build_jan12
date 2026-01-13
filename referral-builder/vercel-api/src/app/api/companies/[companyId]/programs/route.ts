import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';

type Params = { companyId: string };

export async function GET(
  req: NextRequest,
  { params }: { params: Params }
) {
  const { companyId } = params;

  if (!companyId) {
    return NextResponse.json(
      { error: 'Company ID is required' },
      { status: 400 }
    );
  }

  try {
    // Fetch programs associated with this company
    const associationsResult = await hubspotClient.crm.associations.batchApi.read(
      'companies',
      config.objectTypes.program,
      { inputs: [{ id: companyId }] }
    );

    if (
      associationsResult.results.length === 0 ||
      !associationsResult.results[0].to
    ) {
      return NextResponse.json({ results: [] });
    }

    const programIds = associationsResult.results[0].to.map(
      (assoc: any) => assoc.toObjectId
    );

    // Fetch program details
    const programs = await Promise.all(
      programIds.map(async (programId: string) => {
        const program = await hubspotClient.crm.objects.basicApi.getById(
          config.objectTypes.program,
          programId,
          ['name']
        );
        return {
          id: program.id,
          name: program.properties.name || 'Unnamed Program',
        };
      })
    );

    return NextResponse.json({ results: programs });
  } catch (error: any) {
    console.error('Failed to fetch programs:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch programs' },
      { status: 500 }
    );
  }
}
