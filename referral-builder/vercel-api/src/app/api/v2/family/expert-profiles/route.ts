/**
 * GET /api/v2/family/expert-profiles
 *
 * The deal `expertprofile` enum options, for the Add Deal dropdown in the
 * Family Deals card. Cached per warm process on the lib side.
 */

import { NextResponse } from 'next/server';
import { getExpertProfileOptions } from '@/lib/family';

export const runtime = 'nodejs';
// A parameterless GET is otherwise statically prerendered at build time,
// where no HubSpot token exists — force per-request evaluation.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const options = await getExpertProfileOptions();
    return NextResponse.json({ options });
  } catch (err: any) {
    console.error('[v2/family/expert-profiles] error:', err?.message);
    return NextResponse.json(
      { error: 'Failed to load expert profiles.' },
      { status: 500 }
    );
  }
}
