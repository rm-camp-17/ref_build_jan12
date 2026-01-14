import { NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';

export async function GET() {
  try {
    // Fetch property definitions for referral enums
    const [statusProp, interestProp] = await Promise.all([
      hubspotClient.crm.properties.coreApi.getByName(
        config.objectTypes.referral,
        config.properties.referral.outreach
      ),
      hubspotClient.crm.properties.coreApi.getByName(
        config.objectTypes.referral,
        config.properties.referral.interest
      ),
    ]);

    // Debug: Log what HubSpot returns
    console.log('[GET /api/referrals/properties] Status property options from HubSpot:',
      JSON.stringify(statusProp.options?.slice(0, 3), null, 2));
    console.log('[GET /api/referrals/properties] Interest property options from HubSpot:',
      JSON.stringify(interestProp.options?.slice(0, 3), null, 2));

    // Extract options EXACTLY as HubSpot returns them
    // HubSpot properties can use labels as internal values (non-standard but valid)
    const properties = {
      [config.properties.referral.outreach]: {
        name: statusProp.name,
        label: statusProp.label,
        options:
          statusProp.options?.map((opt) => ({
            label: opt.label,
            value: opt.value, // Use EXACTLY what HubSpot returns
          })) || [],
      },
      [config.properties.referral.interest]: {
        name: interestProp.name,
        label: interestProp.label,
        options:
          interestProp.options?.map((opt) => ({
            label: opt.label,
            value: opt.value, // Use EXACTLY what HubSpot returns
          })) || [],
      },
    };

    console.log('[GET /api/referrals/properties] Returning to frontend:',
      JSON.stringify({
        statusOptions: properties[config.properties.referral.outreach].options.slice(0, 3),
        interestOptions: properties[config.properties.referral.interest].options.slice(0, 3),
      }, null, 2));

    return NextResponse.json({ properties });
  } catch (error: any) {
    console.error('Failed to load properties:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to load properties' },
      { status: 500 }
    );
  }
}
