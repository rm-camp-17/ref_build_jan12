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

import React from "react";
import {
  Alert,
  Box,
  Button,
  Divider,
  Flex,
  Heading,
  Tag,
  Text,
} from "@hubspot/ui-extensions";
import { DealDetails, isCommissionLocked } from "./types";

interface Props {
  dealId: string;
  details: DealDetails | null;
  onMarkLost: () => void;
  onRefresh: () => void;
}

export function SetupView({
  details,
  onMarkLost,
  onRefresh,
}: Props) {
  const locked = isCommissionLocked(details);

  // Counts come from server-side association lookups in /details — the
  // legacy `associated_child_id` / `associated_household_id` Deal properties
  // don't auto-populate when a rep creates the association via HubSpot's
  // right-rail UI, so checking the count of actual associations is the
  // honest signal.
  const child = (details?.associated_child_count ?? 0) > 0;
  const household = !!(
    details?.associated_household_id &&
    details.associated_household_id.trim() !== ""
  );
  const parentContact = (details?.parent_contact_count ?? 0) > 0;

  return (
    <Flex direction="column" gap="sm">
      <Heading level={3}>Setup</Heading>
      <Text variant="microcopy">
        Confirm the deal has its three core associations, then advance to
        Recommendation Plan Presented to start adding referrals.
      </Text>

      <Flex direction="column" gap="xs">
        <ChecklistRow
          label="Associated Child"
          ok={child}
          disabled={locked}
        />
        <ChecklistRow
          label="Associated Household"
          ok={household}
          disabled={locked}
        />
        <ChecklistRow
          label="Parent Contact(s)"
          ok={parentContact}
          disabled={locked}
        />
      </Flex>

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
