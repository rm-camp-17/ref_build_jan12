/**
 * Tests for the sacred-field audit log (spec §5.1).
 *
 * Coverage:
 *   - 3 sacred fields change → 1 audit note containing all 3 changes
 *     (one note per PATCH, batched).
 *   - Non-sacred field change → no audit note.
 *   - Sacred field "change" that's a no-op (same value) → no audit note.
 *
 * The audit log is written via
 * `hubspotClient.crm.objects.notes.basicApi.create` and is best-effort
 * — failures don't propagate. We test the call SHAPE and the
 * triggering rules.
 */

jest.mock('../lib/hubspot', () => ({
  hubspotClient: {
    crm: {
      deals: {
        basicApi: {
          getById: jest.fn(),
          update: jest.fn().mockResolvedValue(undefined),
        },
      },
      objects: {
        notes: {
          basicApi: {
            create: jest.fn().mockResolvedValue({}),
          },
        },
      },
      owners: {
        ownersApi: {
          // deal_split_email validation: every email in these tests
          // resolves to a real owner so `updateDeal` proceeds to the
          // audit-log step.
          getPage: jest.fn().mockResolvedValue({
            results: [
              { id: '12345', email: 'alice@campexperts.com', firstName: 'A', lastName: 'A' },
            ],
          }),
        },
      },
    },
  },
}));

import { hubspotClient } from '../lib/hubspot';
import { updateDeal } from '../lib/deals';

const mockHubspot = hubspotClient as any;

function mockBefore(values: Record<string, string | null>) {
  mockHubspot.crm.deals.basicApi.getById.mockResolvedValue({
    properties: values,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: deal has no current sacred-field values.
  mockBefore({});
});

describe('Sacred-field audit log (spec §5.1)', () => {
  test('3 sacred fields change → audit note created with all 3 changes', async () => {
    mockBefore({
      expertprofile: 'Old Expert',
      referred_by: '',
      split_type: 'percentage',
      deal_split_email: '',
      deal_split_pct: '50',
    });

    await updateDeal('100', {
      expertprofile: 'New Expert',
      referred_by: 'Referrer Name',
      // split_type unchanged — should NOT appear in note
      split_type: 'percentage',
      // deal_split_pct changed
      deal_split_pct: '75',
    });

    // Exactly one note created.
    expect(
      mockHubspot.crm.objects.notes.basicApi.create
    ).toHaveBeenCalledTimes(1);

    const noteArg =
      mockHubspot.crm.objects.notes.basicApi.create.mock.calls[0][0];
    const body = noteArg.properties.hs_note_body as string;

    // Contains the audit-log marker.
    expect(body).toContain('[sacred-field-audit]');

    // Captures the 3 actual changes.
    expect(body).toContain('field: expertprofile');
    expect(body).toContain('"Old Expert"');
    expect(body).toContain('"New Expert"');

    expect(body).toContain('field: referred_by');
    expect(body).toContain('"Referrer Name"');

    expect(body).toContain('field: deal_split_pct');
    expect(body).toContain('"50"');
    expect(body).toContain('"75"');

    // Does NOT include the unchanged split_type.
    expect(body).not.toContain('field: split_type');

    // Note is associated to the deal via Note → Deal default association (typeId 214).
    expect(noteArg.associations).toEqual([
      expect.objectContaining({
        to: { id: '100' },
        types: expect.arrayContaining([
          expect.objectContaining({ associationTypeId: 214 }),
        ]),
      }),
    ]);
  });

  test('non-sacred field change → no audit note', async () => {
    mockBefore({});

    await updateDeal('100', {
      tuition_at_enrollment: '5000',
      amount: '5000',
      lengthofstay: '4',
      note_1: 'Some note',
    });

    // The deal PATCH happened.
    expect(mockHubspot.crm.deals.basicApi.update).toHaveBeenCalled();

    // The audit note did NOT.
    expect(
      mockHubspot.crm.objects.notes.basicApi.create
    ).not.toHaveBeenCalled();
  });

  test('sacred field PATCH with no actual value change → no audit note', async () => {
    mockBefore({ expertprofile: 'Same Expert' });

    await updateDeal('100', { expertprofile: 'Same Expert' });

    expect(
      mockHubspot.crm.objects.notes.basicApi.create
    ).not.toHaveBeenCalled();
  });
});
