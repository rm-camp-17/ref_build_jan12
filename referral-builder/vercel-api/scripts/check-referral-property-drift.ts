/**
 * Investigation script — reports drift between canonical and legacy
 * referral property names across all Referral records in HubSpot.
 *
 * Why: PROPERTY_NAME_AUDIT.md found that the codebase had been writing
 * status/interest under the wrong names. The dual-write code path now
 * keeps both names in sync going forward, but pre-existing records may
 * have data on one side only. This script identifies them so they can
 * be reconciled (or just left to age out).
 *
 * Run:
 *   HUBSPOT_ACCESS_TOKEN=pat-... npx tsx scripts/check-referral-property-drift.ts
 *
 * Output (stdout):
 *   - Per-property summary: how many records have data on each name
 *   - Drift list: records where the two names disagree (NOT counting
 *     "one is empty" — that's expected during migration)
 *
 * Read-only: never writes to HubSpot.
 */

import { hubspotClient } from '../src/lib/hubspot';
import { config } from '../src/lib/config';

interface Counts {
  total: number;
  canonical_only: number;
  legacy_only: number;
  both_match: number;
  both_disagree: number;
  neither: number;
}

interface DriftRow {
  id: string;
  field: 'outreach' | 'interest';
  canonical: string;
  legacy: string;
}

async function main() {
  const PAGE_SIZE = 100;
  let after: string | undefined = undefined;

  const counts: Record<'outreach' | 'interest', Counts> = {
    outreach: { total: 0, canonical_only: 0, legacy_only: 0, both_match: 0, both_disagree: 0, neither: 0 },
    interest: { total: 0, canonical_only: 0, legacy_only: 0, both_match: 0, both_disagree: 0, neither: 0 },
  };
  const drift: DriftRow[] = [];

  console.log('Scanning Referral records for property-name drift...');

  while (true) {
    const page = await hubspotClient.crm.objects.basicApi.getPage(
      config.objectTypes.referral,
      PAGE_SIZE,
      after,
      [
        config.properties.referral.outreachCanonical,
        config.properties.referral.outreach,
        config.properties.referral.interestCanonical,
        config.properties.referral.interest,
      ]
    );

    for (const r of page.results) {
      const props = r.properties as Record<string, string | null>;

      for (const field of ['outreach', 'interest'] as const) {
        const canonicalKey =
          field === 'outreach'
            ? config.properties.referral.outreachCanonical
            : config.properties.referral.interestCanonical;
        const legacyKey =
          field === 'outreach'
            ? config.properties.referral.outreach
            : config.properties.referral.interest;

        const c = (props[canonicalKey] ?? '').trim();
        const l = (props[legacyKey] ?? '').trim();

        counts[field].total++;
        if (c && l) {
          if (c === l) {
            counts[field].both_match++;
          } else {
            counts[field].both_disagree++;
            drift.push({ id: r.id, field, canonical: c, legacy: l });
          }
        } else if (c && !l) {
          counts[field].canonical_only++;
        } else if (!c && l) {
          counts[field].legacy_only++;
        } else {
          counts[field].neither++;
        }
      }
    }

    if (!page.paging?.next?.after) break;
    after = page.paging.next.after;
    process.stdout.write('.');
  }

  console.log('\n\n=== Per-property summary ===\n');
  for (const field of ['outreach', 'interest'] as const) {
    const c = counts[field];
    console.log(`[${field}]  total=${c.total}`);
    console.log(`  canonical_only:  ${c.canonical_only}  (legacy is empty)`);
    console.log(`  legacy_only:     ${c.legacy_only}  (canonical is empty — needs migration)`);
    console.log(`  both_match:      ${c.both_match}`);
    console.log(`  both_disagree:   ${c.both_disagree}  (DRIFT — investigate)`);
    console.log(`  neither:         ${c.neither}  (no data on either)`);
    console.log('');
  }

  if (drift.length > 0) {
    console.log(`=== Drift detail (${drift.length} rows) ===\n`);
    console.log('id,field,canonical,legacy');
    for (const d of drift) {
      console.log(`${d.id},${d.field},${JSON.stringify(d.canonical)},${JSON.stringify(d.legacy)}`);
    }
  } else {
    console.log('No drift found between canonical and legacy values where both are set.');
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
