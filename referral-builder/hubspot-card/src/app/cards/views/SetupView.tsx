/**
 * SetupView — rendered when the deal is at New Lead
 * (`appointmentscheduled`).
 *
 * Spec §4.1. Forward-nav ("Continue to Referrals") and the visual stage
 * stepper live in <StageHeader />, so this view is just an informational
 * checklist of the three core associations plus the Mark-as-Lost off-ramp.
 *
 * All three association counts come from live HubSpot lookups in
 * /details (not the legacy `associated_*_id` deal properties, which
 * don't auto-populate when associations are created via HubSpot's
 * right-rail UI).
 *
 * Household is enforced as required at the HubSpot setup level, so the
 * checklist is informational only — it doesn't gate the Continue button
 * (StageHeader doesn't read this view's state).
 */

import React from "react";
import {
  Box,
  Button,
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

export function SetupView({ details, onMarkLost, onRefresh }: Props) {
  const locked = isCommissionLocked(details);

  const child = (details?.associated_child_count ?? 0) > 0;
  const household = (details?.associated_household_count ?? 0) > 0;
  const parentContact = (details?.parent_contact_count ?? 0) > 0;

  return (
    <Flex direction="column" gap="sm">
      <Heading level={3}>Required associations</Heading>
      <Text variant="microcopy">
        These are required on the deal. Use the header above to advance
        the stage once you're ready.
      </Text>

      <Flex direction="column" gap="xs">
        <ChecklistRow label="Associated Child" ok={child} />
        <ChecklistRow label="Associated Household" ok={household} />
        <ChecklistRow label="Parent Contact(s)" ok={parentContact} />
      </Flex>

      <Flex direction="row" gap="sm" wrap="wrap">
        <Button variant="secondary" onClick={onRefresh}>
          Refresh
        </Button>
        <Button variant="destructive" onClick={onMarkLost} disabled={locked}>
          Mark as Lost
        </Button>
      </Flex>
    </Flex>
  );
}

interface ChecklistRowProps {
  label: string;
  ok: boolean;
}

function ChecklistRow({ label, ok }: ChecklistRowProps) {
  return (
    <Box>
      <Flex direction="row" gap="sm" align="center">
        <Tag variant={ok ? "success" : "warning"}>{ok ? "Linked" : "Missing"}</Tag>
        <Text>{label}</Text>
      </Flex>
    </Box>
  );
}
