/**
 * Shared referral-fetching logic
 *
 * Extracts the core referral data retrieval from the deals/[dealId]/referrals route
 * so it can be reused by the household-referrals endpoint.
 */

import { hubspotClient } from '@/lib/hubspot';
import { config } from '@/lib/config';
import { getAssociatedIds } from '@/lib/associations';
import { pickReferralProperty } from '@/lib/property-aliases';

export interface ReferralData {
  id: string;
  referralKey: string | null;
  outreachStatus: string | null;
  clientInterest: string | null;
  note: string;
  createdAt: string | null;
  company: { id: string; name: string } | null;
}

/**
 * Fetch all referrals for a given deal, including associated company data.
 *
 * Program/Session associations are intentionally not fetched: those custom
 * objects do not exist in this portal. Sessions are looked up from Postgres
 * via Company.programid in the unified card's session-selection flow.
 */
export async function fetchReferralsForDeal(dealId: string): Promise<ReferralData[]> {
  const referralIds = await getAssociatedIds('deals', dealId, config.objectTypes.referral);

  if (referralIds.length === 0) {
    return [];
  }

  const referralResults = await Promise.all(
    referralIds.map(async (referralId: string) => {
      try {
        // Fetch referral with properties. We dual-read outreach + interest
        // under both the canonical and legacy names — see PROPERTY_NAME_AUDIT.md.
        // Try with send date, fall back without.
        const baseProps = [
          config.properties.referral.key,
          config.properties.referral.outreachCanonical,
          config.properties.referral.outreach,
          config.properties.referral.interestCanonical,
          config.properties.referral.interest,
          config.properties.referral.note,
        ];
        let referral;
        try {
          referral = await hubspotClient.crm.objects.basicApi.getById(
            config.objectTypes.referral,
            referralId,
            [...baseProps, config.properties.referral.emailLastSentDatetime],
          );
        } catch {
          referral = await hubspotClient.crm.objects.basicApi.getById(
            config.objectTypes.referral,
            referralId,
            baseProps,
          );
        }

        // Get associated company (the camp). Program/Session associations are
        // not fetched — those object types don't exist in this portal.
        const companyIds = await getAssociatedIds(
          config.objectTypes.referral,
          referralId,
          'companies'
        );

        // Fetch company details
        let companyData: { id: string; name: string } | null = null;
        if (companyIds.length > 0) {
          try {
            const company = await hubspotClient.crm.companies.basicApi.getById(
              companyIds[0],
              ['name']
            );
            companyData = {
              id: company.id,
              name: company.properties.name || 'Unnamed Company',
            };
          } catch (e) {
            console.warn(`[referrals] Failed to fetch company ${companyIds[0]}`);
          }
        }

        return {
          id: referral.id,
          referralKey: referral.properties[config.properties.referral.key],
          outreachStatus: pickReferralProperty(referral.properties, 'outreach'),
          clientInterest: pickReferralProperty(referral.properties, 'interest'),
          note: referral.properties[config.properties.referral.note] || '',
          createdAt: referral.properties[config.properties.referral.emailLastSentDatetime] || null,
          company: companyData,
        };
      } catch (e: any) {
        console.error(`[referrals] Error fetching referral ${referralId}:`, e.message);
        return null;
      }
    })
  );

  return referralResults.filter((r): r is ReferralData => r !== null);
}
