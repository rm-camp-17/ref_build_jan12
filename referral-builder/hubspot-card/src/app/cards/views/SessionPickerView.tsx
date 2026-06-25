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

  if (showCustomForm) {
    return (
      <CustomSessionForm
        dealId={dealId}
        onCancel={() => setShowCustomForm(false)}
        onSubmitted={onSubmitted}
        locked={locked}
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
  onCancel: () => void;
  onSubmitted: () => void;
  locked: boolean;
}

function CustomSessionForm({
  dealId,
  onCancel,
  onSubmitted,
  locked,
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
      <Heading level={3}>Custom Session (Requires Approval)</Heading>
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
      <Flex direction="row" gap="sm">
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={submitting || locked}
        >
          {submitting ? "Submitting..." : "Submit Custom Session"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Back
        </Button>
      </Flex>
    </Flex>
  );
}
