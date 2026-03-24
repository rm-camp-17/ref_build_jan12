/**
 * Referral Builder Card - HubSpot UI Extension
 *
 * Creates and manages referrals for deals.
 * Supports both sidebar (crm.record.sidebar) and tab (crm.record.tab) placements.
 *
 * HubSpot Platform Version: 2025.02
 */

import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  hubspot,
  Box,
  Button,
  Divider,
  Flex,
  Heading,
  Input,
  Select,
  Text,
  TextArea,
  EmptyState,
  LoadingSpinner,
  Alert,
  Tag,
  StepIndicator,
} from "@hubspot/ui-extensions";

// ============================================================================
// Configuration
// ============================================================================

// API Base URL - Update this to your deployed Vercel API
const API_BASE = "https://referral-builder1122026.vercel.app";

// Default enum values (must match backend defaults)
// NOTE: HubSpot properties use labels as values (non-standard but configured this way)
const DEFAULTS = {
  REFERRAL_STATUS: "Ready to Send",
  CLIENT_INTEREST: "Active / considering",
} as const;

// Fallback options if API fails to load property definitions
// NOTE: HubSpot uses labels as internal values for this installation
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
// Tag Variant Helpers
// ============================================================================

function getStatusTagVariant(status: string): "default" | "success" | "warning" {
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

function getInterestTagVariant(interest: string): "default" | "success" | "warning" {
  switch (interest) {
    case "Selected":
    case "Shortlist":
      return "success";
    case "Unlikely":
    case "Declined":
      return "warning";
    default:
      return "default";
  }
}

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

// ============================================================================
// Main Component
// ============================================================================

hubspot.extend(({ context, actions }) => (
  <ReferralBuilderCard context={context} actions={actions} />
));

function ReferralBuilderCard({ context, actions }: any) {
  const dealId = context?.crm?.objectId ? String(context.crm.objectId) : null;

  // =========================================================================
  // State
  // =========================================================================

  // Loading and error states
  const [initialLoading, setInitialLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Double-submit prevention
  const submitInProgress = useRef(false);

  // Debounce timer for company search
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searching, setSearching] = useState(false);

  // Data states
  const [referrals, setReferrals] = useState<ReferralRow[]>([]);
  const [dealCompanies, setDealCompanies] = useState<DealCompany[]>([]);

  // Property options (loaded from backend)
  const [statusOptions, setStatusOptions] = useState<Option[]>(FALLBACK_STATUS_OPTIONS);
  const [interestOptions, setInterestOptions] = useState<Option[]>(FALLBACK_INTEREST_OPTIONS);

  // Company search state
  const [companyQuery, setCompanyQuery] = useState("");
  const [companyOptions, setCompanyOptions] = useState<Option[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");

  // Form fields with defaults
  const [selectedStatus, setSelectedStatus] = useState(DEFAULTS.REFERRAL_STATUS);
  const [selectedInterest, setSelectedInterest] = useState(DEFAULTS.CLIENT_INTEREST);
  const [note, setNote] = useState("");


  // Household History state
  const [householdData, setHouseholdData] = useState<HouseholdData | null>(null);
  const [householdLoading, setHouseholdLoading] = useState(false);
  const [householdExpanded, setHouseholdExpanded] = useState(false);

  // Copy-from state (tracks when user clicks "Copy to This Deal")
  const [copiedFromDealKey, setCopiedFromDealKey] = useState<string | undefined>();
  const [copiedFromYear, setCopiedFromYear] = useState<string | undefined>();
  const [copySource, setCopySource] = useState<string | null>(null);

  // =========================================================================
  // Computed values
  // =========================================================================

  const dealHasCompany = dealCompanies.length > 0;

  const canCreate = useMemo(() => {
    return Boolean(dealId && selectedCompanyId && !busy && !submitInProgress.current);
  }, [dealId, selectedCompanyId, busy]);

  // Step indicator: 0 = Find Company, 1 = Set Details, 2 = Ready to Create
  const formStep = !selectedCompanyId ? 0 : canCreate ? 2 : 1;

  // =========================================================================
  // API Helpers
  // =========================================================================

  /**
   * Make API request to backend with error handling
   */
  const apiRequest = useCallback(async (
    path: string,
    init?: { method?: string; body?: any }
  ): Promise<any> => {
    const url = `${API_BASE}${path}`;

    // Note: HubSpot's fetch() handles JSON serialization internally
    // Pass the body as an object, not a JSON string
    const res = await hubspot.fetch(url, {
      method: init?.method || "GET",
      body: init?.body || undefined,
    });

    let data: any = null;
    try {
      data = await res.json();
    } catch (e) {
      // Ignore JSON parse errors
    }

    if (!res.ok) {
      // Extract error message
      let msg = `Request failed (${res.status})`;

      if (data?.error) {
        msg = typeof data.error === "string" ? data.error : JSON.stringify(data.error);
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
  }, []);

  /**
   * HubSpot CRM API helper (for fetching deal associations)
   */
  const hubspotCrmRequest = useCallback(async (path: string): Promise<any> => {
    const url = `https://api.hubapi.com${path}`;
    const res = await hubspot.fetch(url);

    if (!res.ok) {
      let errorMsg = `HubSpot API error (${res.status})`;
      try {
        const errorData = await res.json();
        errorMsg = errorData?.message || errorMsg;
      } catch (e) {
        // Ignore
      }
      throw new Error(errorMsg);
    }

    return res.json();
  }, []);

  // =========================================================================
  // Data Loading Functions
  // =========================================================================

  /**
   * Load deal's associated companies
   */
  const loadDealCompanies = useCallback(async () => {
    if (!dealId) return;

    try {
      const data = await hubspotCrmRequest(
        `/crm/v4/objects/deals/${dealId}?associations=companies`
      );

      const companies: DealCompany[] = [];

      if (data?.associations?.companies?.results) {
        for (const assoc of data.associations.companies.results) {
          try {
            const companyData = await hubspotCrmRequest(
              `/crm/v3/objects/companies/${assoc.toObjectId}?properties=name`
            );
            companies.push({
              id: assoc.toObjectId,
              name: companyData?.properties?.name || `Company ${assoc.toObjectId}`,
            });
          } catch (e) {
            console.error(`Failed to load company ${assoc.toObjectId}`);
            companies.push({ id: assoc.toObjectId });
          }
        }
      }

      setDealCompanies(companies);

      // Pre-select company if exactly one and no selection yet
      if (companies.length === 1 && !selectedCompanyId) {
        setSelectedCompanyId(companies[0].id);
      }
    } catch (e: any) {
      console.error("Failed to load deal companies:", e.message);
    }
  }, [dealId, selectedCompanyId, hubspotCrmRequest]);

  /**
   * Load property definitions (enum options)
   */
  const loadPropertyDefinitions = useCallback(async () => {
    try {
      const data = await apiRequest("/api/referrals/properties");
      const props = data?.properties || {};

      if (props.referral_status?.options?.length) {
        console.log("[Frontend] Received status options:", props.referral_status.options.slice(0, 2));
        setStatusOptions(props.referral_status.options);
      }
      if (props.client_interest?.options?.length) {
        console.log("[Frontend] Received interest options:", props.client_interest.options.slice(0, 2));
        setInterestOptions(props.client_interest.options);
      }
    } catch (e) {
      console.error("Failed to load property definitions, using fallbacks");
    }
  }, [apiRequest]);

  /**
   * Load existing referrals for this deal
   */
  const loadReferrals = useCallback(async () => {
    if (!dealId) return;
    const data = await apiRequest(`/api/deals/${dealId}/referrals`);
    setReferrals(data?.results || []);
  }, [dealId, apiRequest]);

  /**
   * Search companies by name
   */
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

  /**
   * Load household referrals (all referrals across sibling deals)
   */
  const loadHouseholdReferrals = useCallback(async () => {
    if (!dealId) return;
    setHouseholdLoading(true);
    try {
      const data = await apiRequest(`/api/deals/${dealId}/household-referrals`);
      setHouseholdData(data || null);
    } catch (e: any) {
      console.error("Failed to load household referrals:", e.message);
      // Non-critical — don't set global error
    } finally {
      setHouseholdLoading(false);
    }
  }, [dealId, apiRequest]);

  // =========================================================================
  // Form Actions
  // =========================================================================

  /**
   * Handle "Copy to This Deal" — pre-fills the create form from a household referral
   */
  const handleCopyReferral = useCallback((
    sourceReferral: HouseholdReferral,
    sourceDeal: HouseholdDeal
  ) => {
    if (sourceReferral.company?.id) {
      setSelectedCompanyId(sourceReferral.company.id);
      setCompanyOptions([{
        label: sourceReferral.company.name || `Company ${sourceReferral.company.id}`,
        value: sourceReferral.company.id,
      }]);
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
  }, []);

  /**
   * Create referral (with double-submit prevention)
   */
  const createReferral = useCallback(async () => {
    if (!dealId || !selectedCompanyId) {
      setError("Deal ID and Company are required");
      return;
    }

    // Double-submit prevention
    if (submitInProgress.current) {
      console.log("Submit already in progress, ignoring");
      return;
    }
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

      console.log("[Frontend] Creating referral with payload:", payload);

      const data = await apiRequest("/api/referrals", {
        method: "POST",
        body: payload,
      });

      const message = data?.created
        ? `Referral created (ID: ${data?.referralId})`
        : `Referral updated (ID: ${data?.referralId})`;

      setSuccessMessage(message);
      actions?.addAlert?.({ type: "success", message });

      // Clear form
      setNote("");
      setSelectedCompanyId("");
      setCompanyQuery("");
      setCompanyOptions([]);
      setSelectedStatus(DEFAULTS.REFERRAL_STATUS);
      setSelectedInterest(DEFAULTS.CLIENT_INTEREST);
      setCopiedFromDealKey(undefined);
      setCopiedFromYear(undefined);
      setCopySource(null);

      // Refresh data
      await Promise.all([loadReferrals(), loadDealCompanies(), loadHouseholdReferrals()]);
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
  ]);

  /**
   * Update existing referral
   */
  const updateReferral = useCallback(async (
    referralId: string,
    properties: Record<string, string>
  ) => {
    setError(null);

    try {
      await apiRequest(`/api/referrals/${referralId}`, {
        method: "PATCH",
        body: { properties },
      });

      actions?.addAlert?.({ type: "success", message: "Referral updated" });
      await loadReferrals();
    } catch (e: any) {
      setError(e?.message || "Failed to update referral");
    }
  }, [apiRequest, actions, loadReferrals]);

  // =========================================================================
  // Effects
  // =========================================================================

  // Initial data load
  useEffect(() => {
    let mounted = true;

    (async () => {
      if (!dealId) return;

      setError(null);
      setInitialLoading(true);

      try {
        await Promise.all([
          loadReferrals(),
          loadPropertyDefinitions(),
          loadDealCompanies(),
          loadHouseholdReferrals(),
        ]);
      } catch (e: any) {
        if (mounted) {
          setError(e?.message || "Failed to load data");
        }
      } finally {
        if (mounted) {
          setInitialLoading(false);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [dealId, loadReferrals, loadPropertyDefinitions, loadDealCompanies, loadHouseholdReferrals]);

  // Clear success message after delay
  useEffect(() => {
    if (successMessage) {
      const timer = setTimeout(() => setSuccessMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [successMessage]);

  // Debounced auto-search when user types in company field
  useEffect(() => {
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }

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
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
      }
    };
  }, [companyQuery, searchCompanies]);

  // =========================================================================
  // Render: Loading and Error States
  // =========================================================================

  if (!dealId) {
    return (
      <Box>
        <Alert title="Invalid Context" variant="error">
          This card is meant to run on a Deal record.
        </Alert>
      </Box>
    );
  }

  if (initialLoading) {
    return (
      <Flex direction="column" align="center" justify="center" gap="md">
        <LoadingSpinner label="Loading Referral Builder..." />
      </Flex>
    );
  }

  // =========================================================================
  // Render: Main UI
  // =========================================================================

  return (
    <Flex direction="column" gap="sm">
      <Heading>Referral Builder</Heading>

      {/* Deal Info */}
      <Flex direction="row" gap="sm" align="center" wrap="wrap">
        {dealHasCompany && (
          <Tag variant="success">
            {dealCompanies.map((c) => c.name || c.id).join(", ")}
          </Tag>
        )}
      </Flex>

      {/* Error/Success Messages */}
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

      {/* Two-Column Layout */}
      <Flex direction="row" gap="md" wrap="wrap">
        {/* LEFT: Create Form */}
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
            {/* Step 1: Find Company */}
            <Input
              name="companyQuery"
              label="Find a Company"
              value={companyQuery}
              onChange={(val: string) => setCompanyQuery(val)}
              placeholder="e.g. Camp Sunshine, Timber Lake..."
              description="Type at least 2 characters — results load automatically"
            />

            {searching && <LoadingSpinner label="Searching..." size="small" />}

            <Select
              name="company"
              label="Select Company"
              options={companyOptions}
              value={selectedCompanyId}
              onChange={(val: string) => {
                setSelectedCompanyId(val);
                setError(null);
              }}
              required
              description={
                searching
                  ? "Searching..."
                  : companyOptions.length > 0
                  ? `${companyOptions.length} result${companyOptions.length !== 1 ? "s" : ""} found`
                  : "Search results will appear here"
              }
            />

            {/* Step 2: Set Details */}
            <Select
              name="status"
              label="Referral Status"
              options={statusOptions}
              value={selectedStatus}
              onChange={(val: string) => setSelectedStatus(val)}
            />

            <Select
              name="interest"
              label="Client Interest"
              options={interestOptions}
              value={selectedInterest}
              onChange={(val: string) => setSelectedInterest(val)}
            />

            <TextArea
              name="note"
              label="Note to Company"
              value={note}
              onChange={(val: string) => setNote(val)}
              rows={6}
              placeholder={"EXAMPLE: Lily is sweet, a little shy at first, warms up fast. Plays piano, loves to read, has done a couple school plays and wants more of that. Not sporty but curious and open to trying new things. Had a rough patch socially last year at a new school so looking for a warm cabin environment.\n\nMom Karen has a clear picture of what she wants: arts-forward, traditional, a place where a kid who reads during free period isn't out of place. Her own camp experience wasn't great and that's clearly still in the back of her mind. She needs to feel like the camp will embrace her kid and proactively communicate. Dad is supportive but did not attend camp.\n\nConnecticut family, four weeks minimum, flexible on budget. Younger brother is 6 and will likely join in a few years."}
            />

            {/* Step 3: Create */}
            <Divider />

            {canCreate && !copySource && (
              <Alert title="Ready to submit" variant="success">
                Review the details above, then click Create Referral.
              </Alert>
            )}

            <Button
              variant="primary"
              disabled={!canCreate}
              onClick={async () => {
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
              {busy ? "Creating..." : !selectedCompanyId ? "Select a company first" : "Create Referral"}
            </Button>
          </Flex>
        </Box>

        {/* RIGHT: Existing Referrals */}
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
            <EmptyState
              title="No referrals yet"
              layout="vertical"
            >
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
                />
              ))}
            </Flex>
          )}
        </Box>
      </Flex>

      {/* Household History Panel */}
      <HouseholdHistoryPanel
        householdData={householdData}
        householdLoading={householdLoading}
        householdExpanded={householdExpanded}
        onToggleExpanded={() => setHouseholdExpanded(!householdExpanded)}
        onCopyReferral={handleCopyReferral}
      />
    </Flex>
  );
}

// ============================================================================
// Household History Panel Sub-Component
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
          Household History ({totalReferrals} referral{totalReferrals !== 1 ? "s" : ""} from{" "}
          {householdData.householdDeals.length} other deal{householdData.householdDeals.length !== 1 ? "s" : ""})
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
                    <Flex key={ref.id} direction="row" justify="space-between" align="center">
                      <Flex direction="column" gap="flush">
                        <Text>{ref.company?.name || "Unknown Company"}</Text>
                        <Text variant="microcopy">
                          {ref.outreachStatus || "No status"}
                          {ref.clientInterest ? ` · ${ref.clientInterest}` : ""}
                          {ref.createdAt
                            ? ` · Sent ${new Date(ref.createdAt).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York', timeZoneName: 'short' })}`
                            : ""}
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
// Referral Card Sub-Component
// ============================================================================

interface ReferralCardProps {
  referral: ReferralRow;
  statusOptions: Option[];
  interestOptions: Option[];
  onUpdate: (id: string, properties: Record<string, string>) => Promise<void>;
  busy: boolean;
}

function ReferralCard({
  referral,
  statusOptions,
  interestOptions,
  onUpdate,
  busy,
}: ReferralCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [localStatus, setLocalStatus] = useState(referral.outreachStatus || "");
  const [localInterest, setLocalInterest] = useState(referral.clientInterest || "");
  const [localNote, setLocalNote] = useState(referral.note || "");
  const [saving, setSaving] = useState(false);

  const hasChanges =
    localStatus !== (referral.outreachStatus || "") ||
    localInterest !== (referral.clientInterest || "") ||
    localNote !== (referral.note || "");

  const handleSave = async () => {
    setSaving(true);
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
  };

  const notePreview =
    referral.note && referral.note.length > 90
      ? referral.note.substring(0, 90) + "..."
      : referral.note;

  return (
    <Box>
      <Flex direction="column" gap="sm">
        {/* Header: Company name + Edit toggle */}
        <Flex direction="row" justify="space-between" align="center">
          <Text format={{ fontWeight: "bold" }}>
            {referral.company?.name || "Unknown Company"}
          </Text>
          <Button
            size="small"
            variant="secondary"
            onClick={() => (expanded ? handleCancel() : setExpanded(true))}
          >
            {expanded ? "Cancel" : "Edit"}
          </Button>
        </Flex>

        {/* Status + Interest tags + Sent date */}
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

        {referral.createdAt && (
          <Text variant="microcopy">
            Sent: {new Date(referral.createdAt).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York', timeZoneName: 'short' })}
          </Text>
        )}

        {/* Compact: note preview */}
        {!expanded && notePreview && (
          <Text variant="microcopy">{notePreview}</Text>
        )}

        {/* Expanded: edit form */}
        {expanded && (
          <Flex direction="column" gap="sm">
            <Select
              name={`status-${referral.id}`}
              label="Status"
              options={statusOptions}
              value={localStatus}
              onChange={(val: string) => setLocalStatus(val)}
            />

            <Select
              name={`interest-${referral.id}`}
              label="Interest"
              options={interestOptions}
              value={localInterest}
              onChange={(val: string) => setLocalInterest(val)}
            />

            <TextArea
              name={`note-${referral.id}`}
              label="Note"
              value={localNote}
              onChange={(val: string) => setLocalNote(val)}
              rows={6}
            />

            <Button
              size="small"
              variant="primary"
              disabled={busy || saving || !hasChanges}
              onClick={handleSave}
            >
              {saving ? "Saving..." : "Save Changes"}
            </Button>
          </Flex>
        )}
      </Flex>
      <Divider />
    </Box>
  );
}
