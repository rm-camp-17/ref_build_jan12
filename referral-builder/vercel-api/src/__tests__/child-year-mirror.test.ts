/**
 * Tests for lib/child-year-mirror.ts.
 *
 * Mocks the HubSpot client + getAssociatedIds so we can drive the handler
 * through every interesting state without touching the network.
 *
 * Coverage:
 *   - Deal has no child (neither property nor association) → no-child
 *   - Active-stage deals exist → computes max + writes
 *   - All associated deals are Lost or New Lead → no-active-deals (sticky)
 *   - Computed max equals current Child.Year → unchanged, no write
 *   - Historic-pipeline deals are excluded from the max
 *   - Association fallback fires when associated_child_id property is empty
 */

jest.mock('../lib/hubspot', () => ({
  hubspotClient: {
    crm: {
      deals: {
        basicApi: { getById: jest.fn() },
        batchApi: { read: jest.fn() },
      },
      objects: {
        basicApi: { getById: jest.fn(), update: jest.fn() },
      },
    },
  },
}));

const mockGetAssociatedIds = jest.fn();
jest.mock('../lib/associations', () => ({
  getAssociatedIds: (...args: unknown[]) => mockGetAssociatedIds(...args),
}));

import { hubspotClient } from '../lib/hubspot';
import { mirrorChildYearForDeal } from '../lib/child-year-mirror';
import { config } from '../lib/config';

const mockHs = hubspotClient as any;

beforeEach(() => {
  jest.clearAllMocks();
});

function setTriggerDeal(associatedChildId: string | null) {
  mockHs.crm.deals.basicApi.getById.mockResolvedValueOnce({
    id: 'TRIGGER',
    properties: { associated_child_id: associatedChildId },
  });
}

function setBatchDeals(
  deals: Array<{ id: string; pipeline?: string | null; dealstage?: string | null; year1?: string | null }>
) {
  mockHs.crm.deals.batchApi.read.mockResolvedValue({
    results: deals.map((d) => ({
      id: d.id,
      properties: {
        pipeline: d.pipeline ?? 'default',
        dealstage: d.dealstage ?? null,
        year1: d.year1 ?? null,
      },
    })),
  });
}

function setChildYear(currentValue: string | null) {
  mockHs.crm.objects.basicApi.getById.mockResolvedValue({
    id: 'CHILD1',
    properties: {
      [config.properties.child.year]: currentValue,
    },
  });
}

describe('child-year-mirror — no child', () => {
  test('returns no-child when neither property nor association is set', async () => {
    setTriggerDeal(null);
    mockGetAssociatedIds.mockResolvedValueOnce([]); // no child association

    const r = await mirrorChildYearForDeal('TRIGGER');
    expect(r.reason).toBe('no-child');
    expect(r.wrote).toBe(false);
    expect(mockHs.crm.objects.basicApi.update).not.toHaveBeenCalled();
  });

  test('falls back to association when associated_child_id property is empty', async () => {
    setTriggerDeal('   '); // whitespace-only counts as empty
    mockGetAssociatedIds
      .mockResolvedValueOnce(['CHILD1']) // deal→child fallback
      .mockResolvedValueOnce(['DEAL1']); // child→deals
    setBatchDeals([
      { id: 'DEAL1', dealstage: config.stages.programSelected, year1: '2026' },
    ]);
    setChildYear(null);
    mockHs.crm.objects.basicApi.update.mockResolvedValue({});

    const r = await mirrorChildYearForDeal('TRIGGER');
    expect(r.childId).toBe('CHILD1');
    expect(r.reason).toBe('updated');
  });
});

describe('child-year-mirror — happy path', () => {
  test('writes max year when active-stage deals exist', async () => {
    setTriggerDeal('CHILD1');
    mockGetAssociatedIds.mockResolvedValueOnce(['DEAL1', 'DEAL2', 'DEAL3']);
    setBatchDeals([
      { id: 'DEAL1', dealstage: config.stages.recommendationPresented, year1: '2025' },
      { id: 'DEAL2', dealstage: config.stages.programSelected, year1: '2026' },
      { id: 'DEAL3', dealstage: config.stages.tuitionUndecided, year1: '2024' },
    ]);
    setChildYear('2024'); // stale

    const r = await mirrorChildYearForDeal('TRIGGER');
    expect(r.reason).toBe('updated');
    expect(r.computedYear).toBe(2026);
    expect(r.previousYear).toBe(2024);
    expect(r.wrote).toBe(true);
    expect(mockHs.crm.objects.basicApi.update).toHaveBeenCalledWith(
      config.objectTypes.child,
      'CHILD1',
      { properties: { [config.properties.child.year]: '2026' } }
    );
  });

  test('skips PATCH when computed equals current (idempotent)', async () => {
    setTriggerDeal('CHILD1');
    mockGetAssociatedIds.mockResolvedValueOnce(['DEAL1']);
    setBatchDeals([
      { id: 'DEAL1', dealstage: config.stages.programSelected, year1: '2026' },
    ]);
    setChildYear('2026'); // already correct

    const r = await mirrorChildYearForDeal('TRIGGER');
    expect(r.reason).toBe('unchanged');
    expect(r.wrote).toBe(false);
    expect(mockHs.crm.objects.basicApi.update).not.toHaveBeenCalled();
  });
});

describe('child-year-mirror — sticky semantics', () => {
  test('does nothing when only New Lead and Closed Lost deals exist', async () => {
    setTriggerDeal('CHILD1');
    mockGetAssociatedIds.mockResolvedValueOnce(['DEAL1', 'DEAL2']);
    setBatchDeals([
      { id: 'DEAL1', dealstage: 'appointmentscheduled', year1: '2027' }, // New Lead
      { id: 'DEAL2', dealstage: 'closedlost', year1: '2025' },
    ]);
    setChildYear('2024'); // older value should stay sticky

    const r = await mirrorChildYearForDeal('TRIGGER');
    expect(r.reason).toBe('no-active-deals');
    expect(r.wrote).toBe(false);
    expect(mockHs.crm.objects.basicApi.update).not.toHaveBeenCalled();
  });

  test('excludes Historic pipeline deals from max', async () => {
    setTriggerDeal('CHILD1');
    mockGetAssociatedIds.mockResolvedValueOnce(['DEAL1', 'DEAL2']);
    setBatchDeals([
      // Historic deal at higher year — must be excluded
      { id: 'DEAL1', pipeline: 'historic-2015-2025', dealstage: config.stages.programSelected, year1: '2024' },
      // Active deal at lower year — should win
      { id: 'DEAL2', pipeline: 'default', dealstage: config.stages.programSelected, year1: '2023' },
    ]);
    setChildYear(null);
    mockHs.crm.objects.basicApi.update.mockResolvedValue({});

    const r = await mirrorChildYearForDeal('TRIGGER');
    expect(r.computedYear).toBe(2023);
    expect(r.reason).toBe('updated');
  });
});
