/**
 * Persistent stage header rendered above every view by UnifiedCard.
 *
 * Purpose: give the rep an at-a-glance view of where the deal is in the
 * pipeline AND let them move it forward/backward without ever touching
 * HubSpot's pipeline dropdown in the deal sidebar (which uses cryptic
 * internal stage labels and reps don't recognize).
 *
 * Pipeline stepper (linear, 4 visible stages):
 *   1. Setup       (appointmentscheduled)
 *   2. Referrals   (presentationscheduled, or rare qualifiedtobuy)
 *   3. Session     (1282923123 Tuition Undecided)
 *   4. Won         (decisionmakerboughtin)
 *
 * Closed Lost is off-path — when the deal is closedlost we show a Lost
 * tag and skip the stepper.
 *
 * Navigation rules:
 *   - "Continue to Referrals →" appears on Setup (advance-stage endpoint
 *     accepts presentationscheduled directly).
 *   - "← Back to Setup" appears on Referrals.
 *   - "← Back to Referrals" appears on Session — going from Session back
 *     to Referrals is supported because select-session writes the program
 *     fields on forward; back-nav doesn't unwrite them but that's fine
 *     since the rep is explicitly stepping back to reconsider.
 *   - Forward from Referrals (→ Session) is NOT a one-click button — it
 *     happens through Mark Selected, which runs the saga that writes
 *     program_id / programname / tuition_at_enrollment. Bypassing that
 *     would leave the deal in an inconsistent state.
 *   - Forward from Session (→ Won) is owned by /select-session, not this
 *     route.
 *   - All nav disabled when commission_locked (preserves the existing
 *     guard on locked deals — same behavior as the previous version).
 */

import React, { useState } from "react";
import {
  hubspot,
  Alert,
  Button,
  Flex,
  Heading,
  StepIndicator,
  Tag,
  Text,
} from "@hubspot/ui-extensions";
import { API_BASE, DealDetails, STAGES, isCommissionLocked } from "./types";

interface Props {
  dealId: string;
  details: DealDetails | null;
  stageLabel: string;
  onChanged: () => void;
}

const STEP_NAMES = ["Setup", "Referrals", "Session", "Won"] as const;

/**
 * Map a raw HubSpot dealstage to a 0-based step index, or `null` for
 * off-stepper states (closedlost, unknown).
 */
function stageToStep(dealstage: string | null | undefined): number | null {
  if (!dealstage) return null;
  switch (dealstage) {
    case STAGES.newLead:
      return 0;
    case STAGES.introCallCompleted: // rare, same view as Referrals
    case STAGES.recommendationPresented:
      return 1;
    case STAGES.tuitionUndecided:
      return 2;
    case STAGES.programSelected:
      return 3;
    default:
      return null;
  }
}

export function StageHeader({ dealId, details, stageLabel, onChanged }: Props) {
  const dealName = details?.dealname || `Deal ${details?.id ?? ""}`;
  const year = details?.year1 || "—";
  const dealstage = details?.dealstage ?? null;
  const locked = isCommissionLocked(details);
  const step = stageToStep(dealstage);
  const isLost = dealstage === STAGES.closedLost;

  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const moveToStage = async (toStage: string) => {
    setError(null);
    setMoving(true);
    try {
      // hubspot.fetch only allows the Authorization header — Content-Type
      // is set by HubSpot's iframe transport. Backend uses req.text() +
      // parseRequestBody.
      const resp = await hubspot.fetch(
        `${API_BASE}/api/deals/${dealId}/advance-stage`,
        {
          method: "POST",
          body: JSON.stringify({ toStage }),
        }
      );
      const result = await resp.json().catch(() => ({}));
      if (resp.ok) {
        onChanged();
      } else {
        setError(result?.message || result?.error || "Failed to change stage.");
      }
    } catch (err: any) {
      setError(err?.message || "Failed to change stage.");
    } finally {
      setMoving(false);
    }
  };

  return (
    <Flex direction="column" gap="sm">
      <Flex direction="row" justify="space-between" align="center" wrap="wrap">
        <Heading level={2}>{dealName}</Heading>
        <Tag variant={isLost ? "warning" : "default"}>{stageLabel}</Tag>
      </Flex>
      <Text variant="microcopy">Year {year}</Text>

      {step !== null && (
        <StepIndicator currentStep={step} stepNames={[...STEP_NAMES]} />
      )}

      {error && (
        <Alert title="Couldn't change stage" variant="error">
          {error}
        </Alert>
      )}

      {!isLost && step !== null && (
        <StageNavButtons
          step={step}
          moving={moving}
          locked={locked}
          onMove={moveToStage}
        />
      )}
    </Flex>
  );
}

// ============================================================================
// Nav buttons — what's shown depends on the current step.
// ============================================================================

interface NavButtonsProps {
  step: number;
  moving: boolean;
  locked: boolean;
  onMove: (toStage: string) => void;
}

function StageNavButtons({ step, moving, locked, onMove }: NavButtonsProps) {
  const buttons: React.ReactNode[] = [];

  // Back button (steps 1, 2 only — Setup is the first, Won is terminal).
  if (step === 1) {
    buttons.push(
      <Button
        key="back"
        variant="secondary"
        disabled={locked || moving}
        onClick={() => onMove(STAGES.newLead)}
      >
        ← Back to Setup
      </Button>
    );
  } else if (step === 2) {
    buttons.push(
      <Button
        key="back"
        variant="secondary"
        disabled={locked || moving}
        onClick={() => onMove(STAGES.recommendationPresented)}
      >
        ← Back to Referrals
      </Button>
    );
  }

  // Forward button — only Setup → Referrals is a one-click move.
  // Forward from Referrals and Session require workflow actions (Mark
  // Selected / Pick Session) which live in their respective views.
  if (step === 0) {
    buttons.push(
      <Button
        key="forward"
        variant="primary"
        disabled={locked || moving}
        onClick={() => onMove(STAGES.recommendationPresented)}
      >
        {moving ? "Advancing..." : "Continue to Referrals →"}
      </Button>
    );
  }

  if (buttons.length === 0) {
    return null;
  }

  return (
    <Flex direction="row" gap="sm" wrap="wrap">
      {buttons}
    </Flex>
  );
}
