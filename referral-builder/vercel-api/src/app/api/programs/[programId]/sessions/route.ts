import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';

type Params = { programId: string };

export async function GET(
  req: NextRequest,
  { params }: { params: Params }
) {
  const { programId } = params;

  if (!programId) {
    return NextResponse.json(
      { error: 'Program ID is required' },
      { status: 400 }
    );
  }

  try {
    // Fetch sessions associated with this program
    const associationsResult = await hubspotClient.crm.associations.batchApi.read(
      config.objectTypes.program,
      config.objectTypes.session,
      { inputs: [{ id: programId }] }
    );

    if (
      associationsResult.results.length === 0 ||
      !associationsResult.results[0].to
    ) {
      return NextResponse.json({ results: [] });
    }

    const sessionIds = associationsResult.results[0].to.map(
      (assoc: any) => assoc.toObjectId
    );

    // Fetch session details
    const sessions = await Promise.all(
      sessionIds.map(async (sessionId: string) => {
        const session = await hubspotClient.crm.objects.basicApi.getById(
          config.objectTypes.session,
          sessionId,
          ['name', 'start_date', 'end_date', 'price', 'weeks']
        );
        return {
          id: session.id,
          name: session.properties.name || 'Unnamed Session',
          startDate: session.properties.start_date || null,
          endDate: session.properties.end_date || null,
          price: session.properties.price || null,
          weeks: session.properties.weeks || null,
        };
      })
    );

    return NextResponse.json({ results: sessions });
  } catch (error: any) {
    console.error('Failed to fetch sessions:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch sessions' },
      { status: 500 }
    );
  }
}
