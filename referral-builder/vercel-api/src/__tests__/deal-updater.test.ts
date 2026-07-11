/**
 * Unit tests for the session-selection deal-updater services.
 *
 * Mocks the Postgres + HubSpot deps so the property-mapping logic can be
 * tested without a live DB. Integration tests against real Postgres land
 * once we have a staging EXTERNAL_DATABASE_URL wired up.
 */

jest.mock('../lib/sessions', () => ({
  getSessionById: jest.fn(),
}));

jest.mock('../lib/companies', () => ({
  getCompanyByProgramId: jest.fn(),
  findCompanyIdByName: jest.fn().mockResolvedValue(null),
}));

jest.mock('../lib/deals', () => ({
  updateDeal: jest.fn().mockResolvedValue(undefined),
  associateDealToCompany: jest.fn().mockResolvedValue(undefined),
  getDeal: jest.fn().mockResolvedValue(null),
  reconcileDealName: jest.fn((opts: any) => opts.currentName ?? ''),
}));

jest.mock('../lib/error-notifier', () => ({
  notifyPipelineFailure: jest.fn().mockResolvedValue(undefined),
}));

import { getSessionById } from '../lib/sessions';
import { getCompanyByProgramId, findCompanyIdByName } from '../lib/companies';
import { updateDeal, associateDealToCompany, getDeal } from '../lib/deals';
import { notifyPipelineFailure } from '../lib/error-notifier';
import { selectSession, selectCustomSession } from '../lib/deal-updater';

const mockGetSession = getSessionById as jest.Mock;
const mockGetCompany = getCompanyByProgramId as jest.Mock;
const mockFindByName = findCompanyIdByName as jest.Mock;
const mockUpdateDeal = updateDeal as jest.Mock;
const mockAssociate = associateDealToCompany as jest.Mock;
const mockGetDeal = getDeal as jest.Mock;
const mockNotify = notifyPipelineFailure as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDeal.mockResolvedValue(null);
  mockFindByName.mockResolvedValue(null);
  mockNotify.mockResolvedValue(undefined);
});

describe('selectSession', () => {
  test('writes session fields to deal + advances stage to Program Selected', async () => {
    mockGetSession.mockResolvedValue({
      id: 42,
      name: 'Session 2A',
      startDateRaw: '2026-07-14',
      endDateRaw: '2026-08-04',
      tuition: 5000,
      currency: 'USD',
      weeks: 3,
    });
    mockGetCompany.mockResolvedValue({
      hsObjectId: '700',
      name: 'Camp Sunshine',
      programid: '1544',
    });

    const result = await selectSession('100', '42', '1544');

    expect(result.success).toBe(true);
    expect(result.properties).toMatchObject({
      tuition_at_enrollment: '5000',
      amount: '5000',
      lengthofstay: '3',
      deal_currency_code: 'USD',
      session_start_date: '2026-07-14',
      session_end_date: '2026-08-04',
      session_name: 'Session 2A',
      session_id: '42',
      dealstage: 'decisionmakerboughtin',
    });
    // closedate = today's ISO date
    expect(result.properties.closedate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.properties.note_1).toContain('Session 2A');
    expect(mockUpdateDeal).toHaveBeenCalledWith('100', expect.any(Object));
    expect(mockAssociate).toHaveBeenCalledWith('100', '700');
  });

  test('returns error when session not found', async () => {
    mockGetSession.mockResolvedValue(null);

    const result = await selectSession('100', '999', '1544');

    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
    expect(mockUpdateDeal).not.toHaveBeenCalled();
  });

  test('no programId and no resolvable company → alerts admin instead of silently skipping', async () => {
    mockGetSession.mockResolvedValue({
      id: 42,
      name: 'Session 1',
      startDateRaw: '2026-06-01',
      endDateRaw: '2026-06-08',
      tuition: 1000,
      currency: 'USD',
      weeks: 1,
    });

    const result = await selectSession('100', '42', null);

    expect(result.success).toBe(true);
    expect(mockUpdateDeal).toHaveBeenCalled();
    expect(mockAssociate).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'deal-company-association', dealId: '100' })
    );
  });

  test('non-fatal: failed company-association does not fail the whole op', async () => {
    mockGetSession.mockResolvedValue({
      id: 42,
      name: 'Session',
      startDateRaw: '2026-07-01',
      endDateRaw: '2026-07-15',
      tuition: 2000,
      currency: 'USD',
      weeks: 2,
    });
    mockGetCompany.mockResolvedValue({ hsObjectId: '700', name: 'Camp', programid: '1' });
    mockAssociate.mockRejectedValueOnce(new Error('association failed'));

    const result = await selectSession('100', '42', '1');

    expect(result.success).toBe(true);
    expect(mockUpdateDeal).toHaveBeenCalled(); // deal write succeeded
  });
});

describe('selectCustomSession', () => {
  test('writes inputs AND advances dealstage to Program Selected (item 6)', async () => {
    const result = await selectCustomSession('100', {
      description: 'Mountain biking week',
      tuition: 1500,
      currency: 'CAD',
      weeks: 1,
    });

    expect(result.success).toBe(true);
    expect(result.properties).toMatchObject({
      tuition_at_enrollment: '1500',
      amount: '1500',
      lengthofstay: '1',
      deal_currency_code: 'CAD',
      session_name: 'Mountain biking week',
      // Item 6: custom "Other" now advances like a preset session.
      dealstage: 'decisionmakerboughtin',
    });
    // closedate = today's ISO date
    expect(result.properties.closedate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.properties.note_1).toContain('CUSTOM session');
    // Session pointer fields NOT written (unknown for custom sessions)
    expect(result.properties.session_start_date).toBeUndefined();
    expect(result.properties.session_end_date).toBeUndefined();
    expect(result.properties.session_id).toBeUndefined();
  });

  test('defaults description to "Custom session" when blank', async () => {
    const result = await selectCustomSession('100', {
      description: '',
      tuition: 1000,
      currency: 'USD',
      weeks: 1,
    });

    expect(result.properties.session_name).toBe('Custom session');
    expect(result.properties.note_1).toContain('Custom session');
  });

  test('defaults currency to USD when blank', async () => {
    const result = await selectCustomSession('100', {
      description: 'Demo',
      tuition: 1000,
      currency: '',
      weeks: 1,
    });

    expect(result.properties.deal_currency_code).toBe('USD');
  });

  // Regression: the 2026-07-10 incident — every custom-session close won
  // (Szuster ×4, Budd) landed with ZERO companies because this path never
  // associated the camp. It must resolve via the deal's own program fields.
  test('associates the camp company via the deal program_id (incident regression)', async () => {
    mockGetDeal.mockResolvedValue({
      id: '100',
      dealname: 'Leo Szuster | 2026',
      programname: 'KIMAMA MIAMI',
      program_id: '3016',
    });
    mockGetCompany.mockResolvedValue({ hsObjectId: '800', name: 'KIMAMA MIAMI' });

    const result = await selectCustomSession('100', {
      description: '1 week at Kimama Miami',
      tuition: 800,
      currency: 'USD',
      weeks: 1,
    });

    expect(result.success).toBe(true);
    expect(mockGetCompany).toHaveBeenCalledWith('3016');
    expect(mockAssociate).toHaveBeenCalledWith('100', '800');
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('falls back to programname lookup when program_id misses', async () => {
    mockGetDeal.mockResolvedValue({
      id: '100',
      dealname: 'Luca Szuster | 2026',
      programname: 'DAYTRIPPERS',
      program_id: null,
    });
    mockFindByName.mockResolvedValue('900');

    await selectCustomSession('100', {
      description: '2 weeks',
      tuition: 425,
      currency: 'USD',
      weeks: 2,
    });

    expect(mockFindByName).toHaveBeenCalledWith('DAYTRIPPERS');
    expect(mockAssociate).toHaveBeenCalledWith('100', '900');
    expect(mockNotify).not.toHaveBeenCalled();
  });

  test('alerts admin when no company can be resolved (never silent)', async () => {
    mockGetDeal.mockResolvedValue({
      id: '100',
      dealname: 'Some Kid | 2026',
      programname: 'UNKNOWN CAMP NAME',
      program_id: null,
    });

    const result = await selectCustomSession('100', {
      description: 'Custom',
      tuition: 500,
      currency: 'USD',
      weeks: 1,
    });

    expect(result.success).toBe(true); // the close itself still succeeds
    expect(mockAssociate).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'deal-company-association', dealId: '100' })
    );
  });

  test('association failure is non-fatal to the close', async () => {
    mockGetDeal.mockResolvedValue({
      id: '100',
      dealname: 'Kid | 2026',
      programname: 'KIMAMA MIAMI',
      program_id: '3016',
    });
    mockGetCompany.mockResolvedValue({ hsObjectId: '800', name: 'KIMAMA MIAMI' });
    mockAssociate.mockRejectedValueOnce(new Error('boom'));

    const result = await selectCustomSession('100', {
      description: 'Custom',
      tuition: 500,
      currency: 'USD',
      weeks: 1,
    });

    expect(result.success).toBe(true);
  });
});
