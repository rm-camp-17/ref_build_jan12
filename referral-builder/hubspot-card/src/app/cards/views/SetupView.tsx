/**
 * SetupView — rendered when the deal is at New Lead
 * (`appointmentscheduled`).
 *
 * Spec §4.1. Shows the three required associations as a checklist
 * (Child / Household / Parent Contact) and provides two primary actions:
 *
 *   - "Add Referrals" — instructs the rep to advance the deal to
 *     "Recommendation Plan Presented" via HubSpot's pipeline UI for now
 *     (the dedicated stage-advance endpoint is deferred to a follow-up
 *     PR per the brief; spinning a button without the backend would be
 *     misleading).
 *   - "Mark as Lost" — opens the inline LostView in capture mode.
 *
 * The "Associate Child / Household / Parent Contact" buttons are
 * present but disabled — the actual creation flow is Phase 5 work.
 * Today they exist only as visual affordances pointing the rep at
 * HubSpot's right-sidebar associations panel.
 */

import React, { useEffect, useState, useCallback } from "react";
import {
  hubspot,
  Alert,
  Box,
  Button,
  Divider,
  Flex,
  Heading,
  LoadingSpinner,
  Tag,
  Text,
} from "@hubspot/ui-extensions";
import { DealDetails, isCommissionLocked } from "./types";

// ============================================================================
// Association status (read-only check — Phase 5 builds the create flow)
// ============================================================================

interface AssociationStatus {
  child: boolean;
  household: boolean;
  parentContact: boolean;
}

interface Props {
  dealId: string;
  details: DealDetails | null;
  onMarkLost: () => void;
  onRefresh: () => void;
}

export function SetupView({
  dealId,
  details,
  onMarkLost,
  onRefresh,
}: Props) {
  const [assocLoading, setAssocLoading] = useState(true);
  const [assoc, setAssoc] = useState<AssociationStatus>({
    child: false,
    household: false,
    parentContact: false,
  });
  const [assocError, setAssocError] = useState<string | null>(null);

  const locked = isCommissionLocked(details);

  // ------------------------------------------------------------------
  // Read-side associations check.
  //
  // Pragmatic shortcut for Phase 4: rather than waiting on Agent G's
  // /api/deals/[dealId]/setup-status route, infer Child + Household from
  // the deal-property IDs we already fetch via /details, and call
  // HubSpot's CRM v4 associations endpoint directly for the
  // Deal → Contact check. The detailed Phase 5 endpoint can replace
  // this once it lands; the props are unchanged.
  // ------------------------------------------------------------------
  const loadAssociations = useCallback(async () => {
    if (!dealId) return;
    setAssocLoading(true);
    setAssocError(null);

    try {
      const child = !!(details?.associated_child_id && details.associated_child_id.trim() !== "");
      const household = !!(
        details?.associated_household_id &&
        details.associated_household_id.trim() !== ""
      );

      // Parent contacts: count default Deal → Contact associations.
      let parentContact = false;
      try {
        const resp = await hubspot.fetch(
          `https://api.hubapi.com/crm/v4/objects/deals/${dealId}?associations=contacts`
        );
        if (resp.ok) {
          const data = await resp.json();
          const results = data?.associations?.contacts?.results ?? [];
          parentContact = results.length > 0;
        }
      } catch (e) {
        // Non-fatal — leave parentContact false; the row will render an X
        // and the rep can still proceed with Add Referrals.
        console.warn("Could not check parent-contact associations", e);
      }

      setAssoc({ child, household, parentContact });
    } catch (e: any) {
      setAssocError(e?.message || "Failed to load associations.");
    } finally {
      setAssocLoading(false);
    }
  }, [dealId, details]);

  useEffect(() => {
    loadAssociations();
  }, [loadAssociations]);

  return (
    <Flex direction="column" gap="sm">
      <Heading level={3}>Setup</Heading>
      <Text variant="microcopy">
        Confirm the deal has its three core associations, then advance to
        Recommendation Plan Presented to start adding referrals.
      </Text>

      {assocError && (
        <Alert title="Error" variant="error">
          {assocError}
        </Alert>
      )}

      {assocLoading ? (
        <LoadingSpinner label="Checking associations..." size="small" />
      ) : (
        <Flex direction="column" gap="xs">
          <ChecklistRow
            label="Associated Child"
            ok={assoc.child}
            disabled={locked}
          />
          <ChecklistRow
            label="Associated Household"
            ok={assoc.household}
            disabled={locked}
          />
          <ChecklistRow
            label="Parent Contact(s)"
            ok={assoc.parentContact}
            disabled={locked}
          />
        </Flex>
      )}

      <Divider />

      <Alert title="Advance the deal" variant="info">
        Once the associations above look right, advance the deal stage to
        "Recommendation Plan Presented" using HubSpot's pipeline UI in the
        deal header. The card will switch to the referral table on next
        load.
      </Alert>

      <Flex direction="row" gap="sm" wrap="wrap">
        <Button variant="primary" onClick={onRefresh}>
          Refresh
        </Button>
        <Button variant="destructive" onClick={onMarkLost} disabled={locked}>
          Mark as Lost
        </Button>
      </Flex>
    </Flex>
  );
}

// ============================================================================
// Checklist row
// ============================================================================

interface ChecklistRowProps {
  label: string;
  ok: boolean;
  disabled: boolean;
}

function ChecklistRow({ label, ok, disabled }: ChecklistRowProps) {
  return (
    <Box>
      <Flex direction="row" justify="space-between" align="center">
        <Flex direction="row" gap="sm" align="center">
          <Tag variant={ok ? "success" : "warning"}>{ok ? "Linked" : "Missing"}</Tag>
          <Text>{label}</Text>
        </Flex>
        {!ok && (
          <Button
            size="small"
            variant="secondary"
            disabled={true}
            // tooltip prop intentionally omitted (not all platform versions
            // support it on Button); the disabled state + microcopy below
            // communicates the intent
          >
            Associate
          </Button>
        )}
      </Flex>
      {!ok && !disabled && (
        <Text variant="microcopy">
          Coming soon — for now use HubSpot's right-sidebar associations
          panel.
        </Text>
      )}
    </Box>
  );
}
