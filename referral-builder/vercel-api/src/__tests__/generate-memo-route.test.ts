/**
 * Integration test for POST /api/v2/deal/[dealId]/generate-memo.
 *
 * All heavy collaborators (Claude composer, docx renderer, HubSpot Files,
 * sessions, write-ups) are mocked. We assert the route gathers per-camp source
 * material, composes + renders + delivers, returns the file URL + limited-info
 * flags, and handles validation / config / failure paths.
 */

const mockConfig = {
  memo: {
    anthropicApiKey: 'test-key',
    model: 'claude-opus-4-8',
    filesFolderPath: 'memos',
    writeupSource: 'seed',
  },
  properties: { company: { programId: 'programid' } },
};
jest.mock('@/lib/config', () => ({ config: mockConfig }));

jest.mock('@/lib/deals', () => ({ getDeal: jest.fn() }));

const mockCompanyGetById = jest.fn();
const mockOwnerGetById = jest.fn();
jest.mock('@/lib/hubspot', () => ({
  hubspotClient: {
    crm: {
      companies: { basicApi: { getById: (...a: any[]) => mockCompanyGetById(...a) } },
      owners: { ownersApi: { getById: (...a: any[]) => mockOwnerGetById(...a) } },
    },
  },
}));

jest.mock('@/lib/sessions', () => ({
  getSessionsForProgram: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/lib/writeups', () => ({ getWriteupForCompany: jest.fn() }));

jest.mock('@/lib/memo-compose', () => {
  class MemoComposeError extends Error {}
  return { MemoComposeError, composeMemo: jest.fn() };
});

jest.mock('@/lib/memo-docx', () => ({
  renderMemoDocx: jest.fn().mockResolvedValue(Buffer.from('PKfakezip')),
  memoFileName: jest.fn().mockReturnValue('Conway_Camp_Recommendations.docx'),
}));

jest.mock('@/lib/hubspot-files', () => ({
  deliverMemoToDeal: jest.fn().mockResolvedValue({
    fileId: 'file1',
    url: 'https://files.example/abc.docx',
    noteId: 'note1',
  }),
}));

jest.mock('@/lib/error-notifier', () => ({
  notifyPipelineFailure: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/require-deal-authorization', () => {
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
import { POST } from '../app/api/v2/deal/[dealId]/generate-memo/route';
import { getDeal } from '@/lib/deals';
import { getWriteupForCompany } from '@/lib/writeups';
import { composeMemo, MemoComposeError } from '@/lib/memo-compose';
import { renderMemoDocx } from '@/lib/memo-docx';
import { deliverMemoToDeal } from '@/lib/hubspot-files';
import { notifyPipelineFailure } from '@/lib/error-notifier';

const mockGetDeal = getDeal as jest.Mock;
const mockGetWriteup = getWriteupForCompany as jest.Mock;
const mockCompose = composeMemo as jest.Mock;
const mockDeliver = deliverMemoToDeal as jest.Mock;
const mockNotify = notifyPipelineFailure as jest.Mock;

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/v2/deal/100/generate-memo', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.memo.anthropicApiKey = 'test-key';

  mockGetDeal.mockResolvedValue({
    id: '100',
    dealname: 'Conway, Archie | 2027',
    year1: '2027',
    hubspot_owner_id: '7',
  });
  mockOwnerGetById.mockResolvedValue({
    firstName: 'Denise',
    lastName: 'R',
    email: 'denise@campexperts.com',
  });
  mockCompanyGetById.mockImplementation((id: string) =>
    Promise.resolve({
      properties: {
        name: id === 'c1' ? 'Chestnut Lake' : 'Timber Lake West',
        programid: id === 'c1' ? '555' : '',
      },
    })
  );
  mockGetWriteup.mockImplementation((name: string) =>
    Promise.resolve(
      name === 'Timber Lake West'
        ? null
        : {
            text: 'narrative',
            docType: 'writeup',
            source: 'seed',
            driveFileId: '1',
            matchScore: 90,
            campName: name,
          }
    )
  );
  mockCompose.mockResolvedValue({
    title: 'Camp Experts',
    preparedFor: 'Prepared for the Conway Family by Denise',
    subtitle: 'Summer 2027 — Camp Recommendations',
    forLine: '',
    table: [],
    summaries: [],
  });
});

describe('POST generate-memo', () => {
  test('happy path: composes, renders, delivers, returns url + limited-info flags', async () => {
    const res = await POST(makeReq({ companyIds: ['c1', 'c2'], specialInstructions: 'warm' }), {
      params: { dealId: '100' },
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.success).toBe(true);
    expect(json.fileUrl).toBe('https://files.example/abc.docx');
    expect(json.campsIncluded).toEqual(['Chestnut Lake', 'Timber Lake West']);
    expect(json.limitedInfoCamps).toEqual(['Timber Lake West']);

    // Composed with both camps + a context carrying the year and the dealname hint.
    const [campsArg, ctxArg] = mockCompose.mock.calls[0];
    expect(campsArg).toHaveLength(2);
    expect(ctxArg.summerYear).toBe('2027');
    expect(ctxArg.specialInstructions).toContain('Conway, Archie | 2027');
    expect(ctxArg.specialInstructions).toContain('warm');

    expect(renderMemoDocx).toHaveBeenCalled();
    expect(mockDeliver).toHaveBeenCalledWith(
      '100',
      expect.any(Buffer),
      'Conway_Camp_Recommendations.docx',
      expect.stringContaining('Chestnut Lake')
    );
  });

  test('400 when no companyIds provided', async () => {
    const res = await POST(makeReq({ companyIds: [] }), { params: { dealId: '100' } });
    expect(res.status).toBe(400);
    expect(mockCompose).not.toHaveBeenCalled();
  });

  test('503 when ANTHROPIC_API_KEY is not configured', async () => {
    mockConfig.memo.anthropicApiKey = '';
    const res = await POST(makeReq({ companyIds: ['c1'] }), { params: { dealId: '100' } });
    expect(res.status).toBe(503);
    expect(mockCompose).not.toHaveBeenCalled();
  });

  test('500 + notifier on composer failure, surfacing the MemoComposeError message', async () => {
    mockCompose.mockRejectedValueOnce(new MemoComposeError('Claude declined.'));
    const res = await POST(makeReq({ companyIds: ['c1'] }), { params: { dealId: '100' } });
    expect(res.status).toBe(500);
    const json: any = await res.json();
    expect(json.message).toBe('Claude declined.');
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'generate-memo', dealId: '100' })
    );
  });
});
