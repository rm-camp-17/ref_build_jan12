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

import React, { useState } from "react";
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
    return <LostDisplayView details={details} />;
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

function LostDisplayView({ details }: { details: DealDetails | null }) {
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

      {cat === "WAIT_NEXT_YEAR" && (
        <Flex direction="row" gap="md">
          <Text format={{ fontWeight: "bold" }}>Wait until year:</Text>
          <Text>{wait || "—"}</Text>
        </Flex>
      )}

      <Text variant="microcopy">
        The auto-clone job will pick this deal up when wait_until_year hits
        the current year.
      </Text>
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
  const [waitYear, setWaitYear] = useState(
    details?.wait_until_year || String(currentYear + 1)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [endpointMissing, setEndpointMissing] = useState(false);

  const showWaitYear = category === "WAIT_NEXT_YEAR";

  const handleSave = async () => {
    if (!category) {
      setError("Pick a category before saving.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const body: Record<string, string | number | boolean> = {
        closed_lost_category: category,
        closed_lost_reason: reason,
        // Without this flag the backend writes the loss reason but leaves
        // dealstage untouched, so the deal never actually moves to Closed
        // Lost. "Mark as Lost" must always transition the stage.
        setStageToLost: true,
      };
      if (showWaitYear && waitYear) {
        body.wait_until_year = parseInt(waitYear, 10);
      }
      // hubspot.fetch only allows the Authorization header. Setting
      // Content-Type causes HubSpot to reject the call with HTTP 400 before
      // it leaves the iframe. The backend reads req.text() and JSON.parses
      // it directly, so no Content-Type is needed.
      const resp = await hubspot.fetch(
        `${API_BASE}/api/deals/${dealId}/loss-reason`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        }
      );
      if (resp.status === 404) {
        setEndpointMissing(true);
        return;
      }
      const result = await resp.json().catch(() => ({}));
      if (resp.ok) {
        onSaved();
      } else {
        setError(result?.message || result?.error || "Failed to save.");
      }
    } catch {
      setEndpointMissing(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Flex direction="column" gap="sm">
      <Heading level={3}>Mark as Lost</Heading>
      <Text variant="microcopy">
        Captures why the deal didn't close so the team can learn. If
        "Waiting for next year" is selected, the auto-clone job will revive
        the deal in a future cycle.
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

      {showWaitYear && (
        <Input
          label="Wait until year"
          name="wait_until_year"
          value={waitYear}
          onChange={(val) => setWaitYear(val as string)}
          description="Auto-clone job picks this deal up when this year hits."
          readOnly={locked}
        />
      )}

      <Divider />

      <Flex direction="row" gap="sm" wrap="wrap">
        <Button
          variant="destructive"
          onClick={handleSave}
          disabled={saving || locked}
        >
          {saving ? "Saving..." : "Mark as Lost"}
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
