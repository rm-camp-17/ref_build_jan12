import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';
import { createAssociation, getAssociationTypeId } from '@/lib/associations';

export async function POST(req: NextRequest) {
  const body = await req.json();

  const {
    dealId,
    companyId,
    programId,
    sessionId,
    note,
    outreachStatus,     // ✅ REQUIRED - internal value
    clientInterest,     // ✅ REQUIRED - internal value
    associateToDeal,    // ✅ NEW FLAG - create Deal↔Company association
  } = body;

  // Validation
  if (!dealId || !companyId) {
    return NextResponse.json(
      { error: 'dealId and companyId are required' },
      { status: 400 }
    );
  }

  if (!outreachStatus || !clientInterest) {
    return NextResponse.json(
      { error: 'outreachStatus and clientInterest are required' },
      { status: 400 }
    );
  }

  // Build referral properties
  const referralKey = `${dealId}-${companyId}`;
  const properties: Record<string, any> = {
    [config.properties.referral.key]: referralKey,
    [config.properties.referral.outreach]: outreachStatus,   // Use internal value
    [config.properties.referral.interest]: clientInterest,   // Use internal value
    [config.properties.referral.note]: note || '',
    [config.properties.referral.name]: `Referral for Deal ${dealId}`,
  };

  let referralId: string;
  let created = false;

  try {
    // Step 1: Search for existing referral by key (upsert logic)
    const searchResults = await hubspotClient.crm.objects.searchApi.doSearch(
      config.objectTypes.referral,
      {
        filterGroups: [
          {
            filters: [
              {
                propertyName: config.properties.referral.key,
                operator: 'EQ',
                value: referralKey,
              },
            ],
          },
        ],
        limit: 1,
      }
    );

    if (searchResults.results.length > 0) {
      // Update existing referral
      referralId = searchResults.results[0].id;
      await hubspotClient.crm.objects.basicApi.update(
        config.objectTypes.referral,
        referralId,
        { properties }
      );
      created = false;
      console.log(`✓ Updated referral: ${referralId}`);
    } else {
      // Create new referral
      const createResult = await hubspotClient.crm.objects.basicApi.create(
        config.objectTypes.referral,
        { properties }
      );
      referralId = createResult.id;
      created = true;
      console.log(`✓ Created referral: ${referralId}`);
    }
  } catch (error: any) {
    console.error('Failed to create/update referral:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to create referral' },
      { status: 500 }
    );
  }

  // Step 2: Create associations to Deal, Company, Program, Session
  try {
    const associationsToCreate: Array<{
      toType: string;
      toId: string;
    }> = [
      { toType: 'deals', toId: dealId },
      { toType: 'companies', toId: companyId },
    ];

    if (programId) {
      associationsToCreate.push({
        toType: config.objectTypes.program,
        toId: programId,
      });
    }

    if (sessionId) {
      associationsToCreate.push({
        toType: config.objectTypes.session,
        toId: sessionId,
      });
    }

    for (const assoc of associationsToCreate) {
      await createAssociation(
        referralId,
        config.objectTypes.referral,
        assoc.toId,
        assoc.toType
      );
    }
  } catch (error: any) {
    console.error('Failed to create associations:', error);
    // Don't fail the entire request if associations fail
  }

  // Step 3: ✅ NEW - Create Deal↔Company association if requested
  if (associateToDeal === true) {
    try {
      const dealToCompanyTypeId = await getAssociationTypeId(
        'deals',
        'companies'
      );

      await hubspotClient.crm.associations.batchApi.create({
        inputs: [
          {
            from: { id: dealId },
            to: { id: companyId },
            types: [
              {
                associationCategory: 'HUBSPOT_DEFINED',
                associationTypeId: dealToCompanyTypeId,
              },
            ],
          },
        ],
      });
      console.log(`✓ Created Deal↔Company association: ${dealId} ↔ ${companyId}`);
    } catch (error: any) {
      console.error('Failed to create Deal↔Company association:', error);
      // Don't fail the entire request
    }
  }

  return NextResponse.json({
    ok: true,
    referralId,
    created,
    updated: !created,
  });
}
