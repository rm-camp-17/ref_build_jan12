/**
 * GET /api/v2/family/[objectType]/[objectId]/overview
 *
 * Family-wide deal overview for the Family Deals card, rendered on Child,
 * Household, and Parent (contact) records. `objectType` is one of
 * child | household | contact. Returns the household id, the kids, and every
 * deal summarized (category open/won/lost, status label, camp, tuition,
 * weeks, per-deal child).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getFamilyOverview, type FamilyObjectType } from '@/lib/family';

export const runtime = 'nodejs';
export const maxDuration = 60;

const VALID_TYPES: ReadonlyArray<FamilyObjectType> = [
  'child',
  'household',
  'contact',
];

export async function GET(
  _req: NextRequest,
  { params }: { params: { objectType: string; objectId: string } }
) {
  const { objectType, objectId } = params;

  if (!VALID_TYPES.includes(objectType as FamilyObjectType)) {
    return NextResponse.json(
      { error: `objectType must be one of: ${VALID_TYPES.join(', ')}` },
      { status: 400 }
    );
  }
  if (!objectId || !/^\d+$/.test(objectId)) {
    return NextResponse.json(
      { error: 'A valid object ID is required.' },
      { status: 400 }
    );
  }

  try {
    const overview = await getFamilyOverview(
      objectType as FamilyObjectType,
      objectId
    );
    return NextResponse.json(overview);
  } catch (err: any) {
    console.error(
      `[v2/family/overview] error for ${objectType} ${objectId}:`,
      err?.message,
      err?.stack
    );
    return NextResponse.json(
      { error: 'Failed to load the family overview.' },
      { status: 500 }
    );
  }
}
