/**
 * WonView — rendered when the deal is at Closed Won (= Program Selected,
 * `decisionmakerboughtin`).
 *
 * Spec §4.4. Composes:
 *   - The legacy SessionCard.tsx <ConfirmedView /> (read-only session
 *     summary + "Create Next Year Deal" with the locked-source
 *     confirmation flow)
 *   - <WinReasonCapture /> for closed_won_category + closed_won_reason.
 *     Calls PATCH /api/deals/[dealId]/win-reason which Agent G is
 *     building. If the endpoint returns 404, the form falls back to a
 *     "Phase 5 — coming soon" placeholder.
 *   - <BillingPanel /> for the read-only ce_* + commission_status
 *     chips, sourced from /api/v2/deal/[dealId]/details.
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
import {
  API_BASE,
  CardData,
  DealDetails,
  isCommissionLocked,
} from "./types";

type Confirmed = Extract<CardData, { status: "confirmed" }>;

interface Props {
  dealId: string;
  cardData: Confirmed;
  details: DealDetails | null;
  onCloned: () => void;
  onSavedReason: () => void;
  onMarkLost: () => void;
}

// ============================================================================
// Main view
// ============================================================================

export function WonView({
  dealId,
  cardData,
  details,
  onCloned,
  onSavedReason,
  onMarkLost,
}: Props) {
  const locked = isCommissionLocked(details);
  const [error, setError] = useState<string | null>(null);

  return (
    <Flex direction="column" gap="sm">
      <Heading level={3}>Session Confirmed</Heading>

      <SessionSummary cardData={cardData} />

      <Divider />

      <BillingPanel details={details} />

      <Divider />

      <WinReasonCapture
        dealId={dealId}
        details={details}
        locked={locked}
        onSaved={onSavedReason}
      />

      <Divider />

      <CloneForYearSection
        dealId={dealId}
        error={error}
        setError={setError}
        onCloned={onCloned}
      />

      <Divider />

      <Flex direction="row" gap="sm">
        <Button variant="destructive" onClick={onMarkLost}>
          Mark as Lost
        </Button>
      </Flex>
    </Flex>
  );
}

// ============================================================================
// Session summary (read-only)
// ============================================================================

function SessionSummary({ cardData }: { cardData: Confirmed }) {
  return (
    <Flex direction="column" gap="xs">
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
    </Flex>
  );
}

// ============================================================================
// BillingPanel — read-only ce_* fields
// ============================================================================

function commissionStatusVariant(
  status: string | null | undefined
): "default" | "success" | "warning" {
  switch ((status || "").toLowerCase()) {
    case "paid":
      return "success";
    case "billed":
    case "calculated":
      return "default";
    case "void":
    case "pending":
      return "warning";
    default:
      return "default";
  }
}

function invoiceStatusVariant(
  status: string | null | undefined
): "default" | "success" | "warning" {
  switch ((status || "").toLowerCase()) {
    case "paid":
    case "reconciled":
      return "success";
    case "partial":
    case "sent":
      return "default";
    case "draft":
      return "warning";
    default:
      return "default";
  }
}

function formatCurrency(amount: string | null, currency: string | null): string {
  if (!amount) return "—";
  const n = parseFloat(amount);
  if (Number.isNaN(n)) return amount;
  const cur = currency || "USD";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${cur} $${n.toLocaleString()}`;
  }
}

export function BillingPanel({ details }: { details: DealDetails | null }) {
  if (!details) return null;
  const currency = details.deal_currency_code || "USD";

  return (
    <Box>
      <Heading level={3}>Billing</Heading>
      <Text variant="microcopy">
        Synced from billing engine. Commission lock:{" "}
        {details.commission_locked === "true" ? "yes" : "no"}.
      </Text>
      <Flex direction="column" gap="xs">
        <Flex direction="row" gap="md" align="center" wrap="wrap">
          <Text format={{ fontWeight: "bold" }}>Commission status:</Text>
          <Tag variant={commissionStatusVariant(details.commission_status)}>
            {details.commission_status || "pending"}
          </Tag>
        </Flex>
        <Flex direction="row" gap="md">
          <Text format={{ fontWeight: "bold" }}>Commission amount:</Text>
          <Text>{formatCurrency(details.ce_commission_amount, currency)}</Text>
        </Flex>
        <Flex direction="row" gap="md">
          <Text format={{ fontWeight: "bold" }}>Amount received:</Text>
          <Text>{formatCurrency(details.ce_amount_received, currency)}</Text>
        </Flex>
        <Flex direction="row" gap="md" align="center" wrap="wrap">
          <Text format={{ fontWeight: "bold" }}>Invoice status:</Text>
          <Tag variant={invoiceStatusVariant(details.ce_invoice_status)}>
            {details.ce_invoice_status || "—"}
          </Tag>
        </Flex>
      </Flex>
    </Box>
  );
}

// ============================================================================
// WinReasonCapture
// ============================================================================

const WIN_CATEGORY_OPTIONS = [
  { label: "Returning camper", value: "RETURNING" },
  { label: "New placement", value: "NEW_PLACEMENT" },
  { label: "Referral-driven", value: "REFERRAL_DRIVEN" },
  { label: "Co-work", value: "CO_WORK" },
  { label: "Other", value: "OTHER" },
];

interface WinReasonProps {
  dealId: string;
  details: DealDetails | null;
  locked: boolean;
  onSaved: () => void;
}

export function WinReasonCapture({
  dealId,
  details,
  locked,
  onSaved,
}: WinReasonProps) {
  const [category, setCategory] = useState(details?.closed_won_category || "");
  const [reason, setReason] = useState(details?.closed_won_reason || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [endpointMissing, setEndpointMissing] = useState(false);

  const handleSave = useCallback(async () => {
    if (!category) {
      setError("Pick a category before saving.");
      return;
    }
    setError(null);
    setSuccess(false);
    setSaving(true);
    try {
      // hubspot.fetch only allows the Authorization header — Content-Type
      // is rejected with HTTP 400 before the call leaves the iframe.
      const resp = await hubspot.fetch(
        `${API_BASE}/api/deals/${dealId}/win-reason`,
        {
          method: "PATCH",
          body: JSON.stringify({
            closed_won_category: category,
            closed_won_reason: reason,
          }),
        }
      );
      if (resp.status === 404) {
        // Agent G's endpoint hasn't shipped yet — graceful degrade.
        setEndpointMissing(true);
        return;
      }
      const result = await resp.json().catch(() => ({}));
      if (resp.ok) {
        setSuccess(true);
        onSaved();
      } else {
        setError(result?.message || result?.error || "Failed to save reason.");
      }
    } catch {
      // Network error — most likely the route is missing in this build.
      setEndpointMissing(true);
    } finally {
      setSaving(false);
    }
  }, [dealId, category, reason, onSaved]);

  return (
    <Box>
      <Heading level={3}>Win reason</Heading>
      <Text variant="microcopy">
        Helps the team learn what's working. Used in monthly retros.
      </Text>

      {error && <Alert variant="error">{error}</Alert>}
      {success && <Alert variant="success">Win reason saved.</Alert>}
      {endpointMissing && (
        <Alert title="Phase 5 — coming soon" variant="info">
          The win-reason endpoint is still being deployed. Your selection is
          held in this view; please re-save once the backend is live.
        </Alert>
      )}

      <Flex direction="column" gap="sm">
        <Select
          label="Category"
          name="closed_won_category"
          options={WIN_CATEGORY_OPTIONS}
          value={category}
          onChange={(val) => setCategory(val as string)}
          readOnly={locked}
        />
        <TextArea
          label="Reason / context"
          name="closed_won_reason"
          value={reason}
          onChange={(val) => setReason(val as string)}
          rows={4}
          readOnly={locked}
        />
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={saving || locked}
        >
          {saving ? "Saving..." : "Save win reason"}
        </Button>
      </Flex>
    </Box>
  );
}

// ============================================================================
// Clone-for-year (preserved from legacy ConfirmedView)
// ============================================================================

interface CloneSectionProps {
  dealId: string;
  error: string | null;
  setError: (e: string | null) => void;
  onCloned: () => void;
}

function CloneForYearSection({
  dealId,
  error,
  setError,
  onCloned,
}: CloneSectionProps) {
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
            body: JSON.stringify({
              targetYear: parseInt(targetYear, 10),
              confirmExpertFields,
            }),
          }
        );
        const result = await resp.json();

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
    <Box>
      {cloneResult && (
        <Alert title="Deal created" variant="success">
          {cloneResult.deduped
            ? `Found existing clone for ${targetYear}: "${cloneResult.newDealName}".`
            : `Created "${cloneResult.newDealName}" for ${targetYear}.`}
        </Alert>
      )}

      {error && <Alert variant="error">{error}</Alert>}

      {!showCloneForm && !cloneResult && (
        <Button variant="secondary" onClick={() => setShowCloneForm(true)}>
          Create Next Year Deal
        </Button>
      )}

      {showCloneForm && !needsConfirmation && (
        <Flex direction="column" gap="sm">
          <Heading level={3}>Create Deal for Next Year</Heading>
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
            <Button
              variant="secondary"
              onClick={() => setShowCloneForm(false)}
            >
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
            These fields will be copied from the source deal to the new deal:{" "}
            {needsConfirmation.lockedFields.join(", ")}.
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
    </Box>
  );
}
