/**
 * Cross-stage banner shown when the deal has `commission_locked = "true"`.
 *
 * Per spec §5.1, this is informational only — the actual enforcement
 * lives server-side in `requireUnlocked` middleware on every mutating
 * route. The banner exists so reps don't try to edit the five sacred
 * fields and bounce off a 409. Each view that hosts editable sacred
 * inputs is responsible for disabling them when this banner is shown.
 */

import React from "react";
import { Alert } from "@hubspot/ui-extensions";
import { DealDetails, isCommissionLocked } from "./types";

interface Props {
  details: DealDetails | null;
}

export function CommissionLockedBanner({ details }: Props) {
  if (!isCommissionLocked(details)) return null;

  return (
    <Alert title="Billing has finalized this deal" variant="warning">
      Tuition, expert profile, referral, and co-work fields are read-only.
      Contact billing@campexperts.com to make changes.
    </Alert>
  );
}
