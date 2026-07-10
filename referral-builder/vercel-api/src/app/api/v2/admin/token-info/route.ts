/**
 * GET /api/v2/admin/token-info — which HubSpot app does our token belong to?
 *
 * Introspects the server's own HUBSPOT_ACCESS_TOKEN via HubSpot's
 * private-app token-info endpoint and reports the app id, hub id, and the
 * scopes ACTUALLY granted to the token right now. Built to settle "which
 * private app is the API using, and did the scope change take effect?"
 * without anyone comparing token strings by hand.
 *
 * Never returns the token itself — only its prefix ("pat-na1") and last 4
 * characters so it can be matched against the HubSpot UI safely.
 *
 * Response: { appId, hubId, userId, tokenHint, scopes: string[] }
 */

import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET() {
  const token = config.hubspot.accessToken;
  if (!token) {
    return NextResponse.json(
      { error: 'HUBSPOT_ACCESS_TOKEN is not set.' },
      { status: 500 }
    );
  }

  const tokenHint = `${token.slice(0, 7)}…${token.slice(-4)}`;
  const isPat = token.startsWith('pat-');

  try {
    const resp = await fetch(
      'https://api.hubapi.com/oauth/v2/private-apps/get/access-token-info',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenKey: token }),
        cache: 'no-store',
      }
    );
    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return NextResponse.json(
        {
          error: `Token introspection failed (HTTP ${resp.status}). ${
            isPat
              ? ''
              : 'Token does not start with "pat-" — it may be a legacy API key, which this endpoint cannot introspect.'
          }`,
          tokenHint,
          detail: data?.message || null,
        },
        { status: 502 }
      );
    }
    return NextResponse.json({
      appId: data?.appId ?? null,
      hubId: data?.hubId ?? null,
      userId: data?.userId ?? null,
      tokenHint,
      scopes: Array.isArray(data?.scopes) ? data.scopes.sort() : [],
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Token introspection error: ${err?.message}`, tokenHint },
      { status: 500 }
    );
  }
}
