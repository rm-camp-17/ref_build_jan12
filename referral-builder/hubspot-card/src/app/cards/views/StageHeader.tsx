/**
 * Small persistent header rendered at the top of every stage view so
 * the rep always knows which deal + stage they're looking at.
 *
 * Pure presentational — receives the merged DealDetails plus a friendly
 * stage label from the router.
 */

import React from "react";
import { Flex, Text, Tag, Heading } from "@hubspot/ui-extensions";
import { DealDetails, STAGES } from "./types";

interface Props {
  details: DealDetails | null;
  stageLabel: string;
}

const STAGE_VARIANT: Record<string, "default" | "success" | "warning"> = {
  [STAGES.newLead]: "default",
  [STAGES.introCallCompleted]: "default",
  [STAGES.recommendationPresented]: "default",
  [STAGES.tuitionUndecided]: "warning",
  [STAGES.programSelected]: "success",
  [STAGES.closedLost]: "warning",
};

export function StageHeader({ details, stageLabel }: Props) {
  const dealName = details?.dealname || `Deal ${details?.id ?? ""}`;
  const year = details?.year1 || "—";
  const variant =
    (details?.dealstage && STAGE_VARIANT[details.dealstage]) || "default";

  return (
    <Flex direction="column" gap="flush">
      <Flex direction="row" justify="space-between" align="center" wrap="wrap">
        <Heading level={2}>{dealName}</Heading>
        <Tag variant={variant}>{stageLabel}</Tag>
      </Flex>
      <Text variant="microcopy">Year {year}</Text>
    </Flex>
  );
}
