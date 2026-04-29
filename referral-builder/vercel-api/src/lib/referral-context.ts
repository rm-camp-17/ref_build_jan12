/**
 * Find the Selected referral on a deal.
 *
 * The session-card view banner needs to show "Selecting session for {camp}
 * based on referral marked Selected" when the rep arrives at Tuition
 * Undecided. This module surfaces that.
 *
 * Contract: a deal has at most one Selected referral at a time
 * (UNIFIED_CARD_SPEC.md §9 invariant 1, enforced by the workflow).
 *
 * Property-name note: queries the canonical enum `client_interest`, NOT
 * the legacy label `referral_client_interest`. Per PROPERTY_NAME_AUDIT.md,
 * 8/25 records have data on the canonical name; the legacy label is not a
 * real property at all. Phase 3 cutover should backfill any records with
 * Selected interest that didn't make it through the legacy write path.
 */

import { hubspotClient } from './hubspot';
import { config } from './config';
import { getAssociatedIds } from './associations';

export interface ReferralContext {
  campName: string | null;
  referralId: string;
}

/**
 * Returns the Selected referral on this deal, or null if there isn't one.
 * Errors are swallowed (returned as null) — the banner is informational
 * and shouldn't break the card.
 */
export async function fetchReferralContext(
  dealId: string
): Promise<ReferralContext | null> {
  try {
    const referralIds = await getAssociatedIds(
      'deals',
      dealId,
      config.objectTypes.referral
    );
    if (referralIds.length === 0) {
      return null;
    }

    // Batch-read client_interest + company_name for all this deal's referrals.
    const batch = await hubspotClient.crm.objects.batchApi.read(
      config.objectTypes.referral,
      {
        inputs: referralIds.map((id) => ({ id })),
        properties: [
          config.properties.referral.interest,
          config.properties.referral.companyName,
        ],
        propertiesWithHistory: [],
      }
    );

    for (const result of batch.results) {
      const interest = result.properties[config.properties.referral.interest];
      if (interest && interest.toLowerCase() === 'selected') {
        const campName =
          result.properties[config.properties.referral.companyName] ?? null;
        return { campName, referralId: result.id };
      }
    }

    return null;
  } catch (err: any) {
    console.warn(
      `[referral-context] Failed to fetch context for deal ${dealId}:`,
      err.message
    );
    return null;
  }
}
