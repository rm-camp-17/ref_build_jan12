/**
 * Tests for server-side `deal_split_email` validation (spec §6.2).
 *
 * Coverage:
 *   - Valid email → resolves to owner, deal write proceeds.
 *   - Typo'd email → throws `DealSplitEmailNotFoundError` (HTTP 422).
 *   - Empty / unset → no owner lookup, write proceeds.
 *
 * Surface tested: `updateDeal()` from `lib/deals.ts`. That function
 * gates on the validation BEFORE calling HubSpot's deal-update API,
 * which is exactly what the spec requires (no HubSpot writes if the
 * email doesn't resolve).
 */

jest.mock('../lib/hubspot', () => ({
  hubspotClient: {
    crm: {
      deals: {
        basicApi: {
          getById: jest.fn().mockResolvedValue({ properties: {} }),
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
          getPage: jest.fn(),
        },
      },
    },
  },
}));

import { hubspotClient } from '../lib/hubspot';
import { updateDeal, DealSplitEmailNotFoundError } from '../lib/deals';

const mockHubspot = hubspotClient as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockHubspot.crm.deals.basicApi.getById.mockResolvedValue({ properties: {} });
  mockHubspot.crm.deals.basicApi.update.mockResolvedValue(undefined);
  mockHubspot.crm.objects.notes.basicApi.create.mockResolvedValue({});
});

describe('updateDeal — deal_split_email server-side validation (§6.2)', () => {
  test('valid email resolves to owner → write proceeds', async () => {
    mockHubspot.crm.owners.ownersApi.getPage.mockResolvedValue({
      results: [
        {
          id: '12345',
          email: 'alice@campexperts.com',
          firstName: 'Alice',
          lastName: 'Aspis',
        },
      ],
    });

    await expect(
      updateDeal('100', { deal_split_email: 'alice@campexperts.com' })
    ).resolves.toBeUndefined();

    // Owners API was queried with the email.
    expect(mockHubspot.crm.owners.ownersApi.getPage).toHaveBeenCalledWith(
      'alice@campexperts.com',
      undefined,
      1,
      false
    );
    // The deal PATCH happened.
    expect(mockHubspot.crm.deals.basicApi.update).toHaveBeenCalledWith('100', {
      properties: { deal_split_email: 'alice@campexperts.com' },
    });
  });

  test("typo'd email returns no match → throws DealSplitEmailNotFoundError (422)", async () => {
    mockHubspot.crm.owners.ownersApi.getPage.mockResolvedValue({
      results: [],
    });

    await expect(
      updateDeal('100', { deal_split_email: 'alice@campexpert.com' }) // missing trailing 's'
    ).rejects.toBeInstanceOf(DealSplitEmailNotFoundError);

    // Importantly: NO HubSpot deal write happened.
    expect(mockHubspot.crm.deals.basicApi.update).not.toHaveBeenCalled();

    // Verify the error shape matches what routes will surface.
    try {
      await updateDeal('100', { deal_split_email: 'alice@campexpert.com' });
    } catch (e: any) {
      expect(e).toBeInstanceOf(DealSplitEmailNotFoundError);
      expect(e.field).toBe('deal_split_email');
      expect(e.httpStatus).toBe(422);
      expect(e.userMessage).toMatch(/does not match any HubSpot expert/);
    }
  });

  test('empty deal_split_email skips owner lookup, write proceeds', async () => {
    await expect(
      updateDeal('100', { deal_split_email: '' })
    ).resolves.toBeUndefined();

    expect(mockHubspot.crm.owners.ownersApi.getPage).not.toHaveBeenCalled();
    expect(mockHubspot.crm.deals.basicApi.update).toHaveBeenCalled();
  });

  test('non-email patches skip owner lookup', async () => {
    await expect(
      updateDeal('100', { tuition_at_enrollment: '5000', amount: '5000' })
    ).resolves.toBeUndefined();

    expect(mockHubspot.crm.owners.ownersApi.getPage).not.toHaveBeenCalled();
    expect(mockHubspot.crm.deals.basicApi.update).toHaveBeenCalled();
  });
});
