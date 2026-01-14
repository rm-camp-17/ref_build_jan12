import { NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';

/**
 * Generate internal value from label (slug/snake_case transformation)
 * This handles cases where HubSpot returns labels as values
 */
function labelToInternalValue(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove special chars except word chars and spaces
    .trim()
    .replace(/\s+/g, '_'); // Replace spaces with underscores
}

/**
 * Known internal values for validation
 * If HubSpot returns a label as the value, we'll transform it
 */
const KNOWN_STATUS_VALUES = new Set([
  'draft',
  'ready_to_send',
  'sent',
  'resend',
  'dont_send',
]);

const KNOWN_INTEREST_VALUES = new Set([
  'active_considering',
  'shortlist',
  'neutral',
  'unlikely',
  'declined',
  'selected',
]);

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
      JSON.stringify(statusProp.options?.slice(0, 2), null, 2));
    console.log('[GET /api/referrals/properties] Interest property options from HubSpot:',
      JSON.stringify(interestProp.options?.slice(0, 2), null, 2));

    // Extract options with INTERNAL values
    // Handle case where HubSpot returns labels as values (misconfigured property)
    const properties = {
      [config.properties.referral.outreach]: {
        name: statusProp.name,
        label: statusProp.label,
        options:
          statusProp.options?.map((opt) => {
            // If the value is a label (not in known values), transform it
            const value = KNOWN_STATUS_VALUES.has(opt.value)
              ? opt.value
              : labelToInternalValue(opt.label);

            console.log(`[Properties] Status option: "${opt.label}" -> value: "${value}" (original: "${opt.value}")`);

            return {
              label: opt.label,
              value: value,
            };
          }) || [],
      },
      [config.properties.referral.interest]: {
        name: interestProp.name,
        label: interestProp.label,
        options:
          interestProp.options?.map((opt) => {
            // If the value is a label (not in known values), transform it
            const value = KNOWN_INTEREST_VALUES.has(opt.value)
              ? opt.value
              : labelToInternalValue(opt.label);

            console.log(`[Properties] Interest option: "${opt.label}" -> value: "${value}" (original: "${opt.value}")`);

            return {
              label: opt.label,
              value: value,
            };
          }) || [],
      },
    };

    console.log('[GET /api/referrals/properties] Returning to frontend:',
      JSON.stringify({
        statusOptions: properties[config.properties.referral.outreach].options.slice(0, 2),
        interestOptions: properties[config.properties.referral.interest].options.slice(0, 2),
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
