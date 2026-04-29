/**
 * Property-alias helpers for the referral property-name migration.
 *
 * Background: PROPERTY_NAME_AUDIT.md found that the codebase has been
 * writing referral status / interest to the wrong HubSpot property names.
 * This module centralizes the dual-write + fallback-read pattern so the
 * migration can be reverted, extended, or removed in one file rather
 * than across every call site.
 *
 * Conventions:
 *   - Canonical = the actual HubSpot internal name (the one HubSpot's
 *     enum dropdown is bound to). Reads prefer this; writes target this
 *     as the source of truth.
 *   - Legacy = the historical name used by the codebase. Writes mirror
 *     to this so old reads keep working during the migration window.
 *     Reads fall back to it when canonical is empty.
 *
 * After cutover (Phase 5+): drop the legacy property name from config,
 * delete the dual-write spread, and remove this module.
 */

import { config } from './config';

// ============================================================================
// Properties we know need both names fetched/written
// ============================================================================

/**
 * Property pairs to fetch when reading a Referral. Canonical first so
 * the fallback is well-defined. Used by `pickReferralProperty` to pick
 * the first non-empty value at read time.
 */
export const REFERRAL_PROPERTY_PAIRS = {
  outreach: {
    canonical: config.properties.referral.outreachCanonical,
    legacy: config.properties.referral.outreach,
  },
  interest: {
    canonical: config.properties.referral.interestCanonical,
    legacy: config.properties.referral.interest,
  },
} as const;

/**
 * Flat list of property names to include in any HubSpot read of a
 * referral. Use this in `properties: [...]` arrays.
 */
export const REFERRAL_DUAL_READ_PROPERTIES: ReadonlyArray<string> = [
  REFERRAL_PROPERTY_PAIRS.outreach.canonical,
  REFERRAL_PROPERTY_PAIRS.outreach.legacy,
  REFERRAL_PROPERTY_PAIRS.interest.canonical,
  REFERRAL_PROPERTY_PAIRS.interest.legacy,
];

// ============================================================================
// Read helpers
// ============================================================================

/**
 * Pick a referral property value, preferring canonical, falling back to legacy.
 * Empty strings count as "not present" — HubSpot returns "" for unset fields.
 */
export function pickReferralProperty(
  props: Record<string, string | null | undefined>,
  pair: keyof typeof REFERRAL_PROPERTY_PAIRS
): string | null {
  const { canonical, legacy } = REFERRAL_PROPERTY_PAIRS[pair];
  const c = props[canonical];
  if (c !== null && c !== undefined && c !== '') return c;
  const l = props[legacy];
  if (l !== null && l !== undefined && l !== '') return l;
  return null;
}

// ============================================================================
// Write helpers
// ============================================================================

/**
 * Build the property entries needed to dual-write a single referral
 * property (status or interest). Spread the result into the patch
 * properties object:
 *
 *   const patch = {
 *     ...dualWriteReferralProperty('interest', 'Selected'),
 *     ...dualWriteReferralProperty('outreach', 'Sent'),
 *   };
 *
 * Returns an empty object when value is undefined — lets callers conditionally
 * include the entries without an `if`.
 */
export function dualWriteReferralProperty(
  pair: keyof typeof REFERRAL_PROPERTY_PAIRS,
  value: string | undefined
): Record<string, string> {
  if (value === undefined) return {};
  const { canonical, legacy } = REFERRAL_PROPERTY_PAIRS[pair];
  return { [canonical]: value, [legacy]: value };
}

/**
 * Detect whether a patch payload writes a referral property under the
 * legacy name without the canonical equivalent. Useful for catching
 * call sites that haven't been migrated.
 */
export function findUnmigratedReferralWrites(
  properties: Record<string, unknown>
): Array<keyof typeof REFERRAL_PROPERTY_PAIRS> {
  const violations: Array<keyof typeof REFERRAL_PROPERTY_PAIRS> = [];
  for (const key of Object.keys(REFERRAL_PROPERTY_PAIRS) as Array<
    keyof typeof REFERRAL_PROPERTY_PAIRS
  >) {
    const { canonical, legacy } = REFERRAL_PROPERTY_PAIRS[key];
    const wrotelegacy = legacy in properties;
    const wroteCanonical = canonical in properties;
    if (wrotelegacy && !wroteCanonical) violations.push(key);
  }
  return violations;
}
