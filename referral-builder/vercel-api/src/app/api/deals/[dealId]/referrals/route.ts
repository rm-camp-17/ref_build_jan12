/**
 * GET /api/deals/:dealId/referrals - List referrals for a deal
 *
 * Fetches all referrals associated with the specified deal,
 * including related company, program, and session details.
 *
 * HubSpot SDK v11.x compatible with correct API signatures.
 */

import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';
import { getAssociatedIds } from '@/lib/associations';

type Params = { dealId: string };

interface ReferralData {
  id: string;
  referralKey: string | null;
  outreachStatus: string | null;
  clientInterest: string | null;
  note: string;
  createdAt: string | null;
  company: { id: string; name: string } | null;
  program: { id: string; name: string } | null;
  session: {
    id: string;
    name: string;
    startDate?: string;
    endDate?: string;
    price?: string;
    weeks?: string;
  } | null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Params }
) {
  const { dealId } = params;

  if (!dealId || !/^\d+$/.test(dealId)) {
    return NextResponse.json(
      { error: 'Valid Deal ID is required' },
      { status: 400 }
    );
  }

  try {
    // Get referral IDs associated with deal using v4 API
    const referralIds = await getAssociatedIds('deals', dealId, config.objectTypes.referral);

    if (referralIds.length === 0) {
      return NextResponse.json({ results: [] });
    }

    // Fetch referral details with their associations
    const referralResults = await Promise.all(
      referralIds.map(async (referralId: string) => {
        try {
          // Fetch referral with properties
          const referral = await hubspotClient.crm.objects.basicApi.getById(
            config.objectTypes.referral,
            referralId,
            [
              config.properties.referral.key,
              config.properties.referral.outreach,
              config.properties.referral.interest,
              config.properties.referral.note,
              'hs_createdate',
            ]
          );

          // Get associated objects using v4 API
          const [companyIds, programIds, sessionIds] = await Promise.all([
            getAssociatedIds(config.objectTypes.referral, referralId, 'companies'),
            getAssociatedIds(config.objectTypes.referral, referralId, config.objectTypes.program),
            getAssociatedIds(config.objectTypes.referral, referralId, config.objectTypes.session),
          ]);

          // Fetch company details
          let companyData: { id: string; name: string } | null = null;
          if (companyIds.length > 0) {
            try {
              const company = await hubspotClient.crm.companies.basicApi.getById(
                companyIds[0],
                ['name']
              );
              companyData = {
                id: company.id,
                name: company.properties.name || 'Unnamed Company',
              };
            } catch (e) {
              console.warn(`[referrals] Failed to fetch company ${companyIds[0]}`);
            }
          }

          // Fetch program details - try multiple property names
          let programData: { id: string; name: string } | null = null;
          if (programIds.length > 0) {
            const programNameProps = [
              config.properties.program.name,
              'program_name',
              'hs_object_name',
              'hs_name',
            ];
            try {
              const program = await hubspotClient.crm.objects.basicApi.getById(
                config.objectTypes.program,
                programIds[0],
                programNameProps
              );
              // Find first property that has a value
              let programName = 'Unnamed Program';
              for (const prop of programNameProps) {
                if (program.properties[prop]) {
                  programName = program.properties[prop];
                  break;
                }
              }
              programData = {
                id: program.id,
                name: programName,
              };
            } catch (e) {
              console.warn(`[referrals] Failed to fetch program ${programIds[0]}`);
            }
          }

          // Fetch session details - try multiple property names
          let sessionData: ReferralData['session'] = null;
          if (sessionIds.length > 0) {
            const sessionNameProps = [
              config.properties.session.name,
              'session_name',
              'hs_object_name',
              'hs_name',
            ];
            const allSessionProps = [
              ...sessionNameProps,
              config.properties.session.startDate,
              config.properties.session.endDate,
              config.properties.session.price,
              config.properties.session.weeks,
            ];
            try {
              const session = await hubspotClient.crm.objects.basicApi.getById(
                config.objectTypes.session,
                sessionIds[0],
                allSessionProps
              );
              // Find first property that has a value for name
              let sessionName = 'Unnamed Session';
              for (const prop of sessionNameProps) {
                if (session.properties[prop]) {
                  sessionName = session.properties[prop];
                  break;
                }
              }
              sessionData = {
                id: session.id,
                name: sessionName,
                startDate: session.properties[config.properties.session.startDate] || undefined,
                endDate: session.properties[config.properties.session.endDate] || undefined,
                price: session.properties[config.properties.session.price] || undefined,
                weeks: session.properties[config.properties.session.weeks] || undefined,
              };
            } catch (e) {
              console.warn(`[referrals] Failed to fetch session ${sessionIds[0]}`);
            }
          }

          return {
            id: referral.id,
            referralKey: referral.properties[config.properties.referral.key],
            outreachStatus: referral.properties[config.properties.referral.outreach],
            clientInterest: referral.properties[config.properties.referral.interest],
            note: referral.properties[config.properties.referral.note] || '',
            createdAt: referral.properties.hs_createdate,
            company: companyData,
            program: programData,
            session: sessionData,
          };
        } catch (e: any) {
          console.error(`[referrals] Error fetching referral ${referralId}:`, e.message);
          return null;
        }
      })
    );

    // Filter out any failed fetches
    const validReferrals = referralResults.filter((r): r is ReferralData => r !== null);

    console.log(`[GET /api/deals/${dealId}/referrals] Found ${validReferrals.length} referrals`);
    return NextResponse.json({ results: validReferrals });
  } catch (error: any) {
    console.error('[GET /api/deals/*/referrals] Error:', error.message);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch referrals' },
      { status: 500 }
    );
  }
}
