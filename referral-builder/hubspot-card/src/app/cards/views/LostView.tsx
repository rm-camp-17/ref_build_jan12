/**
 * LostView — handles two modes:
 *
 *   1. Capture mode (`mode = "capture"`): the rep clicked "Mark as Lost"
 *      from another stage's secondary action, OR the deal is at a
 *      non-terminal stage and we're showing the inline form. Submitting
 *      writes closed_lost_category + closed_lost_reason (+ optionally
 *      wait_until_year) and is expected to advance dealstage to
 *      `closedlost` server-side.
 *   2. Display mode (`mode = "display"`): the deal is already at
 *      `closedlost`. Renders the captured values read-only.
 *
 * Per spec §4.5 + §4.6.
 *
 * Backend dependency: PATCH /api/deals/[dealId]/loss-reason. Agent G
 * is shipping it. If the route 404s (or networks fail), the form falls
 * back to a "Phase 5 — coming soon" placeholder so reps don't lose
 * their typed input.
 */

import React, { useCallback, useState } from "react";
import {
  hubspot,
  Alert,
  Box,
  Button,
  Divider,
  Flex,
  Heading,
  Input,
  Select,
  Tag,
  Text,
  TextArea,
} from "@hubspot/ui-extensions";
import { API_BASE, DealDetails, isCommissionLocked } from "./types";

// ============================================================================
// Categories (spec §4.5)
// ============================================================================

const LOST_CATEGORY_OPTIONS = [
  { label: "Waiting for next year", value: "WAIT_NEXT_YEAR" },
  { label: "Picked another program", value: "OTHER_PROGRAM" },
  { label: "Aging out / staying home", value: "OUT_OF_MARKET" },
  { label: "Tuition / can't afford", value: "MONEY" },
  { label: "Family went silent", value: "NON_RESPONSIVE" },
  { label: "Other (see notes)", value: "OTHER" },
];

function categoryLabel(value: string | null): string {
  if (!value) return "—";
  return (
    LOST_CATEGORY_OPTIONS.find((o) => o.value === value)?.label || value
  );
}

// ============================================================================
// Props
// ============================================================================

interface Props {
  dealId: string;
  details: DealDetails | null;
  mode: "capture" | "display";
  onSaved: () => void;
  onCancel?: () => void;
}

// ============================================================================
// Main view
// ============================================================================

export function LostView({ dealId, details, mode, onSaved, onCancel }: Props) {
  if (mode === "display") {
    return <LostDisplayView dealId={dealId} details={details} onCloned={onSaved} />;
  }
  return (
    <LostCaptureForm
      dealId={dealId}
      details={details}
      onSaved={onSaved}
      onCancel={onCancel}
    />
  );
}

// ============================================================================
// Display mode (deal already at closedlost)
// ============================================================================

function LostDisplayView({
  dealId,
  details,
  onCloned,
}: {
  dealId: string;
  details: DealDetails | null;
  onCloned: () => void;
}) {
  const cat = details?.closed_lost_category || null;
  const reason = details?.closed_lost_reason || "";
  const wait = details?.wait_until_year || "";

  return (
    <Flex direction="column" gap="sm">
      <Heading level={3}>Closed Lost</Heading>

      <Flex direction="row" gap="md" align="center" wrap="wrap">
        <Text format={{ fontWeight: "bold" }}>Category:</Text>
        <Tag variant="warning">{categoryLabel(cat)}</Tag>
      </Flex>

      <Box>
        <Text format={{ fontWeight: "bold" }}>Reason:</Text>
        <Text>{reason || "—"}</Text>
      </Box>

      {/* Any lost deal can be cloned into next year (not just "waiting for
          next year"). The wait year, if captured, pre-fills the target. */}
      <Divider />
      <CloneNextYearSection
        dealId={dealId}
        defaultYear={wait || String(new Date().getFullYear() + 1)}
        onCloned={onCloned}
      />
    </Flex>
  );
}

// ============================================================================
// Clone-for-year hook (shared by the Closed Lost view and the one-step
// "Mark as Lost & Clone" action so the locked-source confirmation flow lives
// in one place).
// ============================================================================

interface CloneResult {
  newDealName: string;
  deduped: boolean;
}
interface CloneConfirmation {
  message: string;
  lockedFields: string[];
}

function useCloneForYear(dealId: string) {
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CloneResult | null>(null);
  const [needsConfirmation, setNeedsConfirmation] =
    useState<CloneConfirmation | null>(null);

  const performClone = useCallback(
    async (
      targetYear: number,
      confirmExpertFields: boolean
    ): Promise<"ok" | "confirm" | "error"> => {
      setCloning(true);
      setError(null);
      try {
        const resp = await hubspot.fetch(
          `${API_BASE}/api/v2/deal/${dealId}/clone-for-year`,
          {
            method: "POST",
            body: JSON.stringify({ targetYear, confirmExpertFields }),
          }
        );
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 409 && data.requiresConfirmation) {
          setNeedsConfirmation({
            message: data.message,
            lockedFields: data.lockedFields ?? [],
          });
          return "confirm";
        }
        if (resp.ok && data.success) {
          setResult({ newDealName: data.newDealName, deduped: !!data.deduped });
          setNeedsConfirmation(null);
          return "ok";
        }
        setError(data.message || "Failed to clone deal.");
        return "error";
      } catch {
        setError("Failed to clone deal. Please try again.");
        return "error";
      } finally {
        setCloning(false);
      }
    },
    [dealId]
  );

  return {
    cloning,
    error,
    result,
    needsConfirmation,
    clearConfirmation: () => setNeedsConfirmation(null),
    performClone,
  };
}

/** Success alert shared by both clone entry points. */
function CloneSuccess({
  result,
  targetYear,
}: {
  result: CloneResult;
  targetYear: string;
}) {
  return (
    <Alert title="Next-year deal created" variant="success">
      {result.deduped
        ? `Found existing ${targetYear} deal: "${result.newDealName}".`
        : `Created "${result.newDealName}" for ${targetYear}. Referrals, associations, and activity carried over.`}
    </Alert>
  );
}

/** The locked-source confirmation block shared by both clone entry points. */
function CloneConfirm({
  confirmation,
  cloning,
  onConfirm,
  onCancel,
}: {
  confirmation: CloneConfirmation;
  cloning: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Flex direction="column" gap="sm">
      <Alert title="Source deal is commission_locked" variant="warning">
        {confirmation.message}
      </Alert>
      <Text variant="microcopy">
        These fields copy to the new deal:{" "}
        {confirmation.lockedFields.join(", ")}.
      </Text>
      <Flex direction="row" gap="sm">
        <Button variant="primary" onClick={onConfirm} disabled={cloning}>
          {cloning ? "Cloning..." : "Confirm and clone"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={cloning}>
          Cancel
        </Button>
      </Flex>
    </Flex>
  );
}

// ============================================================================
// Clone to next year (Closed Lost view — any lost deal)
// ============================================================================

function CloneNextYearSection({
  dealId,
  defaultYear,
  onCloned,
}: {
  dealId: string;
  defaultYear: string;
  onCloned: () => void;
}) {
  const [targetYear, setTargetYear] = useState(defaultYear);
  const clone = useCloneForYear(dealId);

  const run = async (confirmExpertFields: boolean) => {
    const outcome = await clone.performClone(
      parseInt(targetYear, 10),
      confirmExpertFields
    );
    if (outcome === "ok") onCloned();
  };

  if (clone.result) {
    return <CloneSuccess result={clone.result} targetYear={targetYear} />;
  }

  return (
    <Flex direction="column" gap="sm">
      <Heading level={3}>Clone to next year</Heading>
      <Text variant="microcopy">
        Clone this deal into {targetYear} now. The new deal carries the same
        referrals, associations (child, household, parent), and prior
        activity, and lands in next year's pipeline.
      </Text>

      {clone.error && <Alert variant="error">{clone.error}</Alert>}

      {clone.needsConfirmation ? (
        <CloneConfirm
          confirmation={clone.needsConfirmation}
          cloning={clone.cloning}
          onConfirm={() => run(true)}
          onCancel={clone.clearConfirmation}
        />
      ) : (
        <Flex direction="column" gap="sm">
          <Input
            label="Target year"
            name="clone_target_year"
            value={targetYear}
            onChange={(val) => setTargetYear(val as string)}
          />
          <Button
            variant="primary"
            onClick={() => run(false)}
            disabled={clone.cloning || !targetYear}
          >
            {clone.cloning ? "Cloning..." : "Clone to next year"}
          </Button>
        </Flex>
      )}
    </Flex>
  );
}

// ============================================================================
// Capture mode
// ============================================================================

function LostCaptureForm({
  dealId,
  details,
  onSaved,
  onCancel,
}: {
  dealId: string;
  details: DealDetails | null;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const locked = isCommissionLocked(details);

  const currentYear = new Date().getFullYear();
  const [category, setCategory] = useState(
    details?.closed_lost_category || ""
  );
  const [reason, setReason] = useState(details?.closed_lost_reason || "");
  // Single year value: the clone target, also saved as wait_until_year when the
  // category is "Waiting for next year".
  const [targetYear, setTargetYear] = useState(
    details?.wait_until_year || String(currentYear + 1)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [endpointMissing, setEndpointMissing] = useState(false);
  // After a successful "Mark as Lost & Clone", we stay mounted in this phase to
  // drive the clone (and its locked-source confirmation) without bouncing the
  // rep back to the form.
  const [phase, setPhase] = useState<"form" | "clone">("form");
  const clone = useCloneForYear(dealId);

  // Mark the deal lost (writes loss reason + moves stage). Returns true on
  // success so the caller can chain the clone.
  const markLost = async (): Promise<boolean> => {
    const body: Record<string, string | number | boolean> = {
      closed_lost_category: category,
      closed_lost_reason: reason,
      // Without this flag the backend writes the loss reason but leaves
      // dealstage untouched, so the deal never actually moves to Closed Lost.
      setStageToLost: true,
    };
    if (category === "WAIT_NEXT_YEAR" && targetYear) {
      body.wait_until_year = parseInt(targetYear, 10);
    }
    // hubspot.fetch only allows the Authorization header. Setting Content-Type
    // makes HubSpot reject the call with HTTP 400 before it leaves the iframe.
    const resp = await hubspot.fetch(
      `${API_BASE}/api/deals/${dealId}/loss-reason`,
      { method: "PATCH", body: JSON.stringify(body) }
    );
    if (resp.status === 404) {
      setEndpointMissing(true);
      return false;
    }
    const result = await resp.json().catch(() => ({}));
    if (resp.ok) return true;
    setError(result?.message || result?.error || "Failed to save.");
    return false;
  };

  const handleSave = async (alsoClone: boolean) => {
    if (!category) {
      setError("Pick a category before saving.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const ok = await markLost();
      if (!ok) return;
      if (alsoClone) {
        // Deal is now Closed Lost; clone it in the same step.
        setPhase("clone");
        await clone.performClone(parseInt(targetYear, 10), false);
      } else {
        onSaved();
      }
    } catch {
      setEndpointMissing(true);
    } finally {
      setSaving(false);
    }
  };

  // --- Clone phase: the deal is already marked lost; finish (or retry) the
  //     clone, then hand back to the parent. ---
  if (phase === "clone") {
    if (clone.result) {
      return (
        <Flex direction="column" gap="sm">
          <CloneSuccess result={clone.result} targetYear={targetYear} />
          <Button variant="primary" onClick={onSaved}>
            Done
          </Button>
        </Flex>
      );
    }
    if (clone.needsConfirmation) {
      return (
        <CloneConfirm
          confirmation={clone.needsConfirmation}
          cloning={clone.cloning}
          onConfirm={() =>
            clone
              .performClone(parseInt(targetYear, 10), true)
              .then((o) => o === "ok" && onSaved())
          }
          // Deal is already lost; skipping just leaves it un-cloned.
          onCancel={onSaved}
        />
      );
    }
    return (
      <Flex direction="column" gap="sm">
        <Text format={{ fontWeight: "bold" }}>
          Marked as Lost. Cloning to {targetYear}…
        </Text>
        {clone.cloning && <Text variant="microcopy">Cloning…</Text>}
        {clone.error && (
          <>
            <Alert variant="error">{clone.error}</Alert>
            <Text variant="microcopy">
              The deal was marked Lost; the clone didn't complete.
            </Text>
            <Flex direction="row" gap="sm">
              <Button
                variant="primary"
                onClick={() =>
                  clone
                    .performClone(parseInt(targetYear, 10), false)
                    .then((o) => o === "ok" && onSaved())
                }
                disabled={clone.cloning}
              >
                Retry clone
              </Button>
              <Button variant="secondary" onClick={onSaved}>
                Done (skip clone)
              </Button>
            </Flex>
          </>
        )}
      </Flex>
    );
  }

  return (
    <Flex direction="column" gap="sm">
      <Heading level={3}>Mark as Lost</Heading>
      <Text variant="microcopy">
        Captures why the deal didn't close so the team can learn. You can clone
        it into next year in the same step, or any time later from the Closed
        Lost view.
      </Text>

      {error && <Alert variant="error">{error}</Alert>}
      {endpointMissing && (
        <Alert title="Phase 5 — coming soon" variant="info">
          Saving captured locally; will sync when the loss-reason endpoint
          ships.
        </Alert>
      )}

      <Select
        label="Category"
        name="closed_lost_category"
        options={LOST_CATEGORY_OPTIONS}
        value={category}
        onChange={(val) => setCategory(val as string)}
        readOnly={locked}
      />

      <TextArea
        label="Reason / context"
        name="closed_lost_reason"
        value={reason}
        onChange={(val) => setReason(val as string)}
        rows={4}
        readOnly={locked}
      />

      <Input
        label="Next-year target"
        name="clone_target_year"
        value={targetYear}
        onChange={(val) => setTargetYear(val as string)}
        description="Year the deal clones into if you use Mark as Lost & Clone (also saved as the wait year when applicable)."
        readOnly={locked}
      />

      <Divider />

      <Flex direction="row" gap="sm" wrap="wrap">
        <Button
          variant="destructive"
          onClick={() => handleSave(false)}
          disabled={saving || locked}
        >
          {saving ? "Saving..." : "Mark as Lost"}
        </Button>
        <Button
          variant="primary"
          onClick={() => handleSave(true)}
          disabled={saving || locked || !targetYear}
        >
          {saving ? "Saving..." : `Mark as Lost & Clone to ${targetYear}`}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        )}
      </Flex>
    </Flex>
  );
}
