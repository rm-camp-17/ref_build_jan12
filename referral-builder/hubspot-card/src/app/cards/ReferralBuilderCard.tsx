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
  Checkbox,
  EmptyState,
  LoadingSpinner,
  Alert,
  Tag,
} from "@hubspot/ui-extensions";

// ============================================================================
// Configuration
// ============================================================================

// API Base URL - Update this to your deployed Vercel API
const API_BASE = "https://referral-builder1122026.vercel.app";

// Default enum values (must match backend defaults)
const DEFAULTS = {
  REFERRAL_STATUS: "ready_to_send",
  CLIENT_INTEREST: "active_considering",
} as const;

// Fallback options if API fails to load property definitions
const FALLBACK_STATUS_OPTIONS: Option[] = [
  { label: "Draft", value: "draft" },
  { label: "Ready to Send", value: "ready_to_send" },
  { label: "Sent", value: "sent" },
  { label: "Resend", value: "resend" },
  { label: "Don't send (already sent)", value: "dont_send" },
];

const FALLBACK_INTEREST_OPTIONS: Option[] = [
  { label: "Active / considering", value: "active_considering" },
  { label: "Shortlist", value: "shortlist" },
  { label: "Neutral", value: "neutral" },
  { label: "Unlikely", value: "unlikely" },
  { label: "Declined", value: "declined" },
  { label: "Selected", value: "selected" },
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
  program?: { id?: string; name?: string } | null;
  session?: {
    id?: string;
    name?: string;
    startDate?: string;
    endDate?: string;
    price?: string;
  } | null;
}

interface DealCompany {
  id: string;
  name?: string;
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

  // Program/Session state
  const [programOptions, setProgramOptions] = useState<Option[]>([]);
  const [selectedProgramId, setSelectedProgramId] = useState("");
  const [sessionOptions, setSessionOptions] = useState<Option[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");

  // Form fields with defaults
  const [selectedStatus, setSelectedStatus] = useState(DEFAULTS.REFERRAL_STATUS);
  const [selectedInterest, setSelectedInterest] = useState(DEFAULTS.CLIENT_INTEREST);
  const [note, setNote] = useState("");

  // Association checkbox
  const [associateToDeal, setAssociateToDeal] = useState(true);

  // =========================================================================
  // Computed values
  // =========================================================================

  const dealHasCompany = dealCompanies.length > 0;
  const showAssociateCheckbox = !dealHasCompany && !!selectedCompanyId;

  const canCreate = useMemo(() => {
    return Boolean(dealId && selectedCompanyId && !busy && !submitInProgress.current);
  }, [dealId, selectedCompanyId, busy]);

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
        // Load programs for pre-selected company
        const programData = await apiRequest(`/api/companies/${companies[0].id}/programs`);
        const opts: Option[] = (programData?.results || []).map((p: any) => ({
          label: p.name || `Program ${p.id}`,
          value: String(p.id),
        }));
        setProgramOptions(opts);
      }
    } catch (e: any) {
      console.error("Failed to load deal companies:", e.message);
    }
  }, [dealId, selectedCompanyId, hubspotCrmRequest, apiRequest]);

  /**
   * Load property definitions (enum options)
   */
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
   * Load programs for selected company
   */
  const loadPrograms = useCallback(async (companyId: string) => {
    setProgramOptions([]);
    setSelectedProgramId("");
    setSessionOptions([]);
    setSelectedSessionId("");

    if (!companyId) return;

    const data = await apiRequest(`/api/companies/${companyId}/programs`);
    const opts: Option[] = (data?.results || []).map((p: any) => ({
      label: p.name || `Program ${p.id}`,
      value: String(p.id),
    }));

    setProgramOptions(opts);
  }, [apiRequest]);

  /**
   * Load sessions for selected program
   */
  const loadSessions = useCallback(async (programId: string) => {
    setSessionOptions([]);
    setSelectedSessionId("");

    if (!programId) return;

    const data = await apiRequest(`/api/programs/${programId}/sessions`);
    const opts: Option[] = (data?.results || []).map((s: any) => {
      const parts = [s.name || `Session ${s.id}`];
      if (s.startDate) parts.push(`(${s.startDate})`);
      if (s.price) parts.push(`$${s.price}`);
      return { label: parts.join(" "), value: String(s.id) };
    });

    setSessionOptions(opts);
  }, [apiRequest]);

  // =========================================================================
  // Form Actions
  // =========================================================================

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
        programId: selectedProgramId || undefined,
        sessionId: selectedSessionId || undefined,
        note: note || undefined,
        outreachStatus: selectedStatus,
        clientInterest: selectedInterest,
        associateDealToCompany: showAssociateCheckbox && associateToDeal,
      };

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
      setSelectedProgramId("");
      setSelectedSessionId("");
      setCompanyQuery("");
      setCompanyOptions([]);
      setProgramOptions([]);
      setSessionOptions([]);
      setSelectedStatus(DEFAULTS.REFERRAL_STATUS);
      setSelectedInterest(DEFAULTS.CLIENT_INTEREST);

      // Refresh data
      await Promise.all([loadReferrals(), loadDealCompanies()]);
    } catch (e: any) {
      setError(e?.message || "Failed to create referral");
    } finally {
      submitInProgress.current = false;
    }
  }, [
    dealId,
    selectedCompanyId,
    selectedProgramId,
    selectedSessionId,
    note,
    selectedStatus,
    selectedInterest,
    showAssociateCheckbox,
    associateToDeal,
    apiRequest,
    actions,
    loadReferrals,
    loadDealCompanies,
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
  }, [dealId, loadReferrals, loadPropertyDefinitions, loadDealCompanies]);

  // Clear success message after delay
  useEffect(() => {
    if (successMessage) {
      const timer = setTimeout(() => setSuccessMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [successMessage]);

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
    <Flex direction="column" gap="lg">
      <Heading>Referral Builder</Heading>

      {/* Deal Info */}
      <Flex direction="row" gap="sm" align="center" wrap="wrap">
        <Tag>Deal ID: {dealId}</Tag>
        {dealHasCompany && (
          <Tag variant="success">
            Company: {dealCompanies.map((c) => c.name || c.id).join(", ")}
          </Tag>
        )}
        {!dealHasCompany && <Tag variant="warning">No company linked</Tag>}
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
      <Flex direction="row" gap="xl" wrap="wrap">
        {/* LEFT: Create Form */}
        <Box flex={1}>
          <Heading level={3}>Create Referral</Heading>

          {/* Company Search */}
          <Flex direction="column" gap="sm">
            <Input
              name="companyQuery"
              label="Search company"
              value={companyQuery}
              onChange={(val: string) => setCompanyQuery(val)}
              placeholder="Type company name..."
            />
            <Button
              variant="secondary"
              size="small"
              onClick={async () => {
                setError(null);
                setBusy(true);
                try {
                  await searchCompanies();
                } catch (e: any) {
                  setError(e?.message || "Search failed");
                } finally {
                  setBusy(false);
                }
              }}
              disabled={busy || !companyQuery.trim()}
            >
              Search
            </Button>

            <Select
              name="company"
              label="Company *"
              options={companyOptions}
              value={selectedCompanyId}
              onChange={async (val: string) => {
                setSelectedCompanyId(val);
                setError(null);
                setBusy(true);
                try {
                  await loadPrograms(val);
                } catch (e: any) {
                  setError(e?.message || "Failed to load programs");
                } finally {
                  setBusy(false);
                }
              }}
              required
            />

            {/* Associate checkbox */}
            {showAssociateCheckbox && (
              <Checkbox
                name="associateToDeal"
                checked={associateToDeal}
                onChange={(checked: boolean) => setAssociateToDeal(checked)}
              >
                Also associate this company to the deal
              </Checkbox>
            )}

            <Select
              name="program"
              label="Program (optional)"
              options={programOptions}
              value={selectedProgramId}
              onChange={async (val: string) => {
                setSelectedProgramId(val);
                setError(null);
                setBusy(true);
                try {
                  await loadSessions(val);
                } catch (e: any) {
                  setError(e?.message || "Failed to load sessions");
                } finally {
                  setBusy(false);
                }
              }}
            />

            <Select
              name="session"
              label="Session (optional)"
              options={sessionOptions}
              value={selectedSessionId}
              onChange={(val: string) => setSelectedSessionId(val)}
            />

            <Select
              name="status"
              label="Referral Status"
              options={statusOptions}
              value={selectedStatus}
              onChange={(val: string) => setSelectedStatus(val)}
              description={`Default: ${
                statusOptions.find((o) => o.value === DEFAULTS.REFERRAL_STATUS)?.label ||
                "Ready to Send"
              }`}
            />

            <Select
              name="interest"
              label="Client Interest"
              options={interestOptions}
              value={selectedInterest}
              onChange={(val: string) => setSelectedInterest(val)}
              description={`Default: ${
                interestOptions.find((o) => o.value === DEFAULTS.CLIENT_INTEREST)?.label ||
                "Active / considering"
              }`}
            />

            <TextArea
              name="note"
              label="Note to company"
              value={note}
              onChange={(val: string) => setNote(val)}
              placeholder="Optional note..."
            />

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
              {busy ? "Creating..." : "Create Referral"}
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
            <Flex direction="column" gap="md">
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
    </Flex>
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
  const [localStatus, setLocalStatus] = useState(referral.outreachStatus || "");
  const [localInterest, setLocalInterest] = useState(referral.clientInterest || "");
  const [localNote, setLocalNote] = useState(referral.note || "");
  const [saving, setSaving] = useState(false);

  // Check if values have changed
  const hasChanges =
    localStatus !== (referral.outreachStatus || "") ||
    localInterest !== (referral.clientInterest || "") ||
    localNote !== (referral.note || "");

  const handleSave = async () => {
    setSaving(true);
    try {
      await onUpdate(referral.id, {
        referral_outreach_status_enumeration: localStatus,
        referral_client_interest_enumeration: localInterest,
        referral_note: localNote,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box>
      <Flex direction="column" gap="sm">
        <Text format={{ fontWeight: "bold" }}>
          {referral.company?.name || "Unknown Company"}
        </Text>

        <Text variant="microcopy">
          Program: {referral.program?.name || "N/A"} | Session: {referral.session?.name || "N/A"}
        </Text>

        {referral.createdAt && (
          <Text variant="microcopy">
            Created: {new Date(referral.createdAt).toLocaleDateString()}
          </Text>
        )}

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
      <Divider />
    </Box>
  );
}
