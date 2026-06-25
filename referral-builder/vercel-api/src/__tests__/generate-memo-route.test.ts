/**
 * Integration test for the async memo route:
 *   POST /api/v2/deal/[dealId]/generate-memo  → starts a job (returns jobId)
 *   GET  ...?jobId=...                          → polls status
 *
 * The heavy work runs in `waitUntil` after the response; we mock waitUntil to
 * capture the promise so we can await it and assert the background outcome
 * (job marked done / error, notifier fired). All heavy collaborators are mocked.
 */

const mockConfig = {
  memo: {
    anthropicApiKey: 'test-key',
    model: 'claude-sonnet-4-6',
    filesFolderPath: 'memos',
    writeupSource: 'seed',
  },
  properties: { company: { programId: 'programid' } },
};
jest.mock('@/lib/config', () => ({ config: mockConfig }));

const mockWaitUntil = jest.fn();
jest.mock('@vercel/functions', () => ({
  waitUntil: (p: Promise<unknown>) => mockWaitUntil(p),
}));

const mockCreateJob = jest.fn().mockResolvedValue('job-1');
const mockGetJob = jest.fn();
const mockMarkDone = jest.fn().mockResolvedValue(undefined);
const mockMarkError = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/memo-jobs', () => ({
  ensureMemoJobsTable: jest.fn().mockResolvedValue(undefined),
  createMemoJob: (...a: any[]) => mockCreateJob(...a),
  getMemoJob: (...a: any[]) => mockGetJob(...a),
  markMemoJobDone: (...a: any[]) => mockMarkDone(...a),
  markMemoJobError: (...a: any[]) => mockMarkError(...a),
}));

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
import { POST, GET } from '../app/api/v2/deal/[dealId]/generate-memo/route';
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

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/v2/deal/100/generate-memo', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}
function getReq(jobId?: string): NextRequest {
  const q = jobId ? `?jobId=${encodeURIComponent(jobId)}` : '';
  return new NextRequest(`http://localhost/api/v2/deal/100/generate-memo${q}`, {
    method: 'GET',
  });
}
/** Drain the work handed to waitUntil so the background job completes. */
async function runBackground() {
  const p = mockWaitUntil.mock.calls[0]?.[0];
  if (p) await p;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.memo.anthropicApiKey = 'test-key';
  mockCreateJob.mockResolvedValue('job-1');

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

describe('POST generate-memo (start a job)', () => {
  test('returns a pending jobId immediately and runs the work in the background', async () => {
    const res = await POST(postReq({ companyIds: ['c1', 'c2'], specialInstructions: 'warm' }), {
      params: { dealId: '100' },
    });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.success).toBe(true);
    expect(json.jobId).toBe('job-1');
    expect(json.status).toBe('pending');
    expect(mockWaitUntil).toHaveBeenCalledTimes(1);
    // The heavy work has NOT run synchronously (it's deferred to waitUntil).
    expect(mockCompose).not.toHaveBeenCalled();

    // Drain the background work and assert it composed + delivered + marked done.
    await runBackground();
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
    expect(mockMarkDone).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({
        fileUrl: 'https://files.example/abc.docx',
        campsIncluded: ['Chestnut Lake', 'Timber Lake West'],
        limitedInfoCamps: ['Timber Lake West'],
      })
    );
  });

  test('400 when no companyIds provided — no job created', async () => {
    const res = await POST(postReq({ companyIds: [] }), { params: { dealId: '100' } });
    expect(res.status).toBe(400);
    expect(mockCreateJob).not.toHaveBeenCalled();
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  test('503 when ANTHROPIC_API_KEY is not configured — no job created', async () => {
    mockConfig.memo.anthropicApiKey = '';
    const res = await POST(postReq({ companyIds: ['c1'] }), { params: { dealId: '100' } });
    expect(res.status).toBe(503);
    expect(mockCreateJob).not.toHaveBeenCalled();
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  test('composer failure marks the job error + notifies (response still 200)', async () => {
    mockCompose.mockRejectedValueOnce(new MemoComposeError('Claude declined.'));
    const res = await POST(postReq({ companyIds: ['c1'] }), { params: { dealId: '100' } });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.jobId).toBe('job-1');

    await runBackground();
    expect(mockMarkDone).not.toHaveBeenCalled();
    expect(mockMarkError).toHaveBeenCalledWith('job-1', 'Claude declined.');
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'generate-memo', dealId: '100' })
    );
  });
});

describe('GET generate-memo (poll status)', () => {
  test('pending → status pending', async () => {
    mockGetJob.mockResolvedValue({ id: 'job-1', deal_id: '100', status: 'pending' });
    const res = await GET(getReq('job-1'), { params: { dealId: '100' } });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('pending');
  });

  test('done → returns file url + parsed camp lists', async () => {
    mockGetJob.mockResolvedValue({
      id: 'job-1',
      deal_id: '100',
      status: 'done',
      file_url: 'https://files.example/abc.docx',
      file_name: 'Conway.docx',
      camps_included: JSON.stringify(['Chestnut Lake', 'Timber Lake West']),
      limited_info: JSON.stringify(['Timber Lake West']),
    });
    const res = await GET(getReq('job-1'), { params: { dealId: '100' } });
    const json: any = await res.json();
    expect(json.status).toBe('done');
    expect(json.fileUrl).toBe('https://files.example/abc.docx');
    expect(json.campsIncluded).toEqual(['Chestnut Lake', 'Timber Lake West']);
    expect(json.limitedInfoCamps).toEqual(['Timber Lake West']);
  });

  test('error → surfaces the recorded message', async () => {
    mockGetJob.mockResolvedValue({
      id: 'job-1',
      deal_id: '100',
      status: 'error',
      error: 'HubSpot Files upload failed: missing files scope.',
    });
    const res = await GET(getReq('job-1'), { params: { dealId: '100' } });
    const json: any = await res.json();
    expect(json.success).toBe(false);
    expect(json.status).toBe('error');
    expect(json.message).toContain('missing files scope');
  });

  test('400 when jobId is missing', async () => {
    const res = await GET(getReq(), { params: { dealId: '100' } });
    expect(res.status).toBe(400);
    expect(mockGetJob).not.toHaveBeenCalled();
  });

  test('404 when the job is unknown', async () => {
    mockGetJob.mockResolvedValue(null);
    const res = await GET(getReq('nope'), { params: { dealId: '100' } });
    expect(res.status).toBe(404);
  });
});
