/**
 * Session Selection Card — TypeScript port of camp-experts-session-card's
 * SessionCard.jsx, now talking to the unified Vercel API at
 * referral-builder1122026.vercel.app.
 *
 * Stage-aware rendering driven by GET /api/v2/deal/:dealId/card-data:
 *   not-in-pipeline  → render nothing (silently absent)
 *   confirmed        → show session/tuition summary + "Create Next Year Deal"
 *   inactive         → show "waiting for stage" alert
 *   error            → show retry
 *   eligible         → show session list + "Other" custom form
 *
 * HubSpot Platform Version: 2025.02
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  hubspot,
  Flex,
  Text,
  Button,
  Select,
  Input,
  Alert,
  LoadingSpinner,
  Divider,
  Heading,
} from "@hubspot/ui-extensions";

const API_BASE = "https://referral-builder1122026.vercel.app";

hubspot.extend(({ context }) => <SessionCard context={context} />);

// ============================================================================
// Types
// ============================================================================

interface PostgresSession {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  startDateRaw: string;
  endDateRaw: string;
  tuition: number;
  currency: string;
  weeks: number;
  programName: string;
  companyName: string;
}

interface ReferralContext {
  campName: string | null;
  referralId: string;
}

type CardData =
  | { status: "not-in-pipeline" }
  | {
      status: "confirmed";
      tuition: string | null;
      weeks: string | null;
      currency: string | null;
      sessionName: string | null;
      sessionStartDate: string | null;
      sessionEndDate: string | null;
      notes: string | null;
    }
  | { status: "inactive"; message: string }
  | { status: "error"; message: string }
  | {
      status: "eligible";
      sessions: PostgresSession[];
      programName: string;
      programId: string | null;
      year: number | null;
      referralContext: ReferralContext | null;
    };

// ============================================================================
// Main component
// ============================================================================

interface SessionCardProps {
  context: { crm: { objectId: string | number } };
}

const SessionCard: React.FC<SessionCardProps> = ({ context }) => {
  const dealId = String(context.crm.objectId);

  const [loading, setLoading] = useState(true);
  const [cardData, setCardData] = useState<CardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const resp = await hubspot.fetch(
        `${API_BASE}/api/v2/deal/${dealId}/card-data`
      );
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      setCardData(await resp.json());
    } catch (err: any) {
      setError(`Load failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <Flex direction="column" align="center" gap="sm">
        <LoadingSpinner />
        <Text>Loading session data...</Text>
      </Flex>
    );
  }

  if (resultMessage) {
    return (
      <Flex direction="column" gap="sm">
        <Alert title="Success" variant="success">
          {resultMessage}
        </Alert>
        <Button
          onClick={() => {
            setResultMessage(null);
            fetchData();
          }}
        >
          Refresh
        </Button>
      </Flex>
    );
  }

  if (error && !cardData) {
    return (
      <Flex direction="column" gap="sm">
        <Alert title="Error" variant="error">
          {error}
        </Alert>
        <Button onClick={fetchData}>Retry</Button>
      </Flex>
    );
  }

  if (!cardData) {
    return <Text>No data available.</Text>;
  }

  switch (cardData.status) {
    case "not-in-pipeline":
      return null;

    case "confirmed":
      return (
        <ConfirmedView
          dealId={dealId}
          cardData={cardData}
          error={error}
          setError={setError}
          onCloned={() => fetchData()}
        />
      );

    case "inactive":
      return (
        <Flex direction="column" gap="sm">
          <Heading>Session Selection</Heading>
          <Alert variant="info">{cardData.message}</Alert>
        </Flex>
      );

    case "error":
      return (
        <Flex direction="column" gap="sm">
          <Heading>Session Selection</Heading>
          <Alert variant="warning">{cardData.message}</Alert>
        </Flex>
      );

    case "eligible":
      return (
        <EligibleView
          dealId={dealId}
          cardData={cardData}
          onSubmitted={(msg) => setResultMessage(msg)}
        />
      );
  }
};

// ============================================================================
// Eligible (Tuition Undecided) — pick a session or enter custom
// ============================================================================

interface EligibleViewProps {
  dealId: string;
  cardData: Extract<CardData, { status: "eligible" }>;
  onSubmitted: (message: string) => void;
}

const EligibleView: React.FC<EligibleViewProps> = ({
  dealId,
  cardData,
  onSubmitted,
}) => {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
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
      const resp = await hubspot.fetch(
        `${API_BASE}/api/v2/deal/${dealId}/select-session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: selectedSessionId,
            programId: cardData.programId,
          }),
        }
      );
      const result = await resp.json();
      if (resp.ok && result.success) {
        onSubmitted(result.message);
        setSelectedSessionId(null);
      } else {
        setError(result.message || "Failed to select session.");
      }
    } catch (err: any) {
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
      />
    );
  }

  return (
    <Flex direction="column" gap="sm">
      <Heading>Session Selection</Heading>
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
      />
      <Button
        variant="primary"
        onClick={handleSelectSession}
        disabled={!selectedSessionId || submitting}
      >
        {submitting ? "Selecting..." : "Select Session"}
      </Button>
    </Flex>
  );
};

// ============================================================================
// Custom session ("Other") form
// ============================================================================

interface CustomSessionFormProps {
  dealId: string;
  onCancel: () => void;
  onSubmitted: (message: string) => void;
}

const CustomSessionForm: React.FC<CustomSessionFormProps> = ({
  dealId,
  onCancel,
  onSubmitted,
}) => {
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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: description || "Custom session",
            tuition: parseFloat(tuition),
            currency: currency || "USD",
            weeks: parseFloat(weeks),
          }),
        }
      );
      const result = await resp.json();
      if (resp.ok && result.success) {
        onSubmitted(result.message);
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
      <Heading>Custom Session (Requires Approval)</Heading>
      {error && <Alert variant="error">{error}</Alert>}
      <Input
        label="Description"
        name="description"
        value={description}
        onChange={(val) => setDescription(val as string)}
      />
      <Input
        label="Tuition Amount"
        name="tuition"
        value={tuition}
        onChange={(val) => setTuition(val as string)}
      />
      <Input
        label="Currency (USD, CAD, etc.)"
        name="currency"
        value={currency}
        onChange={(val) => setCurrency(val as string)}
      />
      <Input
        label="Number of Weeks"
        name="weeks"
        value={weeks}
        onChange={(val) => setWeeks(val as string)}
      />
      <Flex direction="row" gap="sm">
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={submitting}
        >
          {submitting ? "Submitting..." : "Submit Custom Session"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Back
        </Button>
      </Flex>
    </Flex>
  );
};

// ============================================================================
// Confirmed (Won) — show summary + clone-for-year
// ============================================================================

interface ConfirmedViewProps {
  dealId: string;
  cardData: Extract<CardData, { status: "confirmed" }>;
  error: string | null;
  setError: (e: string | null) => void;
  onCloned: () => void;
}

const ConfirmedView: React.FC<ConfirmedViewProps> = ({
  dealId,
  cardData,
  error,
  setError,
  onCloned,
}) => {
  const [cloning, setCloning] = useState(false);
  const [cloneResult, setCloneResult] = useState<{
    newDealId: string;
    newDealName: string;
    deduped: boolean;
  } | null>(null);
  const [showCloneForm, setShowCloneForm] = useState(false);
  const [targetYear, setTargetYear] = useState(
    String(new Date().getFullYear() + 1)
  );

  // Locked-source confirmation flow (Phase 3c spec §1.5 + §5.1)
  const [needsConfirmation, setNeedsConfirmation] = useState<{
    message: string;
    lockedFields: string[];
  } | null>(null);

  const performClone = useCallback(
    async (confirmExpertFields: boolean) => {
      try {
        setCloning(true);
        setError(null);
        const resp = await hubspot.fetch(
          `${API_BASE}/api/v2/deal/${dealId}/clone-for-year`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              targetYear: parseInt(targetYear, 10),
              confirmExpertFields,
            }),
          }
        );
        const result = await resp.json();

        // 409 = locked source, needs confirmation
        if (resp.status === 409 && result.requiresConfirmation) {
          setNeedsConfirmation({
            message: result.message,
            lockedFields: result.lockedFields ?? [],
          });
          return;
        }

        if (resp.ok && result.success) {
          setCloneResult({
            newDealId: result.newDealId,
            newDealName: result.newDealName,
            deduped: !!result.deduped,
          });
          setShowCloneForm(false);
          setNeedsConfirmation(null);
          onCloned();
        } else {
          setError(result.message || "Failed to clone deal.");
        }
      } catch {
        setError("Failed to create next year deal. Please try again.");
      } finally {
        setCloning(false);
      }
    },
    [dealId, targetYear, setError, onCloned]
  );

  return (
    <Flex direction="column" gap="sm">
      <Heading>Session Confirmed</Heading>
      <Flex direction="row" gap="md">
        <Text format={{ fontWeight: "bold" }}>Tuition:</Text>
        <Text>
          {cardData.currency || "USD"} ${cardData.tuition ?? "-"}
        </Text>
      </Flex>
      <Flex direction="row" gap="md">
        <Text format={{ fontWeight: "bold" }}>Weeks:</Text>
        <Text>{cardData.weeks ?? "-"}</Text>
      </Flex>
      {cardData.sessionName && (
        <Flex direction="row" gap="md">
          <Text format={{ fontWeight: "bold" }}>Session:</Text>
          <Text>{cardData.sessionName}</Text>
        </Flex>
      )}
      {cardData.sessionStartDate && cardData.sessionEndDate && (
        <Flex direction="row" gap="md">
          <Text format={{ fontWeight: "bold" }}>Dates:</Text>
          <Text>
            {cardData.sessionStartDate} – {cardData.sessionEndDate}
          </Text>
        </Flex>
      )}
      <Flex direction="row" gap="md">
        <Text format={{ fontWeight: "bold" }}>Notes:</Text>
        <Text>{cardData.notes || "-"}</Text>
      </Flex>

      {cloneResult && (
        <Alert title="Deal created" variant="success">
          {cloneResult.deduped
            ? `Found existing clone for ${targetYear}: "${cloneResult.newDealName}".`
            : `Created "${cloneResult.newDealName}" for ${targetYear}.`}
        </Alert>
      )}

      {error && <Alert variant="error">{error}</Alert>}

      <Divider />

      {!showCloneForm && !cloneResult && (
        <Button variant="secondary" onClick={() => setShowCloneForm(true)}>
          Create Next Year Deal
        </Button>
      )}

      {showCloneForm && !needsConfirmation && (
        <Flex direction="column" gap="sm">
          <Heading>Create Deal for Next Year</Heading>
          <Text variant="microcopy">
            Creates a new deal with the same camp, owner, and expert
            assignment, but with tuition + session reset for the new year.
          </Text>
          <Input
            label="Target Year"
            name="targetYear"
            value={targetYear}
            onChange={(val) => setTargetYear(val as string)}
          />
          <Flex direction="row" gap="sm">
            <Button
              variant="primary"
              onClick={() => performClone(false)}
              disabled={cloning || !targetYear}
            >
              {cloning ? "Creating..." : "Create Deal"}
            </Button>
            <Button variant="secondary" onClick={() => setShowCloneForm(false)}>
              Cancel
            </Button>
          </Flex>
        </Flex>
      )}

      {needsConfirmation && (
        <Flex direction="column" gap="sm">
          <Alert title="Source deal is commission_locked" variant="warning">
            {needsConfirmation.message}
          </Alert>
          <Text variant="microcopy">
            These fields will be copied from the source deal to the new
            deal: {needsConfirmation.lockedFields.join(", ")}.
          </Text>
          <Flex direction="row" gap="sm">
            <Button
              variant="primary"
              onClick={() => performClone(true)}
              disabled={cloning}
            >
              {cloning ? "Creating..." : "Confirm and Create"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setNeedsConfirmation(null)}
            >
              Cancel
            </Button>
          </Flex>
        </Flex>
      )}
    </Flex>
  );
};
