/**
 * GET /api/programs/:programId/sessions - Get sessions for a program
 *
 * Fetches all sessions associated with the specified program.
 *
 * HubSpot SDK v11.x compatible with correct API signatures.
 */

import { NextRequest, NextResponse } from 'next/server';
import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';
import { getAssociatedIds } from '@/lib/associations';

type Params = { programId: string };

interface SessionData {
  id: string;
  name: string;
  displayName: string; // Formatted: "Name (Start - End)" for dropdown
  startDate?: string;
  endDate?: string;
  price?: string;
  weeks?: string;
}

/**
 * Format a date string for display (e.g., "2026-01-15" -> "Jan 15, 2026")
 */
function formatDate(dateStr: string | undefined): string | undefined {
  if (!dateStr) return undefined;
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

/**
 * Build display name for session dropdown: "Name (Start - End)"
 */
function buildSessionDisplayName(name: string, startDate?: string, endDate?: string): string {
  const formattedStart = formatDate(startDate);
  const formattedEnd = formatDate(endDate);

  if (formattedStart && formattedEnd) {
    return `${name} (${formattedStart} - ${formattedEnd})`;
  } else if (formattedStart) {
    return `${name} (${formattedStart})`;
  } else if (formattedEnd) {
    return `${name} (ends ${formattedEnd})`;
  }
  return name;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Params }
) {
  const { programId } = params;

  if (!programId || !/^\d+$/.test(programId)) {
    return NextResponse.json(
      { error: 'Valid Program ID is required' },
      { status: 400 }
    );
  }

  try {
    // Get session IDs associated with program using v4 API
    const sessionIds = await getAssociatedIds(
      config.objectTypes.program,
      programId,
      config.objectTypes.session
    );

    if (sessionIds.length === 0) {
      return NextResponse.json({ results: [] });
    }

    // Fetch session details - try multiple common property names for the display name
    const nameProperties = [
      config.properties.session.name,
      'session_name',
      'hs_object_name',
      'hs_name',
    ];

    const allProperties = [
      ...nameProperties,
      config.properties.session.startDate,
      config.properties.session.endDate,
      config.properties.session.price,
      config.properties.session.weeks,
    ];

    const sessions: SessionData[] = await Promise.all(
      sessionIds.map(async (sessionId: string) => {
        try {
          const session = await hubspotClient.crm.objects.basicApi.getById(
            config.objectTypes.session,
            sessionId,
            allProperties
          );

          // Try each property name to find the display name
          let displayName = 'Unnamed Session';
          for (const prop of nameProperties) {
            if (session.properties[prop]) {
              displayName = session.properties[prop];
              break;
            }
          }

          // Log available properties for debugging if name not found
          if (displayName === 'Unnamed Session') {
            console.warn(
              `[sessions] Session ${sessionId} has no name in properties:`,
              Object.keys(session.properties).filter(k => !k.startsWith('hs_'))
            );
          }

          const startDate = session.properties[config.properties.session.startDate] || undefined;
          const endDate = session.properties[config.properties.session.endDate] || undefined;

          return {
            id: session.id,
            name: displayName,
            displayName: buildSessionDisplayName(displayName, startDate, endDate),
            startDate,
            endDate,
            price: session.properties[config.properties.session.price] || undefined,
            weeks: session.properties[config.properties.session.weeks] || undefined,
          };
        } catch (e: any) {
          console.warn(`[sessions] Failed to fetch session ${sessionId}:`, e.message);
          return {
            id: sessionId,
            name: `Session ${sessionId}`,
            displayName: `Session ${sessionId}`,
          };
        }
      })
    );

    // Sort by start date (if available), then by name
    sessions.sort((a, b) => {
      if (a.startDate && b.startDate) {
        return a.startDate.localeCompare(b.startDate);
      }
      if (a.startDate) return -1;
      if (b.startDate) return 1;
      return a.name.localeCompare(b.name);
    });

    console.log(`[GET /api/programs/${programId}/sessions] Found ${sessions.length} sessions`);
    return NextResponse.json({ results: sessions });
  } catch (error: any) {
    console.error('[GET /api/programs/*/sessions] Error:', error.message);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch sessions' },
      { status: 500 }
    );
  }
}
