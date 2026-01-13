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

    // Extract options with INTERNAL values
    const properties = {
      [config.properties.referral.outreach]: {
        name: statusProp.name,
        label: statusProp.label,
        options:
          statusProp.options?.map((opt) => ({
            label: opt.label,
            value: opt.value, // ✅ This is the internal value
          })) || [],
      },
      [config.properties.referral.interest]: {
        name: interestProp.name,
        label: interestProp.label,
        options:
          interestProp.options?.map((opt) => ({
            label: opt.label,
            value: opt.value, // ✅ This is the internal value
          })) || [],
      },
    };

    return NextResponse.json({ properties });
  } catch (error: any) {
    console.error('Failed to load properties:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to load properties' },
      { status: 500 }
    );
  }
}
