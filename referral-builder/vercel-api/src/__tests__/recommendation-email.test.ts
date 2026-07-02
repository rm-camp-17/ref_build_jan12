/**
 * Tests for the quick recommendation email: company lookup mapping, the
 * deterministic compose, and the POST route contract.
 */

const mockCompanyGetById = jest.fn();
const mockOwnerGetById = jest.fn();
jest.mock('../lib/hubspot', () => ({
  hubspotClient: {
    crm: {
      companies: { basicApi: { getById: (...a: any[]) => mockCompanyGetById(...a) } },
      owners: { ownersApi: { getById: (...a: any[]) => mockOwnerGetById(...a) } },
    },
  },
}));

jest.mock('../lib/config', () => ({
  config: { hubspot: { accessToken: '' } }, // note logging disabled in tests
}));

jest.mock('../lib/deals', () => ({ getDeal: jest.fn() }));

jest.mock('../lib/require-deal-authorization', () => {
  class DealAuthorizationError extends Error {
    statusCode = 403 as const;
    body = { error: 'Forbidden', reason: 'x' };
  }
  return {
    requireDealAuthorization: jest.fn().mockResolvedValue(undefined),
    DealAuthorizationError,
  };
});

import { NextRequest } from 'next/server';
import {
  getEmailCamp,
  composeRecommendationEmail,
  type EmailCamp,
} from '../lib/recommendation-email';
import { POST } from '../app/api/v2/deal/[dealId]/recommendation-email/route';
import { getDeal } from '../lib/deals';

const mockGetDeal = getDeal as jest.Mock;

const CAMPS: EmailCamp[] = [
  {
    companyId: 'c1',
    displayName: 'Chestnut Lake',
    location: 'Beach Lake, PA',
    website: 'https://www.chestnutlakecamp.com',
    summary:
      'A warm, traditional co-ed camp with flexible 3- and 4-week sessions.',
  },
  {
    companyId: 'c2',
    displayName: 'Timber Lake West',
    location: 'Roscoe, NY',
    website: '',
    summary: '',
  },
];

describe('composeRecommendationEmail', () => {
  test('builds the bullets with name, location, website, and summary', () => {
    const email = composeRecommendationEmail(CAMPS, {
      summerYear: '2027',
      expertName: 'Denise Robbins',
    });
    expect(email.subject).toBe('Camp recommendations for summer 2027');
    // One header line per camp, full clickable URL inline (no duplicate line).
    expect(email.body).toContain(
      '• Chestnut Lake (Beach Lake, PA) — https://www.chestnutlakecamp.com'
    );
    expect(email.body).toContain('flexible 3- and 4-week sessions');
    // Camp with no website/summary still gets its bullet.
    expect(email.body).toContain('• Timber Lake West (Roscoe, NY)');
    // Signed with the expert's first name only.
    expect(email.body.trim().endsWith('Denise')).toBe(true);
    // Placeholder greeting the rep replaces.
    expect(email.body).toContain('Hi [Parent name],');
    // The camp with no summary is flagged for the rep.
    expect(email.campsMissingSummary).toEqual(['Timber Lake West']);
  });

  test('handles a missing year and expert gracefully', () => {
    const email = composeRecommendationEmail(CAMPS, {
      summerYear: '',
      expertName: '',
    });
    expect(email.subject).toBe('Camp recommendations for summer');
    expect(email.body).toContain('[Your name]');
  });
});

describe('getEmailCamp', () => {
  test('prefers short_program_name and the recommendation website field', async () => {
    mockCompanyGetById.mockResolvedValueOnce({
      properties: {
        name: 'TRAILS END /CHESTNUT LAKE',
        short_program_name: 'Chestnut Lake',
        website_for_recommendation_entry: 'chestnutlakecamp.com',
        website: 'http://www.trailsendcamp.com',
        city: 'BEACH LAKE',
        state: 'PA',
        four_sentence_summary_for_parents: 'Warm and traditional.',
      },
    });
    const camp = await getEmailCamp('c1');
    expect(camp.displayName).toBe('Chestnut Lake');
    expect(camp.website).toBe('https://chestnutlakecamp.com');
    expect(camp.location).toBe('Beach Lake, PA');
    expect(camp.summary).toBe('Warm and traditional.');
  });

  test('title-cases an ALL-CAPS name when no short name exists', async () => {
    mockCompanyGetById.mockResolvedValueOnce({
      properties: { name: 'TYLER HILL CAMP' },
    });
    const camp = await getEmailCamp('c9');
    expect(camp.displayName).toBe('Tyler Hill Camp');
    expect(camp.website).toBe('');
  });
});

describe('POST /recommendation-email', () => {
  function postReq(body: unknown): NextRequest {
    return new NextRequest(
      'http://localhost/api/v2/deal/100/recommendation-email',
      { method: 'POST', body: JSON.stringify(body) }
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDeal.mockResolvedValue({
      id: '100',
      year1: '2027',
      hubspot_owner_id: '7',
    });
    mockOwnerGetById.mockResolvedValue({ firstName: 'Denise', lastName: 'R' });
    mockCompanyGetById.mockResolvedValue({
      properties: {
        name: 'Chestnut Lake',
        website: 'https://www.chestnutlakecamp.com',
        four_sentence_summary_for_parents: 'Warm and traditional.',
      },
    });
  });

  test('composes and returns the email', async () => {
    const res = await POST(postReq({ companyIds: ['c1'] }), {
      params: { dealId: '100' },
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.success).toBe(true);
    expect(json.subject).toContain('2027');
    expect(json.body).toContain('Chestnut Lake');
    expect(json.body).toContain('Warm and traditional.');
    expect(json.campsMissingSummary).toEqual([]);
  });

  test('400 when no companyIds', async () => {
    const res = await POST(postReq({ companyIds: [] }), {
      params: { dealId: '100' },
    });
    expect(res.status).toBe(400);
  });

  test('404 when the deal does not exist', async () => {
    mockGetDeal.mockResolvedValue(null);
    const res = await POST(postReq({ companyIds: ['c1'] }), {
      params: { dealId: '100' },
    });
    expect(res.status).toBe(404);
  });
});
