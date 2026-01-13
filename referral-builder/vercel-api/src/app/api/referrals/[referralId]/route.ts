import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';

type Params = { referralId: string };

export async function PATCH(
  req: NextRequest,
  { params }: { params: Params }
) {
  const { referralId } = params;
  const body = await req.json();

  if (!referralId) {
    return NextResponse.json(
      { error: 'Referral ID is required' },
      { status: 400 }
    );
  }

  if (!body.properties || typeof body.properties !== 'object') {
    return NextResponse.json(
      { error: 'properties object is required' },
      { status: 400 }
    );
  }

  try {
    await hubspotClient.crm.objects.basicApi.update(
      config.objectTypes.referral,
      referralId,
      { properties: body.properties }
    );

    console.log(`✓ Updated referral ${referralId}:`, body.properties);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('Failed to update referral:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to update referral' },
      { status: 500 }
    );
  }
}
