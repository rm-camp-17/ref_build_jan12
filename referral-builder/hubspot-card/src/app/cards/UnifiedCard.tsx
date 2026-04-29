/**
 * Unified Camp Experts HubSpot Card — the "one powerful module" the
 * spec called for in UNIFIED_CARD_SPEC.md.
 *
 * Replaces:
 *   - ReferralBuilderCard.tsx (sidebar + tab placements)
 *   - SessionCard.tsx
 *
 * Switches between sub-views based on the deal's current dealstage.
 *
 * Data sources fetched in parallel on mount:
 *   - GET /api/v2/deal/[dealId]/card-data (existing, returns coarse
 *     stage status + sessions/referralContext payload)
 *   - GET /api/v2/deal/[dealId]/details   (new in Phase 4, returns the
 *     raw dealstage + ce_* + closed_* fields)
 *
 * Routing matrix (spec §3 + Phase 4 brief):
 *
 *   not-in-pipeline              -> render null
 *   error                        -> retry alert
 *   inactive + appointmentscheduled (New Lead)
 *                                -> SetupView
 *   inactive + presentationscheduled (Recommendation Plan Presented)
 *                                -> ReferralTableView
 *   inactive + qualifiedtobuy    (Intro Call Completed, rare)
 *                                -> ReferralTableView (per spec §3)
 *   inactive + closedlost        -> LostView (display mode)
 *   inactive + (any other stage) -> "Card not active at this stage" alert
 *   eligible (Tuition Undecided) -> SessionPickerView
 *   confirmed (Won)              -> WonView
 *
 * Cross-stage chrome:
 *   - <CommissionLockedBanner /> shown above the active view when
 *     details.commission_locked === "true"
 *   - <StageHeader /> always shown above the active view
 *
 * Mark-as-Lost from any non-terminal stage opens the inline LostView in
 * capture mode. After save, the router re-fetches and the deal usually
 * lands at closedlost, switching the view to display mode.
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  hubspot,
  Alert,
  Button,
  Flex,
  LoadingSpinner,
  Text,
} from "@hubspot/ui-extensions";

import {
  API_BASE,
  CardData,
  DealDetails,
  STAGES,
} from "./views/types";
import { CommissionLockedBanner } from "./views/CommissionLockedBanner";
import { StageHeader } from "./views/StageHeader";
import { SetupView } from "./views/SetupView";
import { ReferralTableView } from "./views/ReferralTableView";
import { SessionPickerView } from "./views/SessionPickerView";
import { WonView } from "./views/WonView";
import { LostView } from "./views/LostView";

// ============================================================================
// Stage label lookup (for the persistent header)
// ============================================================================

const STAGE_LABEL: Record<string, string> = {
  [STAGES.newLead]: "New Lead",
  [STAGES.introCallCompleted]: "Intro Call Completed",
  [STAGES.recommendationPresented]: "Recommendation Plan Presented",
  [STAGES.tuitionUndecided]: "Tuition Undecided",
  [STAGES.programSelected]: "Closed Won",
  [STAGES.closedLost]: "Closed Lost",
};

function labelForStage(dealstage: string | null | undefined): string {
  if (!dealstage) return "Unknown stage";
  return STAGE_LABEL[dealstage] || dealstage;
}

// ============================================================================
// Entry point
// ============================================================================

hubspot.extend(({ context, actions }) => (
  <UnifiedCard context={context} actions={actions} />
));

interface UnifiedCardProps {
  context: { crm: { objectId: string | number } };
  actions?: any;
}

function UnifiedCard({ context, actions }: UnifiedCardProps) {
  const dealId = context?.crm?.objectId
    ? String(context.crm.objectId)
    : null;

  const [loading, setLoading] = useState(true);
  const [cardData, setCardData] = useState<CardData | null>(null);
  const [details, setDetails] = useState<DealDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The "Mark as Lost" button on any non-terminal stage flips this to
  // true; the router then routes to LostView (capture mode) regardless
  // of the current stage. After save we clear it and re-fetch.
  const [markingLost, setMarkingLost] = useState(false);

  // ==========================================================================
  // Fetchers
  // ==========================================================================

  const fetchAll = useCallback(async () => {
    if (!dealId) return;
    setLoading(true);
    setLoadError(null);

    try {
      const [cardResp, detailsResp] = await Promise.all([
        hubspot.fetch(`${API_BASE}/api/v2/deal/${dealId}/card-data`),
        hubspot.fetch(`${API_BASE}/api/v2/deal/${dealId}/details`),
      ]);

      // card-data: always returns 200 with a status field even on error
      // (legacy contract). Treat HTTP errors as fatal; stage-router
      // handles `status: "error"` separately.
      if (!cardResp.ok) {
        throw new Error(`card-data HTTP ${cardResp.status}`);
      }
      const cardJson = (await cardResp.json()) as CardData;
      setCardData(cardJson);

      // details: 404 is fatal (deal disappeared); other errors fall
      // through and we just don't render the billing panel.
      if (detailsResp.ok) {
        const detailsJson = (await detailsResp.json()) as DealDetails;
        setDetails(detailsJson);
      } else if (detailsResp.status === 404) {
        throw new Error("Deal not found.");
      } else {
        // Soft-fail: we can still render the basic stage views without
        // billing/details data. Log and move on.
        console.warn(
          `[UnifiedCard] /details returned ${detailsResp.status}; rendering without billing panel`
        );
        setDetails(null);
      }
    } catch (err: any) {
      setLoadError(err?.message || "Failed to load deal data.");
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // ==========================================================================
  // Guards / loading / error
  // ==========================================================================

  if (!dealId) {
    return (
      <Alert title="Invalid context" variant="error">
        This card is meant to run on a Deal record.
      </Alert>
    );
  }

  if (loading) {
    return (
      <Flex direction="column" align="center" gap="sm">
        <LoadingSpinner />
        <Text>Loading deal...</Text>
      </Flex>
    );
  }

  if (loadError && !cardData) {
    return (
      <Flex direction="column" gap="sm">
        <Alert title="Error" variant="error">
          {loadError}
        </Alert>
        <Button variant="primary" onClick={fetchAll}>
          Retry
        </Button>
      </Flex>
    );
  }

  if (!cardData) {
    return <Text>No data available.</Text>;
  }

  // ==========================================================================
  // Top-level routing
  // ==========================================================================

  // 1. Off-pipeline — silently absent (no header, no banner).
  if (cardData.status === "not-in-pipeline") {
    return null;
  }

  // 2. Network/infra error returned in the payload.
  if (cardData.status === "error") {
    return (
      <Flex direction="column" gap="sm">
        <Alert title="Error" variant="error">
          {cardData.message}
        </Alert>
        <Button variant="primary" onClick={fetchAll}>
          Retry
        </Button>
      </Flex>
    );
  }

  // 3. Mark-as-Lost overlay — wins over the underlying stage view.
  //    Shown when the rep clicked "Mark as Lost" from any non-terminal
  //    stage. We pass the LostView in capture mode.
  if (markingLost) {
    return (
      <Flex direction="column" gap="sm">
        <StageHeader
          details={details}
          stageLabel={labelForStage(details?.dealstage)}
        />
        <CommissionLockedBanner details={details} />
        <LostView
          dealId={dealId}
          details={details}
          mode="capture"
          onSaved={() => {
            setMarkingLost(false);
            fetchAll();
          }}
          onCancel={() => setMarkingLost(false)}
        />
      </Flex>
    );
  }

  // 4. Closed Lost (the deal is already at closedlost) — display mode.
  //    /card-data lumps closedlost under `inactive`; the dealstage check
  //    below short-circuits to LostView in display mode.
  if (details?.dealstage === STAGES.closedLost) {
    return (
      <Flex direction="column" gap="sm">
        <StageHeader details={details} stageLabel={labelForStage(details.dealstage)} />
        <CommissionLockedBanner details={details} />
        <LostView
          dealId={dealId}
          details={details}
          mode="display"
          onSaved={fetchAll}
        />
      </Flex>
    );
  }

  // 5. Tuition Undecided
  if (cardData.status === "eligible") {
    return (
      <Flex direction="column" gap="sm">
        <StageHeader
          details={details}
          stageLabel={labelForStage(details?.dealstage || STAGES.tuitionUndecided)}
        />
        <CommissionLockedBanner details={details} />
        <SessionPickerView
          dealId={dealId}
          cardData={cardData}
          details={details}
          onSubmitted={fetchAll}
          onMarkLost={() => setMarkingLost(true)}
        />
      </Flex>
    );
  }

  // 6. Won
  if (cardData.status === "confirmed") {
    return (
      <Flex direction="column" gap="sm">
        <StageHeader
          details={details}
          stageLabel={labelForStage(details?.dealstage || STAGES.programSelected)}
        />
        <CommissionLockedBanner details={details} />
        <WonView
          dealId={dealId}
          cardData={cardData}
          details={details}
          onCloned={fetchAll}
          onSavedReason={fetchAll}
          onMarkLost={() => setMarkingLost(true)}
        />
      </Flex>
    );
  }

  // 7. inactive — branch on raw dealstage from /details.
  if (cardData.status === "inactive") {
    const dealstage = details?.dealstage || null;

    if (dealstage === STAGES.newLead) {
      return (
        <Flex direction="column" gap="sm">
          <StageHeader details={details} stageLabel={labelForStage(dealstage)} />
          <CommissionLockedBanner details={details} />
          <SetupView
            dealId={dealId}
            details={details}
            onMarkLost={() => setMarkingLost(true)}
            onRefresh={fetchAll}
          />
        </Flex>
      );
    }

    if (
      dealstage === STAGES.recommendationPresented ||
      dealstage === STAGES.introCallCompleted
    ) {
      return (
        <Flex direction="column" gap="sm">
          <StageHeader details={details} stageLabel={labelForStage(dealstage)} />
          <CommissionLockedBanner details={details} />
          <ReferralTableView
            dealId={dealId}
            details={details}
            actions={actions}
            onStageMaybeChanged={fetchAll}
            onMarkLost={() => setMarkingLost(true)}
          />
        </Flex>
      );
    }

    // Any other inactive stage — informational only.
    return (
      <Flex direction="column" gap="sm">
        <StageHeader details={details} stageLabel={labelForStage(dealstage)} />
        <CommissionLockedBanner details={details} />
        <Alert title="Card not active at this stage" variant="info">
          {cardData.message ||
            "This deal isn't at a stage the unified card supports yet."}
        </Alert>
      </Flex>
    );
  }

  // Unreachable — keep the type checker happy.
  return null;
}
