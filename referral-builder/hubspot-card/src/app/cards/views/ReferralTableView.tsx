/**
 * ReferralTableView — rendered when the deal is at Recommendation Plan
 * Presented (`presentationscheduled`) or the rare `qualifiedtobuy`
 * Intro Call Completed stage.
 *
 * This is the body of the legacy ReferralBuilderCard.tsx, hoisted into
 * a shared component so the unified card can compose it with the other
 * stage views. Behavior is unchanged from the legacy card:
 *
 *   - Two-column layout (create form + existing referrals list)
 *   - Household History panel (collapsible)
 *   - Mark-Selected confirmation flow that triggers the saga in
 *     `lib/workflow.ts` server-side
 *
 * After a successful Mark Selected, the saga advances dealstage to
 * Tuition Undecided. The unified router re-fetches card-data on the
 * `onStageMaybeChanged` callback and switches to <SessionPickerView />.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hubspot,
  Alert,
  Box,
  Button,
  Checkbox,
  Divider,
  EmptyState,
  Flex,
  Heading,
  Input,
  Link,
  LoadingSpinner,
  Select,
  StepIndicator,
  Tag,
  Text,
  TextArea,
} from "@hubspot/ui-extensions";
import { API_BASE, DealDetails, isCommissionLocked } from "./types";

// ============================================================================
// Constants
// ============================================================================

const DEFAULTS = {
  REFERRAL_STATUS: "Ready to Send",
  CLIENT_INTEREST: "Active / considering",
} as const;

const FALLBACK_STATUS_OPTIONS: Option[] = [
  { label: "Draft", value: "Draft" },
  { label: "Ready to Send", value: "Ready to Send" },
  { label: "Sent", value: "Sent" },
  { label: "Resend", value: "Resend" },
  { label: "Don't send (already sent)", value: "Don't send (already sent)" },
];

const FALLBACK_INTEREST_OPTIONS: Option[] = [
  { label: "Active / considering", value: "Active / considering" },
  { label: "Shortlist", value: "Shortlist" },
  { label: "Neutral", value: "Neutral" },
  { label: "Unlikely", value: "Unlikely" },
  { label: "Declined", value: "Declined" },
  { label: "Selected", value: "Selected" },
];

// ============================================================================
// Types
// ============================================================================

type Option = { label: string; value: string };

interface ReferralRow {
  id: string;
  referralKey?: string;
  outreachStatus?: string;
  clientInterest?: string;
  note?: string;
  createdAt?: string;
  company?: { id?: string; name?: string } | null;
}

interface DealCompany {
  id: string;
  name?: string;
}

interface HouseholdReferral {
  id: string;
  referralKey?: string;
  outreachStatus?: string;
  clientInterest?: string;
  note?: string;
  createdAt?: string;
  company?: { id?: string; name?: string } | null;
  program?: { id?: string; name?: string } | null;
  session?: { id?: string; name?: string } | null;
}

interface HouseholdDeal {
  dealId: string;
  dealName: string;
  dealKey: string;
  dealYear: string;
  childId: string | null;
  isSameChild: boolean;
  referrals: HouseholdReferral[];
}

interface HouseholdData {
  currentDealChildId: string | null;
  householdDeals: HouseholdDeal[];
}

interface Props {
  dealId: string;
  details: DealDetails | null;
  actions?: any;
  onStageMaybeChanged: () => void;
  onMarkLost: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

function getStatusTagVariant(
  status: string
): "default" | "success" | "warning" {
  switch (status) {
    case "Sent":
      return "success";
    case "Resend":
    case "Draft":
      return "warning";
    default:
      return "default";
  }
}

function getInterestTagVariant(
  interest: string
): "default" | "success" | "warning" {
  switch (interest) {
    case "Selected":
      return "success";
    case "Shortlist":
      return "success";
    case "Unlikely":
    case "Declined":
      return "warning";
    default:
      return "default";
  }
}

function getInterestPipelineNote(interest: string): string | null {
  switch (interest) {
    case "Selected":
      return "Selected = advances deal to tuition entry";
    default:
      return null;
  }
}

// ============================================================================
// Main component
// ============================================================================

export function ReferralTableView({
  dealId,
  details,
  actions,
  onStageMaybeChanged,
  onMarkLost,
}: Props) {
  const locked = isCommissionLocked(details);

  // Loading and error states
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Double-submit prevention
  const submitInProgress = useRef(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searching, setSearching] = useState(false);

  // Data states
  const [referrals, setReferrals] = useState<ReferralRow[]>([]);
  const [dealCompanies, setDealCompanies] = useState<DealCompany[]>([]);

  // Property options (loaded from backend)
  const [statusOptions, setStatusOptions] = useState<Option[]>(
    FALLBACK_STATUS_OPTIONS
  );
  const [interestOptions, setInterestOptions] = useState<Option[]>(
    FALLBACK_INTEREST_OPTIONS
  );

  // Company search state
  const [companyQuery, setCompanyQuery] = useState("");
  const [companyOptions, setCompanyOptions] = useState<Option[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  // The label for the currently-selected company, kept alongside the id so the
  // Select can always render a name even after the search results (and thus
  // companyOptions) are cleared — otherwise the dropdown shows the raw id.
  const [selectedCompanyName, setSelectedCompanyName] = useState("");

  // Form fields with defaults
  const [selectedStatus, setSelectedStatus] = useState(DEFAULTS.REFERRAL_STATUS);
  const [selectedInterest, setSelectedInterest] = useState(
    DEFAULTS.CLIENT_INTEREST
  );
  const [note, setNote] = useState("");

  // Household History state
  const [householdData, setHouseholdData] = useState<HouseholdData | null>(null);
  const [householdLoading, setHouseholdLoading] = useState(false);
  const [householdExpanded, setHouseholdExpanded] = useState(false);

  // Copy-from state
  const [copiedFromDealKey, setCopiedFromDealKey] = useState<string | undefined>();
  const [copiedFromYear, setCopiedFromYear] = useState<string | undefined>();
  const [copySource, setCopySource] = useState<string | null>(null);

  // Confirmation dialog state for "Selected" interest
  const [pendingSelectedConfirm, setPendingSelectedConfirm] = useState(false);

  // ==========================================================================
  // Computed
  // ==========================================================================

  const dealHasCompany = dealCompanies.length > 0;

  const canCreate = useMemo(() => {
    return Boolean(
      dealId && selectedCompanyId && !busy && !submitInProgress.current && !locked
    );
  }, [dealId, selectedCompanyId, busy, locked]);

  const formStep = !selectedCompanyId ? 0 : canCreate ? 2 : 1;

  // Options for the company Select. Always include the currently-selected
  // company so the dropdown shows its name even after the search results have
  // been cleared (e.g. the rep emptied the search box) — without this the
  // Select falls back to displaying the raw company id.
  const companySelectOptions = useMemo<Option[]>(() => {
    if (
      selectedCompanyId &&
      !companyOptions.some((o) => o.value === selectedCompanyId)
    ) {
      return [
        { label: selectedCompanyName || selectedCompanyId, value: selectedCompanyId },
        ...companyOptions,
      ];
    }
    return companyOptions;
  }, [companyOptions, selectedCompanyId, selectedCompanyName]);

  // Item 8: the note from the most recently created referral, so the rep can
  // pull it into a new referral instead of retyping the same company note.
  // HubSpot object IDs are sequential, so the highest id is the newest.
  const mostRecentNote = useMemo(() => {
    if (referrals.length === 0) return "";
    const newest = [...referrals].sort((a, b) => Number(b.id) - Number(a.id))[0];
    return (newest?.note || "").trim();
  }, [referrals]);

  // ==========================================================================
  // API helpers
  // ==========================================================================

  const apiRequest = useCallback(
    async (
      path: string,
      init?: { method?: string; body?: any }
    ): Promise<any> => {
      const url = `${API_BASE}${path}`;
      // hubspot.fetch only allows the Authorization header. Don't set
      // Content-Type — HubSpot rejects with HTTP 400 before the call leaves
      // the iframe. Bodies must be strings; stringify objects defensively.
      const rawBody = init?.body;
      const body =
        rawBody === undefined || typeof rawBody === "string"
          ? rawBody
          : JSON.stringify(rawBody);
      const res = await hubspot.fetch(url, {
        method: init?.method || "GET",
        body,
      });

      let data: any = null;
      try {
        data = await res.json();
      } catch {
        // Ignore JSON parse errors
      }

      if (!res.ok) {
        let msg = `Request failed (${res.status})`;
        if (data?.error) {
          msg =
            typeof data.error === "string"
              ? data.error
              : JSON.stringify(data.error);
        } else if (data?.validationErrors && Array.isArray(data.validationErrors)) {
          msg = data.validationErrors.join("; ");
        } else if (data?.errors && Array.isArray(data.errors)) {
          msg = data.errors.map((e: any) => e.message || String(e)).join("; ");
        } else if (data?.message) {
          msg = data.message;
        }
        throw new Error(msg);
      }

      return data;
    },
    []
  );

  // ==========================================================================
  // Loaders
  // ==========================================================================

  // hubspot.fetch from the iframe can't authenticate to api.hubapi.com — it
  // stamps a JWT meant for our backend. Deal→Company associations are
  // resolved server-side and returned in details.associated_companies.
  const loadDealCompanies = useCallback(async () => {
    if (!dealId) return;
    const companies: DealCompany[] = (details?.associated_companies ?? []).map(
      (c) => ({
        id: c.id,
        name: c.name ?? undefined,
      })
    );
    setDealCompanies(companies);
    // Note: we intentionally do NOT auto-select the deal's existing company
    // into the Create Referral form. Doing so pre-filled the Select with a
    // company the rep hadn't searched for, and (because it was never added to
    // companyOptions) the dropdown rendered the raw company id. The Create form
    // starts empty; the rep searches and picks.
  }, [dealId, details]);

  const loadPropertyDefinitions = useCallback(async () => {
    try {
      const data = await apiRequest("/api/referrals/properties");
      const props = data?.properties || {};
      if (props.referral_status?.options?.length) {
        setStatusOptions(props.referral_status.options);
      }
      if (props.client_interest?.options?.length) {
        setInterestOptions(props.client_interest.options);
      }
    } catch {
      // Use fallbacks
    }
  }, [apiRequest]);

  const loadReferrals = useCallback(async () => {
    if (!dealId) return;
    const data = await apiRequest(`/api/deals/${dealId}/referrals`);
    setReferrals(data?.results || []);
  }, [dealId, apiRequest]);

  const searchCompanies = useCallback(async () => {
    if (!companyQuery.trim()) {
      setCompanyOptions([]);
      return;
    }
    const data = await apiRequest(
      `/api/companies/search?q=${encodeURIComponent(companyQuery.trim())}`
    );
    const opts: Option[] = (data?.results || []).map((c: any) => ({
      label: c.name || `Company ${c.id}`,
      value: String(c.id),
    }));
    setCompanyOptions(opts);
  }, [companyQuery, apiRequest]);

  const loadHouseholdReferrals = useCallback(async () => {
    if (!dealId) return;
    setHouseholdLoading(true);
    try {
      const data = await apiRequest(`/api/deals/${dealId}/household-referrals`);
      setHouseholdData(data || null);
    } catch (e: any) {
      console.error("Failed to load household referrals:", e.message);
    } finally {
      setHouseholdLoading(false);
    }
  }, [dealId, apiRequest]);

  // ==========================================================================
  // Form actions
  // ==========================================================================

  const handleCopyReferral = useCallback(
    (sourceReferral: HouseholdReferral, sourceDeal: HouseholdDeal) => {
      if (sourceReferral.company?.id) {
        const label =
          sourceReferral.company.name || `Company ${sourceReferral.company.id}`;
        setSelectedCompanyId(sourceReferral.company.id);
        setSelectedCompanyName(label);
        setCompanyOptions([{ label, value: sourceReferral.company.id }]);
        setCompanyQuery(sourceReferral.company.name || "");
      }
      if (sourceReferral.note) {
        setNote(sourceReferral.note);
      }
      setSelectedStatus(DEFAULTS.REFERRAL_STATUS);
      setSelectedInterest(DEFAULTS.CLIENT_INTEREST);
      setCopiedFromDealKey(sourceDeal.dealKey);
      setCopiedFromYear(sourceDeal.dealYear);
      setCopySource(`${sourceDeal.dealName} ${sourceDeal.dealYear}`);
    },
    []
  );

  const createReferral = useCallback(async () => {
    if (!dealId || !selectedCompanyId) {
      setError("Deal ID and Company are required");
      return;
    }
    if (submitInProgress.current) return;
    submitInProgress.current = true;
    setError(null);
    setSuccessMessage(null);

    try {
      const payload = {
        dealId,
        companyId: selectedCompanyId,
        note: note || undefined,
        outreachStatus: selectedStatus,
        clientInterest: selectedInterest,
        associateDealToCompany: false,
        copiedFromDealKey: copiedFromDealKey || undefined,
        copiedFromYear: copiedFromYear ? Number(copiedFromYear) : undefined,
      };
      const data = await apiRequest("/api/referrals", {
        method: "POST",
        body: payload,
      });
      const dealUpdatedSuffix = data?.dealUpdated
        ? ". The Session Selection view is now active for tuition entry."
        : "";
      const message = data?.created
        ? `Referral created${dealUpdatedSuffix}`
        : `Referral updated${dealUpdatedSuffix}`;

      setSuccessMessage(message);
      actions?.addAlert?.({ type: "success", message });

      setNote("");
      setSelectedCompanyId("");
      setSelectedCompanyName("");
      setCompanyQuery("");
      setCompanyOptions([]);
      setSelectedStatus(DEFAULTS.REFERRAL_STATUS);
      setSelectedInterest(DEFAULTS.CLIENT_INTEREST);
      setCopiedFromDealKey(undefined);
      setCopiedFromYear(undefined);
      setCopySource(null);

      await Promise.all([
        loadReferrals(),
        loadDealCompanies(),
        loadHouseholdReferrals(),
      ]);

      // The Selected transition advances the stage server-side; ask the
      // router to re-evaluate which view to render.
      if (data?.dealUpdated) onStageMaybeChanged();
    } catch (e: any) {
      setError(e?.message || "Failed to create referral");
    } finally {
      submitInProgress.current = false;
    }
  }, [
    dealId,
    selectedCompanyId,
    note,
    selectedStatus,
    selectedInterest,
    copiedFromDealKey,
    copiedFromYear,
    apiRequest,
    actions,
    loadReferrals,
    loadDealCompanies,
    loadHouseholdReferrals,
    onStageMaybeChanged,
  ]);

  const updateReferral = useCallback(
    async (referralId: string, properties: Record<string, string>) => {
      setError(null);
      const referral = referrals.find((r) => r.id === referralId);
      try {
        await apiRequest(`/api/referrals/${referralId}`, {
          method: "PATCH",
          body: {
            properties,
            context: {
              dealId,
              companyId: referral?.company?.id,
              previousClientInterest: referral?.clientInterest,
            },
          },
        });
        const isNowSelected = properties.client_interest === "Selected";
        const message = isNowSelected
          ? "Referral marked Selected. The Session Selection view is now active for tuition entry."
          : "Referral updated";
        actions?.addAlert?.({ type: "success", message });
        await Promise.all([loadReferrals(), loadDealCompanies()]);
        if (isNowSelected) onStageMaybeChanged();
      } catch (e: any) {
        setError(e?.message || "Failed to update referral");
      }
    },
    [
      apiRequest,
      actions,
      loadReferrals,
      loadDealCompanies,
      referrals,
      dealId,
      onStageMaybeChanged,
    ]
  );

  // ==========================================================================
  // Effects
  // ==========================================================================

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!dealId) return;
      setError(null);
      try {
        await Promise.all([
          loadReferrals(),
          loadPropertyDefinitions(),
          loadDealCompanies(),
          loadHouseholdReferrals(),
        ]);
      } catch (e: any) {
        if (mounted) setError(e?.message || "Failed to load data");
      }
    })();
    return () => {
      mounted = false;
    };
  }, [
    dealId,
    loadReferrals,
    loadPropertyDefinitions,
    loadDealCompanies,
    loadHouseholdReferrals,
  ]);

  useEffect(() => {
    if (successMessage) {
      const timer = setTimeout(() => setSuccessMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [successMessage]);

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (companyQuery.trim().length < 2) {
      setCompanyOptions([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchDebounceRef.current = setTimeout(async () => {
      try {
        await searchCompanies();
      } catch (e: any) {
        console.error("Auto-search failed:", e.message);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [companyQuery, searchCompanies]);

  // The memo is built from the camps the client is considering — i.e. this
  // deal's referrals (each referral is associated to a camp company). The deal
  // itself usually has no *direct* company associations, so `dealCompanies`
  // (from details.associated_companies) is empty and the memo showed
  // "No camps yet" despite the referrals. Derive the camp list from the
  // referrals, union any direct associations, and dedupe by company id.
  const memoCompanies = useMemo<DealCompany[]>(() => {
    const byId = new Map<string, DealCompany>();
    for (const r of referrals) {
      const id = r.company?.id;
      if (id && !byId.has(id)) {
        byId.set(id, { id, name: r.company?.name });
      }
    }
    for (const c of dealCompanies) {
      if (c.id && !byId.has(c.id)) byId.set(c.id, c);
    }
    return Array.from(byId.values());
  }, [referrals, dealCompanies]);

  // ==========================================================================
  // Render
  // ==========================================================================

  return (
    <Flex direction="column" gap="sm">
      <Heading level={3}>Referral Builder</Heading>

      <Flex direction="row" gap="sm" align="center" wrap="wrap">
        {dealHasCompany && (
          <Tag variant="success">
            {dealCompanies.map((c) => c.name || c.id).join(", ")}
          </Tag>
        )}
      </Flex>

      {error && (
        <Alert title="Error" variant="error">
          {error}
        </Alert>
      )}
      {successMessage && (
        <Alert title="Success" variant="success">
          {successMessage}
        </Alert>
      )}

      <Divider />

      <Alert title="Referral stages drive the deal pipeline" variant="info">
        Marking a referral "Selected" advances the deal to tuition entry. The
        Session Selection view will activate for that camp.
      </Alert>

      <Flex direction="row" gap="md" wrap="wrap">
        {/* LEFT: Create form */}
        <Box flex={1}>
          <Heading level={3}>Create Referral</Heading>

          <StepIndicator
            currentStep={formStep}
            stepNames={["Find Company", "Set Details", "Create"]}
          />

          {copySource && (
            <Alert title="Copying referral" variant="info">
              Pre-filled from: {copySource}. Review and click Create Referral.
            </Alert>
          )}

          <Flex direction="column" gap="sm">
            <Input
              name="companyQuery"
              label="Find a Company"
              value={companyQuery}
              onChange={(val: string) => setCompanyQuery(val)}
              placeholder="e.g. Camp Sunshine, Timber Lake..."
              description="Type at least 2 characters — results load automatically"
              readOnly={locked}
            />

            {searching && <LoadingSpinner label="Searching..." size="small" />}

            <Select
              name="company"
              label="Select Company"
              options={companySelectOptions}
              value={selectedCompanyId}
              onChange={(val: string) => {
                setSelectedCompanyId(val);
                // Remember the chosen company's label so the Select keeps
                // showing the name if the search results are later cleared.
                const picked = companyOptions.find((o) => o.value === val);
                setSelectedCompanyName(picked?.label ?? "");
                setError(null);
              }}
              required
              readOnly={locked}
              description={
                searching
                  ? "Searching..."
                  : companyOptions.length > 0
                  ? `${companyOptions.length} result${
                      companyOptions.length !== 1 ? "s" : ""
                    } found`
                  : "Search results will appear here"
              }
            />

            <Select
              name="status"
              label="Referral Status"
              options={statusOptions}
              value={selectedStatus}
              onChange={(val: string) => setSelectedStatus(val)}
              readOnly={locked}
            />

            <Select
              name="interest"
              label="Client Interest"
              options={interestOptions}
              value={selectedInterest}
              onChange={(val: string) => {
                setSelectedInterest(val);
                if (val !== "Selected") setPendingSelectedConfirm(false);
              }}
              readOnly={locked}
              description={getInterestPipelineNote(selectedInterest) || undefined}
            />

            <TextArea
              name="note"
              label="Note to Company"
              value={note}
              onChange={(val: string) => setNote(val)}
              rows={6}
              readOnly={locked}
              placeholder={
                "EXAMPLE: Lily is sweet, a little shy at first, warms up fast..."
              }
            />

            {/* Item 8: people reuse the same company note. Pull the note from
                the most recently created referral into this new (unsubmitted)
                referral so it doesn't have to be retyped. Local only — nothing
                is saved until Create Referral. */}
            {mostRecentNote && !locked && (
              <Button
                size="small"
                variant="secondary"
                disabled={busy}
                onClick={() => setNote(mostRecentNote)}
              >
                Copy note from last referral
              </Button>
            )}

            <Divider />

            {canCreate && !copySource && !pendingSelectedConfirm && (
              <Alert title="Ready to submit" variant="success">
                Review the details above, then click Create Referral.
              </Alert>
            )}

            {pendingSelectedConfirm && (
              <Alert title="Confirm selection" variant="warning">
                Marking this referral as "Selected" will advance the deal to
                the tuition entry stage. Continue?
              </Alert>
            )}

            {pendingSelectedConfirm ? (
              <Flex direction="row" gap="sm">
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={async () => {
                    setPendingSelectedConfirm(false);
                    setBusy(true);
                    try {
                      await createReferral();
                    } catch (e: any) {
                      setError(e?.message || "Create failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Creating..." : "Yes, mark Selected and advance deal"}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setPendingSelectedConfirm(false)}
                >
                  Cancel
                </Button>
              </Flex>
            ) : (
              <Button
                variant="primary"
                disabled={!canCreate}
                onClick={async () => {
                  if (selectedInterest === "Selected") {
                    setPendingSelectedConfirm(true);
                    return;
                  }
                  setBusy(true);
                  try {
                    await createReferral();
                  } catch (e: any) {
                    setError(e?.message || "Create failed");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy
                  ? "Creating..."
                  : !selectedCompanyId
                  ? "Select a company first"
                  : "Create Referral"}
              </Button>
            )}
          </Flex>
        </Box>

        {/* RIGHT: Existing referrals */}
        <Box flex={1}>
          <Flex direction="row" justify="space-between" align="center">
            <Heading level={3}>Existing Referrals ({referrals.length})</Heading>
            <Button
              size="small"
              variant="secondary"
              onClick={async () => {
                setError(null);
                setBusy(true);
                try {
                  await loadReferrals();
                } catch (e: any) {
                  setError(e?.message || "Refresh failed");
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy}
            >
              Refresh
            </Button>
          </Flex>

          {busy && <LoadingSpinner label="Loading..." size="small" />}

          {!busy && referrals.length === 0 && (
            <EmptyState title="No referrals yet" layout="vertical">
              <Text>Create your first referral using the form.</Text>
            </EmptyState>
          )}

          {!busy && referrals.length > 0 && (
            <Flex direction="column" gap="sm">
              {referrals.map((r) => (
                <ReferralCard
                  key={r.id}
                  referral={r}
                  statusOptions={statusOptions}
                  interestOptions={interestOptions}
                  onUpdate={updateReferral}
                  busy={busy}
                  locked={locked}
                />
              ))}
            </Flex>
          )}
        </Box>
      </Flex>

      <HouseholdHistoryPanel
        householdData={householdData}
        householdLoading={householdLoading}
        householdExpanded={householdExpanded}
        onToggleExpanded={() => setHouseholdExpanded(!householdExpanded)}
        onCopyReferral={handleCopyReferral}
      />

      <MemoBuilderSection
        dealId={dealId}
        companies={memoCompanies}
        locked={locked}
        actions={actions}
      />

      <Divider />
      <Flex direction="row" gap="sm">
        <Button variant="destructive" onClick={onMarkLost} disabled={locked}>
          Mark as Lost
        </Button>
      </Flex>
    </Flex>
  );
}

// ============================================================================
// Memo Builder — generate a client-facing camp recommendation Word doc
// ============================================================================

interface MemoBuilderSectionProps {
  dealId: string;
  companies: DealCompany[];
  locked: boolean;
  actions?: any;
}

interface MemoResult {
  fileUrl: string | null;
  fileName?: string;
  campsIncluded: string[];
  limitedInfoCamps: string[];
}

function MemoBuilderSection({
  dealId,
  companies,
  locked,
  actions,
}: MemoBuilderSectionProps) {
  // Default to including every associated camp; the rep unticks any to exclude.
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MemoResult | null>(null);

  // Memo generation is async — the backend composes with Claude (too slow for a
  // synchronous request through HubSpot's fetch gateway). We POST to start a
  // job, then poll for its result. pollRef holds the interval so we can stop it.
  const pollRef = useRef<any>(null);
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);
  useEffect(() => () => stopPolling(), [stopPolling]); // clear on unmount

  // Seed/refresh the selection map when the company list changes (default on).
  useEffect(() => {
    setSelected((prev) => {
      const next: Record<string, boolean> = {};
      for (const c of companies) {
        next[c.id] = c.id in prev ? prev[c.id] : true;
      }
      return next;
    });
  }, [companies]);

  const selectedIds = companies
    .map((c) => c.id)
    .filter((id) => selected[id]);

  // Poll a started job until it's done or errored. busy stays true throughout.
  const startPolling = useCallback(
    (jobId: string) => {
      const startedAt = Date.now();
      const TIMEOUT_MS = 5 * 60 * 1000;
      const tick = async () => {
        try {
          const resp = await hubspot.fetch(
            `${API_BASE}/api/v2/deal/${dealId}/generate-memo?jobId=${encodeURIComponent(
              jobId
            )}&_t=${Date.now()}`,
            { method: "GET" }
          );
          const data = await resp.json().catch(() => ({}));
          if (data?.status === "done") {
            stopPolling();
            setBusy(false);
            setResult({
              fileUrl: data.fileUrl ?? null,
              fileName: data.fileName,
              campsIncluded: data.campsIncluded ?? [],
              limitedInfoCamps: data.limitedInfoCamps ?? [],
            });
            actions?.addAlert?.({
              type: "success",
              message: "Memo generated and attached to the deal.",
            });
            return;
          }
          if (data?.status === "error") {
            stopPolling();
            setBusy(false);
            setError(data?.message || "Failed to generate the memo.");
            return;
          }
          // still pending — give up after the timeout window
          if (Date.now() - startedAt > TIMEOUT_MS) {
            stopPolling();
            setBusy(false);
            setError(
              "The memo is taking longer than expected — it may still finish. Check the deal's files in a minute, or try again."
            );
          }
        } catch (e: any) {
          // transient poll failure: keep trying until the timeout window
          if (Date.now() - startedAt > TIMEOUT_MS) {
            stopPolling();
            setBusy(false);
            setError("Lost connection while generating the memo. Please try again.");
          }
        }
      };
      stopPolling();
      void tick(); // immediate first check
      pollRef.current = setInterval(() => void tick(), 3000);
    },
    [dealId, actions, stopPolling]
  );

  const generate = useCallback(async () => {
    if (selectedIds.length === 0) {
      setError("Select at least one camp for the memo.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const resp = await hubspot.fetch(
        `${API_BASE}/api/v2/deal/${dealId}/generate-memo`,
        {
          method: "POST",
          body: JSON.stringify({
            companyIds: selectedIds,
            specialInstructions: instructions || undefined,
          }),
        }
      );
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data?.success && data?.jobId) {
        // Job started — poll for the result (keeps busy=true meanwhile).
        startPolling(data.jobId);
      } else {
        setBusy(false);
        setError(data?.message || "Failed to start memo generation.");
      }
    } catch (e: any) {
      setBusy(false);
      setError(e?.message || "Failed to start memo generation.");
    }
  }, [dealId, selectedIds, instructions, startPolling]);

  return (
    <Box>
      <Divider />
      <Heading level={3}>Generate Memo</Heading>
      <Text variant="microcopy">
        Build a client-ready Word document of camp recommendations from the
        camps below. It's composed by AI from each camp's write-up and our
        session data, then attached to this deal.
      </Text>

      {companies.length === 0 ? (
        <EmptyState title="No camps yet" layout="vertical">
          <Text>Add referrals first — the memo is built from this deal's camps.</Text>
        </EmptyState>
      ) : (
        <Flex direction="column" gap="sm">
          <Text format={{ fontWeight: "bold" }}>Camps to include</Text>
          {companies.map((c) => (
            <Checkbox
              key={c.id}
              name={`memo-${c.id}`}
              checked={Boolean(selected[c.id])}
              onChange={(val: boolean) =>
                setSelected((prev) => ({ ...prev, [c.id]: Boolean(val) }))
              }
              readOnly={locked || busy}
            >
              {c.name || c.id}
            </Checkbox>
          ))}

          <TextArea
            name="memo-instructions"
            label="Special instructions (optional)"
            value={instructions}
            onChange={(val: string) => setInstructions(val)}
            rows={4}
            readOnly={locked || busy}
            placeholder={
              "EXAMPLE: The Conway family. Sons Archie (rising 5th) and Luke (rising 3rd). Co-ed strongly preferred; Luke has had croup, so call out medical setups. Keep it warm and concise."
            }
          />

          {error && (
            <Alert title="Error" variant="error">
              {error}
            </Alert>
          )}

          {result && (
            <Alert title="Memo ready" variant="success">
              <Flex direction="column" gap="sm">
                <Text>
                  Generated for {result.campsIncluded.length} camp
                  {result.campsIncluded.length === 1 ? "" : "s"} and attached to
                  this deal.
                </Text>
                {result.fileUrl && (
                  <Link href={result.fileUrl} external>
                    Download the memo (.docx)
                  </Link>
                )}
                {result.limitedInfoCamps.length > 0 && (
                  <Text variant="microcopy">
                    Limited info (no write-up on file) — review before sending:{" "}
                    {result.limitedInfoCamps.join(", ")}.
                  </Text>
                )}
              </Flex>
            </Alert>
          )}

          {busy && (
            <LoadingSpinner
              label="Generating memo… this can take up to a minute."
              size="small"
            />
          )}

          <Flex direction="row" gap="sm">
            <Button
              variant="primary"
              disabled={locked || busy || selectedIds.length === 0}
              onClick={generate}
            >
              {busy ? "Generating…" : "Generate Memo"}
            </Button>
          </Flex>
        </Flex>
      )}
    </Box>
  );
}

// ============================================================================
// Household History Panel
// ============================================================================

interface HouseholdHistoryPanelProps {
  householdData: HouseholdData | null;
  householdLoading: boolean;
  householdExpanded: boolean;
  onToggleExpanded: () => void;
  onCopyReferral: (referral: HouseholdReferral, deal: HouseholdDeal) => void;
}

function HouseholdHistoryPanel({
  householdData,
  householdLoading,
  householdExpanded,
  onToggleExpanded,
  onCopyReferral,
}: HouseholdHistoryPanelProps) {
  if (!householdData || householdData.householdDeals.length === 0) {
    if (householdLoading) {
      return (
        <Box>
          <Divider />
          <LoadingSpinner label="Loading household history..." size="small" />
        </Box>
      );
    }
    return null;
  }

  const totalReferrals = householdData.householdDeals.reduce(
    (sum, d) => sum + d.referrals.length,
    0
  );

  return (
    <Box>
      <Divider />
      <Flex direction="row" justify="space-between" align="center">
        <Heading level={3}>
          Household History ({totalReferrals} referral
          {totalReferrals !== 1 ? "s" : ""} from{" "}
          {householdData.householdDeals.length} other deal
          {householdData.householdDeals.length !== 1 ? "s" : ""})
        </Heading>
        <Button size="small" variant="secondary" onClick={onToggleExpanded}>
          {householdExpanded ? "Collapse" : "Expand"}
        </Button>
      </Flex>

      {householdExpanded && (
        <Flex direction="column" gap="md">
          {householdData.householdDeals.map((deal) => (
            <Box key={deal.dealId}>
              <Flex direction="row" gap="sm" align="center" wrap="wrap">
                <Text format={{ fontWeight: "bold" }}>
                  {deal.dealName || `Deal ${deal.dealId}`}
                  {deal.dealYear ? ` — ${deal.dealYear}` : ""}
                </Text>
                <Tag variant={deal.isSameChild ? "default" : "warning"}>
                  {deal.isSameChild ? "Same Child" : "Sibling"}
                </Tag>
              </Flex>

              {deal.referrals.length === 0 ? (
                <Text variant="microcopy">No referrals on this deal</Text>
              ) : (
                <Flex direction="column" gap="sm">
                  {deal.referrals.map((ref) => (
                    <Flex
                      key={ref.id}
                      direction="row"
                      justify="space-between"
                      align="center"
                    >
                      <Flex direction="column" gap="flush">
                        <Text>{ref.company?.name || "Unknown Company"}</Text>
                        <Text variant="microcopy">
                          {ref.outreachStatus || "No status"}
                          {ref.clientInterest ? ` · ${ref.clientInterest}` : ""}
                        </Text>
                      </Flex>
                      <Button
                        size="small"
                        variant="secondary"
                        onClick={() => onCopyReferral(ref, deal)}
                      >
                        Copy to This Deal
                      </Button>
                    </Flex>
                  ))}
                </Flex>
              )}
              <Divider />
            </Box>
          ))}
        </Flex>
      )}
    </Box>
  );
}

// ============================================================================
// Referral Card
// ============================================================================

interface ReferralCardProps {
  referral: ReferralRow;
  statusOptions: Option[];
  interestOptions: Option[];
  onUpdate: (id: string, properties: Record<string, string>) => Promise<void>;
  busy: boolean;
  locked: boolean;
}

function ReferralCard({
  referral,
  statusOptions,
  interestOptions,
  onUpdate,
  busy,
  locked,
}: ReferralCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [localStatus, setLocalStatus] = useState(referral.outreachStatus || "");
  const [localInterest, setLocalInterest] = useState(
    referral.clientInterest || ""
  );
  const [localNote, setLocalNote] = useState(referral.note || "");
  const [saving, setSaving] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const [selecting, setSelecting] = useState(false);

  const alreadySelected = referral.clientInterest === "Selected";

  // Item 5: one-click "CREATE SIGN UP" — marks the referral Selected and
  // advances the deal in a single click. Same backend as the
  // Edit → Interest → Selected → confirm flow, just no dropdown, no confirm
  // reload, and no referral-first dependency.
  const handleSelectProgram = async () => {
    setSelecting(true);
    try {
      await onUpdate(referral.id, { client_interest: "Selected" });
    } finally {
      setSelecting(false);
    }
  };

  const hasChanges =
    localStatus !== (referral.outreachStatus || "") ||
    localInterest !== (referral.clientInterest || "") ||
    localNote !== (referral.note || "");

  const isChangingToSelected =
    localInterest === "Selected" && referral.clientInterest !== "Selected";
  const isChangingFromSelected =
    localInterest !== "Selected" && referral.clientInterest === "Selected";

  const handleSave = async () => {
    if (isChangingToSelected && !pendingConfirm) {
      setPendingConfirm(true);
      return;
    }
    setSaving(true);
    setPendingConfirm(false);
    try {
      await onUpdate(referral.id, {
        referral_status: localStatus,
        client_interest: localInterest,
        referral_note_to_company: localNote,
      });
      setExpanded(false);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setLocalStatus(referral.outreachStatus || "");
    setLocalInterest(referral.clientInterest || "");
    setLocalNote(referral.note || "");
    setExpanded(false);
    setPendingConfirm(false);
  };

  const notePreview =
    referral.note && referral.note.length > 90
      ? referral.note.substring(0, 90) + "..."
      : referral.note;

  return (
    <Box>
      <Flex direction="column" gap="sm">
        <Flex direction="row" justify="space-between" align="center">
          <Text format={{ fontWeight: "bold" }}>
            {referral.company?.name || "Unknown Company"}
          </Text>
          <Flex direction="row" gap="sm" align="center">
            {!alreadySelected && (
              <Button
                size="small"
                variant="primary"
                disabled={locked || busy || selecting}
                onClick={handleSelectProgram}
              >
                {selecting ? "Creating…" : "CREATE SIGN UP"}
              </Button>
            )}
            <Button
              size="small"
              variant="secondary"
              disabled={locked}
              onClick={() => (expanded ? handleCancel() : setExpanded(true))}
            >
              {expanded ? "Cancel" : "Edit"}
            </Button>
          </Flex>
        </Flex>

        <Flex direction="row" gap="sm" align="center" wrap="wrap">
          {referral.outreachStatus && (
            <Tag variant={getStatusTagVariant(referral.outreachStatus)}>
              {referral.outreachStatus}
            </Tag>
          )}
          {referral.clientInterest && (
            <Tag variant={getInterestTagVariant(referral.clientInterest)}>
              {referral.clientInterest}
            </Tag>
          )}
        </Flex>

        {!expanded && notePreview && (
          <Text variant="microcopy">{notePreview}</Text>
        )}

        {expanded && (
          <Flex direction="column" gap="sm">
            <Select
              name={`status-${referral.id}`}
              label="Status"
              options={statusOptions}
              value={localStatus}
              onChange={(val: string) => setLocalStatus(val)}
              readOnly={locked}
            />

            <Select
              name={`interest-${referral.id}`}
              label="Interest"
              options={interestOptions}
              value={localInterest}
              onChange={(val: string) => {
                setLocalInterest(val);
                setPendingConfirm(false);
              }}
              readOnly={locked}
              description={getInterestPipelineNote(localInterest) || undefined}
            />

            {pendingConfirm && isChangingToSelected && (
              <Alert title="Confirm selection" variant="warning">
                Marking this referral "Selected" will advance the deal to
                tuition entry. Continue?
              </Alert>
            )}

            {isChangingFromSelected && (
              <Alert title="De-selecting referral" variant="warning">
                Changing from "Selected" may reset the deal stage. If tuition
                has already been entered, this change will be blocked.
              </Alert>
            )}

            <TextArea
              name={`note-${referral.id}`}
              label="Note"
              value={localNote}
              onChange={(val: string) => setLocalNote(val)}
              rows={6}
              readOnly={locked}
            />

            {pendingConfirm ? (
              <Flex direction="row" gap="sm">
                <Button
                  size="small"
                  variant="primary"
                  disabled={busy || saving}
                  onClick={handleSave}
                >
                  {saving ? "Saving..." : "Yes, mark Selected and advance deal"}
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() => setPendingConfirm(false)}
                >
                  Cancel
                </Button>
              </Flex>
            ) : (
              <Button
                size="small"
                variant="primary"
                disabled={busy || saving || !hasChanges || locked}
                onClick={handleSave}
              >
                {saving ? "Saving..." : "Save Changes"}
              </Button>
            )}
          </Flex>
        )}
      </Flex>
      <Divider />
    </Box>
  );
}
