/**
 * SessionPickerView — rendered when the deal is at Tuition Undecided
 * (`1282923123`).
 *
 * Spec §4.3. Pulled from the legacy SessionCard.tsx's <EligibleView>
 * with the stage-aware shell stripped (the unified router now owns
 * load/error/inactive states).
 *
 * Includes the "Selecting session for {camp} based on referral marked
 * Selected" banner when cardData.referralContext is present.
 */

import React, { useState } from "react";
import {
  hubspot,
  Alert,
  Button,
  Divider,
  Flex,
  Heading,
  Input,
  Select,
  Text,
} from "@hubspot/ui-extensions";
import {
  API_BASE,
  CardData,
  DealDetails,
  isCommissionLocked,
} from "./types";

type Eligible = Extract<CardData, { status: "eligible" }>;

interface Props {
  dealId: string;
  cardData: Eligible;
  details: DealDetails | null;
  onSubmitted: () => void;
  onMarkLost: () => void;
}

export function SessionPickerView({
  dealId,
  cardData,
  details,
  onSubmitted,
  onMarkLost,
}: Props) {
  const locked = isCommissionLocked(details);

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessions = cardData.sessions ?? [];
  // No sessions on file for this camp/year (common on a freshly-cloned Won
  // deal) → go straight to manual tuition entry instead of an empty picker.
  const noSessions = sessions.length === 0;
  const sessionOptions = [
    ...sessions.map((s) => ({
      label: `${s.name} (${s.startDate} – ${s.endDate}) · ${s.weeks}wk · ${s.currency} $${s.tuition.toLocaleString()}`,
      value: String(s.id),
    })),
    { label: "Other (Requires Office Approval)", value: "OTHER" },
  ];

  const handleSelectSession = async () => {
    if (!selectedSessionId) return;
    if (selectedSessionId === "OTHER") {
      setShowCustomForm(true);
      return;
    }

    try {
      setSubmitting(true);
      setError(null);
      // hubspot.fetch only allows the Authorization header — Content-Type
      // is rejected with HTTP 400 before the call leaves the iframe.
      const resp = await hubspot.fetch(
        `${API_BASE}/api/v2/deal/${dealId}/select-session`,
        {
          method: "POST",
          body: JSON.stringify({
            sessionId: selectedSessionId,
            programId: cardData.programId,
          }),
        }
      );
      const result = await resp.json();
      if (resp.ok && result.success) {
        // Stage advanced to Won server-side — let the router re-fetch.
        onSubmitted();
      } else {
        setError(result.message || "Failed to select session.");
      }
    } catch {
      setError("Failed to select session. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  // Manual tuition entry: either the rep picked "Other", or there are no
  // sessions on file at all (then it's the only path, with no "Back").
  if (showCustomForm || noSessions) {
    return (
      <CustomSessionForm
        dealId={dealId}
        onSubmitted={onSubmitted}
        locked={locked}
        title={noSessions ? "Enter Tuition" : "Custom Session (Requires Approval)"}
        contextNote={
          noSessions
            ? cardData.sessionsNote ||
              `No sessions on file for ${cardData.programName || "this camp"} in ${String(
                cardData.year ?? ""
              )}. Enter the tuition manually.`
            : undefined
        }
        onCancel={noSessions ? undefined : () => setShowCustomForm(false)}
        onMarkLost={noSessions ? onMarkLost : undefined}
      />
    );
  }

  return (
    <Flex direction="column" gap="sm">
      <Heading level={3}>Session Selection</Heading>
      {cardData.referralContext?.campName && (
        <Alert variant="info">
          Selecting session for {cardData.referralContext.campName} based on
          referral marked Selected.
        </Alert>
      )}
      <Flex direction="row" gap="md">
        <Text format={{ fontWeight: "bold" }}>Camp:</Text>
        <Text>{cardData.programName}</Text>
      </Flex>
      <Flex direction="row" gap="md">
        <Text format={{ fontWeight: "bold" }}>Year:</Text>
        <Text>{String(cardData.year ?? "")}</Text>
      </Flex>
      <Text>{sessions.length} session(s) available</Text>
      {error && <Alert variant="error">{error}</Alert>}
      <Divider />
      <Select
        label="Choose a session"
        name="sessionId"
        options={sessionOptions}
        value={selectedSessionId}
        onChange={(val) => setSelectedSessionId(val as string)}
        readOnly={locked}
      />
      <Flex direction="row" gap="sm" wrap="wrap">
        <Button
          variant="primary"
          onClick={handleSelectSession}
          disabled={!selectedSessionId || submitting || locked}
        >
          {submitting ? "Selecting..." : "Select Session"}
        </Button>
        <Button variant="destructive" onClick={onMarkLost} disabled={locked}>
          Mark as Lost
        </Button>
      </Flex>
    </Flex>
  );
}

// ============================================================================
// Custom session ("Other") form
// ============================================================================

interface CustomSessionFormProps {
  dealId: string;
  onSubmitted: () => void;
  locked: boolean;
  /** Heading — e.g. "Enter Tuition" (no sessions) vs "Custom Session". */
  title?: string;
  /** Optional info note shown above the form (camp/year context). */
  contextNote?: string;
  /** "Back" button — omitted when this is the only path (no sessions). */
  onCancel?: () => void;
  /** "Mark as Lost" button — shown in the no-sessions manual-entry path. */
  onMarkLost?: () => void;
}

function CustomSessionForm({
  dealId,
  onSubmitted,
  locked,
  title = "Custom Session (Requires Approval)",
  contextNote,
  onCancel,
  onMarkLost,
}: CustomSessionFormProps) {
  const [description, setDescription] = useState("");
  const [tuition, setTuition] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [weeks, setWeeks] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!tuition || !weeks) {
      setError("Tuition and weeks are required.");
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      const resp = await hubspot.fetch(
        `${API_BASE}/api/v2/deal/${dealId}/custom-session`,
        {
          method: "POST",
          body: JSON.stringify({
            description: description || "Custom session",
            // Send raw strings — the backend sanitizes ($, commas) and
            // parses, so "$1,200" no longer becomes NaN and silently 400s.
            tuition,
            currency: currency || "USD",
            weeks,
          }),
        }
      );
      const result = await resp.json();
      if (resp.ok && result.success) {
        onSubmitted();
      } else {
        setError(result.message || "Failed to save custom session.");
      }
    } catch {
      setError("Failed to save custom session. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Flex direction="column" gap="sm">
      <Heading level={3}>{title}</Heading>
      {contextNote && <Alert variant="info">{contextNote}</Alert>}
      {error && <Alert variant="error">{error}</Alert>}
      <Input
        label="Description"
        name="description"
        value={description}
        onChange={(val) => setDescription(val as string)}
        readOnly={locked}
      />
      <Input
        label="Tuition Amount"
        name="tuition"
        value={tuition}
        onChange={(val) => setTuition(val as string)}
        readOnly={locked}
      />
      <Input
        label="Currency (USD, CAD, etc.)"
        name="currency"
        value={currency}
        onChange={(val) => setCurrency(val as string)}
        readOnly={locked}
      />
      <Input
        label="Number of Weeks"
        name="weeks"
        value={weeks}
        onChange={(val) => setWeeks(val as string)}
        readOnly={locked}
      />
      <Flex direction="row" gap="sm" wrap="wrap">
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={submitting || locked}
        >
          {submitting ? "Submitting..." : "Save Tuition"}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            Back
          </Button>
        )}
        {onMarkLost && (
          <Button variant="destructive" onClick={onMarkLost} disabled={locked}>
            Mark as Lost
          </Button>
        )}
      </Flex>
    </Flex>
  );
}
