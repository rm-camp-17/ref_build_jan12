import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';

type Params = { dealId: string };

export async function GET(
  req: NextRequest,
  { params }: { params: Params }
) {
  const { dealId } = params;

  if (!dealId) {
    return NextResponse.json(
      { error: 'Deal ID is required' },
      { status: 400 }
    );
  }

  try {
    // Fetch referrals associated with this deal
    const associationsResult = await hubspotClient.crm.associations.batchApi.read(
      'deals',
      config.objectTypes.referral,
      { inputs: [{ id: dealId }] }
    );

    if (
      associationsResult.results.length === 0 ||
      !associationsResult.results[0].to
    ) {
      return NextResponse.json({ results: [] });
    }

    const referralIds = associationsResult.results[0].to.map(
      (assoc: any) => assoc.toObjectId
    );

    // Fetch referral details with associations
    const referrals = await Promise.all(
      referralIds.map(async (referralId: string) => {
        const referral = await hubspotClient.crm.objects.basicApi.getById(
          config.objectTypes.referral,
          referralId,
          [
            config.properties.referral.key,
            config.properties.referral.outreach,
            config.properties.referral.interest,
            config.properties.referral.note,
            'hs_createdate', // ✅ CRITICAL: Include created timestamp
          ],
          undefined,
          ['companies', config.objectTypes.program, config.objectTypes.session],
          false
        );

        // Extract associated objects
        const company = referral.associations?.companies?.[0];
        const program = referral.associations?.[config.objectTypes.program]?.[0];
        const session = referral.associations?.[config.objectTypes.session]?.[0];

        // Fetch details for associated objects
        let companyData = null;
        let programData = null;
        let sessionData = null;

        if (company?.id) {
          const companyObj = await hubspotClient.crm.companies.basicApi.getById(
            company.id,
            ['name']
          );
          companyData = {
            id: companyObj.id,
            name: companyObj.properties.name || 'Unnamed Company',
          };
        }

        if (program?.id) {
          const programObj = await hubspotClient.crm.objects.basicApi.getById(
            config.objectTypes.program,
            program.id,
            ['name']
          );
          programData = {
            id: programObj.id,
            name: programObj.properties.name || 'Unnamed Program',
          };
        }

        if (session?.id) {
          const sessionObj = await hubspotClient.crm.objects.basicApi.getById(
            config.objectTypes.session,
            session.id,
            ['name', 'start_date', 'end_date', 'price', 'weeks']
          );
          sessionData = {
            id: sessionObj.id,
            name: sessionObj.properties.name || 'Unnamed Session',
            startDate: sessionObj.properties.start_date || null,
            endDate: sessionObj.properties.end_date || null,
            price: sessionObj.properties.price || null,
            weeks: sessionObj.properties.weeks || null,
          };
        }

        return {
          id: referral.id,
          referralKey: referral.properties[config.properties.referral.key],
          outreachStatus: referral.properties[config.properties.referral.outreach],
          clientInterest: referral.properties[config.properties.referral.interest],
          note: referral.properties[config.properties.referral.note] || '',
          createdAt: referral.properties.hs_createdate, // ✅ RETURN TIMESTAMP
          company: companyData,
          program: programData,
          session: sessionData,
        };
      })
    );

    return NextResponse.json({ results: referrals });
  } catch (error: any) {
    console.error('Failed to fetch referrals:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch referrals' },
      { status: 500 }
    );
  }
}
