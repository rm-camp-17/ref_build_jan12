/**
 * Tests for GET /api/companies/search — the Active-only default and the
 * includeInactive escape hatch that lets reps create billing referrals for
 * returning campers at inactive partners (e.g. Wa-Klo).
 */

const mockDoSearch = jest.fn();
jest.mock('../lib/hubspot', () => ({
  hubspotClient: {
    crm: { companies: { searchApi: { doSearch: (...a: any[]) => mockDoSearch(...a) } } },
  },
}));

import { NextRequest } from 'next/server';
import { GET } from '../app/api/companies/search/route';

function req(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: 'GET' });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDoSearch.mockResolvedValue({
    results: [
      { id: '1', properties: { name: 'WA-KLO', partner_status: 'Inactive' } },
      { id: '2', properties: { name: 'WALDEN', partner_status: 'Active' } },
    ],
  });
});

describe('GET /api/companies/search', () => {
  test('defaults to Active-only (partner_status filter present)', async () => {
    const res = await GET(req('/api/companies/search?q=wa'));
    expect(res.status).toBe(200);
    const filters = mockDoSearch.mock.calls[0][0].filterGroups[0].filters;
    expect(filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ propertyName: 'partner_status', value: 'Active' }),
      ])
    );
  });

  test('includeInactive=1 drops the status filter and returns partnerStatus', async () => {
    const res = await GET(req('/api/companies/search?q=wa&includeInactive=1'));
    expect(res.status).toBe(200);
    const filters = mockDoSearch.mock.calls[0][0].filterGroups[0].filters;
    expect(filters).toHaveLength(1); // name filter only
    expect(filters[0].propertyName).toBe('name');
    const json: any = await res.json();
    expect(json.results).toEqual([
      { id: '1', name: 'WA-KLO', partnerStatus: 'Inactive' },
      { id: '2', name: 'WALDEN', partnerStatus: 'Active' },
    ]);
  });

  test('400 on a too-short query', async () => {
    const res = await GET(req('/api/companies/search?q=w'));
    expect(res.status).toBe(400);
    expect(mockDoSearch).not.toHaveBeenCalled();
  });
});
