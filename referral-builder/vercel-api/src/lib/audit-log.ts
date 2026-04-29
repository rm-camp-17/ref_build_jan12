/**
 * Sacred-field audit log.
 *
 * Spec: UNIFIED_CARD_SPEC.md §5.1 ("Audit log on sacred-field changes").
 *
 * The five "sacred" deal fields determine commission flow into ce-billing:
 *   - expertprofile      (primary expert assignment)
 *   - referred_by        (referring expert)
 *   - split_type         (per-deal co-work split flavor)
 *   - deal_split_email   (co-work expert email — see §6.2 server-side validation)
 *   - deal_split_pct     (co-work share)
 *
 * Every successful mutation of any of these MUST be recorded as a HubSpot
 * timeline note (engagement) on the deal so ce-billing's reconciliation
 * job has a paper trail when it detects field drift.
 *
 * We use the simplest available mechanism — a Note engagement — rather
 * than a custom timeline event type, because:
 *   - Notes don't require pre-registering an event template in the portal
 *   - Notes are visible in the standard deal-activity timeline UI
 *   - Notes are queryable via the standard CRM search API
 *
 * The note body is a structured, human-readable text block. ce-billing's
 * reconciliation can search notes for the `[sacred-field-audit]` prefix
 * to find them programmatically; humans see the same content in the
 * timeline.
 *
 * Failure to write the audit note must NOT roll back the underlying
 * mutation — by the time we get here the property write has already
 * succeeded. We log a warning and continue. (If audit-log writes start
 * failing systematically, that's an alert condition, not a deal-level
 * failure mode.)
 */

import { hubspotClient } from './hubspot';

// ============================================================================
// Sacred-field set
// ============================================================================

/**
 * The five fields ce-billing treats as authoritative for commission
 * calculation. Any write to these requires an audit log entry.
 *
 * Keep this list aligned with `clone.ts` SACRED_DEAL_PROPERTIES — the
 * spec lists them in the same order (§4.2 saga, §5.1 enforcement, §5.2
 * clone-for-year copy).
 */
export const SACRED_DEAL_FIELDS: ReadonlyArray<string> = [
  'expertprofile',
  'referred_by',
  'split_type',
  'deal_split_email',
  'deal_split_pct',
];

const SACRED_FIELD_SET: ReadonlySet<string> = new Set(SACRED_DEAL_FIELDS);

/**
 * Returns true if the given property name is one of the five sacred fields.
 */
export function isSacredField(field: string): boolean {
  return SACRED_FIELD_SET.has(field);
}

// ============================================================================
// Types
// ============================================================================

export interface SacredFieldChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface LogSacredFieldChangeOptions {
  /**
   * HubSpot user ID making the change. Falls back to the deal's
   * `hubspot_owner_id` if not provided (spec §5.1: "use the deal's
   * `hubspot_owner_id` as a fallback" until per-request user context
   * is wired through).
   */
  changedByUserId?: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Diff a `before` snapshot against a `proposed` change set and return the
 * subset of changes that
 *   (a) target a sacred field, AND
 *   (b) actually change the value (HubSpot empty string / null are equal).
 *
 * Use this immediately AFTER the property write succeeds — but compute
 * `before` BEFORE the write so we have the true previous value.
 */
export function diffSacredFieldChanges(
  before: Record<string, string | null | undefined>,
  proposed: Record<string, string | null | undefined>
): SacredFieldChange[] {
  const changes: SacredFieldChange[] = [];
  for (const key of Object.keys(proposed)) {
    if (!isSacredField(key)) continue;
    const oldValue = normalize(before[key]);
    const newValue = normalize(proposed[key]);
    if (oldValue === newValue) continue;
    changes.push({ field: key, oldValue, newValue });
  }
  return changes;
}

function normalize(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  if (v === '') return null;
  return v;
}

/**
 * Format the audit note body. Structured enough for grep, friendly
 * enough for a human reading the deal timeline.
 */
function formatNoteBody(
  changes: SacredFieldChange[],
  changedByUserId: string | undefined,
  changedAt: string
): string {
  const lines: string[] = [];
  lines.push('[sacred-field-audit]');
  lines.push(`changed_at: ${changedAt}`);
  lines.push(`changed_by_user_id: ${changedByUserId ?? '(unknown)'}`);
  lines.push('changes:');
  for (const c of changes) {
    lines.push(
      `  - field: ${c.field}\n    old_value: ${formatValue(c.oldValue)}\n    new_value: ${formatValue(c.newValue)}`
    );
  }
  return lines.join('\n');
}

function formatValue(v: string | null): string {
  if (v === null) return '(empty)';
  // Quote strings to make whitespace visible
  return JSON.stringify(v);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Write a HubSpot Note engagement to the deal's timeline capturing one
 * or more sacred-field changes. Best-effort: failures are logged but
 * NOT propagated — the underlying property write has already committed
 * and shouldn't be rolled back over a failed audit note.
 *
 * No-op if `changes` is empty.
 *
 * Implementation notes:
 *   - We create the note via `crm.objects.notes.basicApi.create` and
 *     associate it to the deal in the same call using the standard
 *     Note → Deal association (typeId 214 in HubSpot's HUBSPOT_DEFINED
 *     schema). We pass `associationCategory: HUBSPOT_DEFINED` and
 *     `associationTypeId: 214`.
 *   - `hs_timestamp` is required by HubSpot for engagement objects.
 *   - `hs_note_body` is plain text; HubSpot renders it preserving
 *     newlines in the timeline view.
 */
export async function logSacredFieldChange(
  dealId: string,
  changes: SacredFieldChange[],
  options: LogSacredFieldChangeOptions = {}
): Promise<void> {
  if (!changes || changes.length === 0) return;

  const changedAt = new Date().toISOString();
  const body = formatNoteBody(changes, options.changedByUserId, changedAt);

  try {
    await hubspotClient.crm.objects.notes.basicApi.create({
      properties: {
        hs_timestamp: changedAt,
        hs_note_body: body,
      },
      associations: [
        {
          to: { id: dealId },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED' as any,
              // Note → Deal default association
              associationTypeId: 214,
            },
          ],
        },
      ],
    } as any);
    console.log(
      `[audit-log] Wrote sacred-field audit note for deal ${dealId}: ${changes.map((c) => c.field).join(', ')}`
    );
  } catch (err: any) {
    // Best-effort: never block the caller. ce-billing's reconciliation
    // can also detect drift directly from HubSpot's property history.
    console.warn(
      `[audit-log] Failed to write sacred-field audit note for deal ${dealId}:`,
      err?.message ?? err
    );
  }
}
