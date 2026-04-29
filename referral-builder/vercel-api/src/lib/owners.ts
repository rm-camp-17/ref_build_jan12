/**
 * HubSpot Owners (= Experts) lookup.
 *
 * Spec: UNIFIED_CARD_SPEC.md §6.2 — server-side resolution of
 * `deal_split_email` to a HubSpot Owner. Without this, a typo'd email
 * (e.g. "alice@campexpert.com" missing the `s`) routes the co-work
 * commission share to nobody — ce-billing silently logs and drops it.
 *
 * The mapping HubSpot Owner ↔ Expert is 1:1 in this portal: every
 * Camp Experts expert has a HubSpot Owner record with their primary
 * email. We resolve via the standard Owners API filtered by email.
 *
 * SDK: `@hubspot/api-client` v11.x exposes
 *   `hubspotClient.crm.owners.ownersApi.getPage(email?, after?, limit?, archived?)`
 * which natively filters by email — no client-side scan needed.
 */

import { hubspotClient } from './hubspot';

// ============================================================================
// Types
// ============================================================================

export interface OwnerRecord {
  /** HubSpot owner ID — string-typed for consistency with object IDs. */
  id: string;
  email: string;
  /** Convenience: "First Last" if both are present, else whichever is set. */
  name: string;
  firstName?: string;
  lastName?: string;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Look up a HubSpot Owner by exact email match.
 *
 * Returns:
 *   - `OwnerRecord` on hit (one expert matches)
 *   - `null` on miss (no expert with that email — likely a typo)
 *
 * Throws on transient HubSpot errors (network / 5xx). Callers should
 * surface those as 5xx responses, NOT confuse them with the "no match"
 * 422 case.
 *
 * Email comparison is case-insensitive in HubSpot's API — we trim and
 * lowercase here too so caller doesn't have to.
 */
export async function getOwnerByEmail(
  email: string
): Promise<OwnerRecord | null> {
  const trimmed = (email ?? '').trim().toLowerCase();
  if (!trimmed) return null;

  const result = await hubspotClient.crm.owners.ownersApi.getPage(
    trimmed,
    undefined,
    1, // limit: at most one match expected
    false
  );

  const results = (result as any)?.results ?? [];
  if (results.length === 0) return null;

  const owner = results[0];
  const firstName: string | undefined = owner.firstName ?? undefined;
  const lastName: string | undefined = owner.lastName ?? undefined;
  const name = [firstName, lastName].filter(Boolean).join(' ') || (owner.email ?? trimmed);

  return {
    id: String(owner.id ?? owner.userId ?? ''),
    email: owner.email ?? trimmed,
    name,
    firstName,
    lastName,
  };
}
