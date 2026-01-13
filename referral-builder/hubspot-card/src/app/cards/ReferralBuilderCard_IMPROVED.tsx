import React, { useEffect, useMemo, useState } from "react";
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
} from "@hubspot/ui-extensions";

const API_BASE = "https://referral-builder1122026.vercel.app"; // <-- CHANGE THIS (no trailing slash)

type Option = { label: string; value: string };

type ReferralRow = {
  id: string;
  referralKey?: string;
  outreachStatus?: string;
  clientInterest?: string;
  note?: string;
  createdAt?: string;
  company?: { id?: string; name?: string };
  program?: { id?: string; name?: string };
  session?: { id?: string; name?: string; startDate?: string; endDate?: string; price?: string };
};

type DealCompany = {
  id: string;
  name?: string;
};

// Default options (will be replaced by API-loaded options if available)
const DEFAULT_OUTREACH_OPTIONS: Option[] = [
  { label: "Draft", value: "draft" },
  { label: "Ready to Send", value: "ready_to_send" },
  { label: "Sent", value: "sent" },
  { label: "Resend", value: "resend" },
  { label: "Don't send (already sent)", value: "dont_send" },
];

const DEFAULT_INTEREST_OPTIONS: Option[] = [
  { label: "Active / considering", value: "active_considering" },
  { label: "Shortlist", value: "shortlist" },
  { label: "Neutral", value: "neutral" },
  { label: "Unlikely", value: "unlikely" },
  { label: "Declined", value: "declined" },
  { label: "Selected", value: "selected" },
];

// Default values for new referrals
const DEFAULT_REFERRAL_STATUS = "ready_to_send"; // "Ready to Send"
const DEFAULT_CLIENT_INTEREST = "active_considering"; // "Active / considering"

hubspot.extend(({ context, actions }) => (
  <ReferralBuilderCard context={context} actions={actions} />
));

function ReferralBuilderCard({ context, actions }: any) {
  const dealId = context?.crm?.objectId ? String(context.crm.objectId) : null;

  // Loading and error states
  const [initialLoading, setInitialLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Data states
  const [referrals, setReferrals] = useState<ReferralRow[]>([]);
  const [dealCompanies, setDealCompanies] = useState<DealCompany[]>([]);

  // Form states
  const [companyQuery, setCompanyQuery] = useState("");
  const [companyOptions, setCompanyOptions] = useState<Option[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>("");

  const [programOptions, setProgramOptions] = useState<Option[]>([]);
  const [selectedProgramId, setSelectedProgramId] = useState<string>("");

  const [sessionOptions, setSessionOptions] = useState<Option[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");

  const [note, setNote] = useState("");

  // Default selections for new referrals
  const [selectedOutreachStatus, setSelectedOutreachStatus] = useState<string>(DEFAULT_REFERRAL_STATUS);
  const [selectedClientInterest, setSelectedClientInterest] = useState<string>(DEFAULT_CLIENT_INTEREST);

  // Association checkbox (only show if deal has no company)
  const [associateToDeal, setAssociateToDeal] = useState(true);

  // Property options (loaded from HubSpot)
  const [outreachOptions, setOutreachOptions] = useState<Option[]>(DEFAULT_OUTREACH_OPTIONS);
  const [interestOptions, setInterestOptions] = useState<Option[]>(DEFAULT_INTEREST_OPTIONS);

  const dealHasCompany = dealCompanies.length > 0;
  const showAssociateCheckbox = !dealHasCompany && selectedCompanyId;

  const canCreate = useMemo(() => {
    return Boolean(dealId && selectedCompanyId && !busy);
  }, [dealId, selectedCompanyId, busy]);

  // Enhanced API request with better error handling
  async function apiRequest(path: string, init?: { method?: string; body?: any }) {
    const url = `${API_BASE}${path}`;
    const headers: Record<string, string> = {};

    if (init?.body) {
      headers["Content-Type"] = "application/json";
    }

    const res = await hubspot.fetch(url, {
      method: init?.method || "GET",
      headers,
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });

    let data: any = null;
    try {
      data = await res.json();
    } catch (e) {
      // ignore JSON parse errors
    }

    if (!res.ok) {
      // Enhanced error extraction
      let msg = `Request failed (${res.status})`;

      if (data?.error) {
        msg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
      } else if (data?.message) {
        msg = data.message;
      } else if (data?.errors && Array.isArray(data.errors)) {
        msg = data.errors.map((e: any) => e.message || JSON.stringify(e)).join('; ');
      }

      throw new Error(msg);
    }
    return data;
  }

  // HubSpot CRM API helper (for fetching deal associations)
  async function hubspotCrmRequest(path: string) {
    const url = `https://api.hubapi.com${path}`;
    const res = await hubspot.fetch(url);

    if (!res.ok) {
      let errorMsg = `HubSpot API error (${res.status})`;
      try {
        const errorData = await res.json();
        errorMsg = errorData?.message || errorMsg;
      } catch (e) {
        // ignore
      }
      throw new Error(errorMsg);
    }

    return await res.json();
  }

  // Load deal's associated companies
  async function loadDealCompanies() {
    if (!dealId) return;

    try {
      // Fetch deal with company associations
      const data = await hubspotCrmRequest(
        `/crm/v4/objects/deals/${dealId}?associations=companies`
      );

      const companies: DealCompany[] = [];

      if (data?.associations?.companies?.results) {
        for (const assoc of data.associations.companies.results) {
          // Fetch company details
          try {
            const companyData = await hubspotCrmRequest(
              `/crm/v3/objects/companies/${assoc.toObjectId}?properties=name`
            );
            companies.push({
              id: assoc.toObjectId,
              name: companyData?.properties?.name || `Company ${assoc.toObjectId}`,
            });
          } catch (e) {
            console.error(`Failed to load company ${assoc.toObjectId}:`, e);
            companies.push({ id: assoc.toObjectId });
          }
        }
      }

      setDealCompanies(companies);

      // Pre-select company if there's exactly one
      if (companies.length === 1 && !selectedCompanyId) {
        setSelectedCompanyId(companies[0].id);
        // Load programs for pre-selected company
        await loadPrograms(companies[0].id);
      }
    } catch (e: any) {
      console.error("Failed to load deal companies:", e);
      // Don't fail the entire load if this fails
    }
  }

  async function loadPropertyDefinitions() {
    try {
      const data = await apiRequest(`/api/referrals/properties`);
      const props = data?.properties || {};

      // Update options if available from API
      if (props.referral_status?.options?.length) {
        setOutreachOptions(props.referral_status.options);
      }
      if (props.client_interest?.options?.length) {
        setInterestOptions(props.client_interest.options);
      }
    } catch (e) {
      console.error("Failed to load property definitions:", e);
      // Continue with default options
    }
  }

  async function loadReferrals() {
    if (!dealId) return;
    const data = await apiRequest(`/api/deals/${dealId}/referrals`);
    setReferrals(data?.results || []);
  }

  async function searchCompanies() {
    if (!companyQuery.trim()) {
      setCompanyOptions([]);
      return;
    }
    const data = await apiRequest(`/api/companies/search?q=${encodeURIComponent(companyQuery.trim())}`);
    const opts: Option[] = (data?.results || []).map((c: any) => ({
      label: c.name || `Company ${c.id}`,
      value: String(c.id),
    }));
    setCompanyOptions(opts);
  }

  async function loadPrograms(companyId: string) {
    setProgramOptions([]);
    setSelectedProgramId("");
    setSessionOptions([]);
    setSelectedSessionId("");

    if (!companyId) return;
    const data = await apiRequest(`/api/companies/${companyId}/programs`);

    // Display program NAMES, store program IDs
    const opts: Option[] = (data?.results || []).map((p: any) => ({
      label: p.name || `Program ${p.id}`,
      value: String(p.id),
    }));
    setProgramOptions(opts);
  }

  async function loadSessions(programId: string) {
    setSessionOptions([]);
    setSelectedSessionId("");

    if (!programId) return;
    const data = await apiRequest(`/api/programs/${programId}/sessions`);

    // Display session NAMES (with dates/price), store session IDs
    const opts: Option[] = (data?.results || []).map((s: any) => {
      const labelParts = [s.name || `Session ${s.id}`];
      if (s.startDate) labelParts.push(`(${s.startDate})`);
      if (s.price) labelParts.push(`$${s.price}`);
      return { label: labelParts.join(" "), value: String(s.id) };
    });

    setSessionOptions(opts);
  }

  async function createReferral() {
    if (!dealId || !selectedCompanyId) {
      setError("Deal ID and Company are required");
      return;
    }

    const payload = {
      dealId,
      companyId: selectedCompanyId,
      programId: selectedProgramId || undefined,
      sessionId: selectedSessionId || undefined,
      note: note || undefined,
      // Send default values for status and interest
      outreachStatus: selectedOutreachStatus,
      clientInterest: selectedClientInterest,
      // Flag to indicate if we should also associate company to deal
      associateToDeal: showAssociateCheckbox && associateToDeal,
    };

    const data = await apiRequest(`/api/referrals`, { method: "POST", body: payload });

    const message = data?.created
      ? `Referral created successfully (ID ${data?.referralId || "unknown"})`
      : `Referral updated (ID ${data?.referralId || "unknown"})`;

    actions?.addAlert?.({
      type: "success",
      message,
    });

    // Clear form
    setNote("");
    setSelectedCompanyId("");
    setSelectedProgramId("");
    setSelectedSessionId("");
    setCompanyQuery("");
    setCompanyOptions([]);
    setProgramOptions([]);
    setSessionOptions([]);

    // Reset to defaults
    setSelectedOutreachStatus(DEFAULT_REFERRAL_STATUS);
    setSelectedClientInterest(DEFAULT_CLIENT_INTEREST);

    // Refresh referrals list and deal companies
    await Promise.all([loadReferrals(), loadDealCompanies()]);
  }

  async function updateReferral(referralId: string, properties: Record<string, any>) {
    await apiRequest(`/api/referrals/${referralId}`, {
      method: "PATCH",
      body: { properties },
    });
    actions?.addAlert?.({ type: "success", message: "Referral updated successfully" });
    await loadReferrals();
  }

  // Initial data load
  useEffect(() => {
    (async () => {
      setError(null);
      if (!dealId) return;
      try {
        setInitialLoading(true);
        await Promise.all([
          loadReferrals(),
          loadPropertyDefinitions(),
          loadDealCompanies(),
        ]);
      } catch (e: any) {
        setError(e?.message || "Failed to load data");
      } finally {
        setInitialLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId]);

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

  return (
    <Flex direction="column" gap="lg">
      <Heading>Referral Builder</Heading>

      {/* Deal info and associated companies */}
      <Flex direction="row" gap="sm" align="center">
        <Text>Deal ID: {dealId}</Text>
        {dealHasCompany && (
          <Text format={{ fontWeight: "bold" }}>
            | Company: {dealCompanies.map(c => c.name || c.id).join(", ")}
          </Text>
        )}
      </Flex>

      {error && (
        <Alert title="Error" variant="error">
          {error}
        </Alert>
      )}

      <Divider />

      {/* TWO-COLUMN LAYOUT */}
      <Flex direction="row" gap="lg" wrap="wrap">

        {/* LEFT COLUMN: CREATE FORM */}
        <Box flex={1} style={{ minWidth: "300px" }}>
          <Heading level="h3">Create Referral</Heading>

          {/* Company Search */}
          <Input
            name="companyQuery"
            label="Search company"
            value={companyQuery}
            onChange={(val: string) => setCompanyQuery(val)}
            placeholder="Type a camp/company name..."
          />
          <Button
            variant="secondary"
            onClick={async () => {
              setError(null);
              try {
                setBusy(true);
                await searchCompanies();
              } catch (e: any) {
                setError(e?.message || "Search failed");
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
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
              try {
                setBusy(true);
                await loadPrograms(val);
              } catch (e: any) {
                setError(e?.message || "Failed to load programs");
              } finally {
                setBusy(false);
              }
            }}
            required
          />

          {/* Show checkbox to associate company to deal if needed */}
          {showAssociateCheckbox && (
            <Checkbox
              name="associateToDeal"
              checked={associateToDeal}
              onChange={(checked: boolean) => setAssociateToDeal(checked)}
              label="Also associate this company to the deal"
              description="This deal has no associated company. Check this to create the association."
            />
          )}

          <Select
            name="program"
            label="Program (optional)"
            options={programOptions}
            value={selectedProgramId}
            onChange={async (val: string) => {
              setSelectedProgramId(val);
              setError(null);
              try {
                setBusy(true);
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

          {/* Default selections for new referrals */}
          <Select
            name="outreachStatus"
            label="Referral Status"
            options={outreachOptions}
            value={selectedOutreachStatus}
            onChange={(val: string) => setSelectedOutreachStatus(val)}
            description="Defaults to 'Ready to Send'"
          />

          <Select
            name="clientInterest"
            label="Client Interest"
            options={interestOptions}
            value={selectedClientInterest}
            onChange={(val: string) => setSelectedClientInterest(val)}
            description="Defaults to 'Active / considering'"
          />

          <TextArea
            name="note"
            label="Note to company"
            value={note}
            onChange={(val: string) => setNote(val)}
            placeholder="Optional note that will appear on the Referral record"
          />

          <Button
            variant="primary"
            disabled={!canCreate}
            onClick={async () => {
              setError(null);
              try {
                setBusy(true);
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
        </Box>

        {/* RIGHT COLUMN: EXISTING REFERRALS */}
        <Box flex={1} style={{ minWidth: "300px" }}>
          <Flex direction="row" justify="space-between" align="center">
            <Heading level="h3">Existing Referrals</Heading>
            <Button
              size="small"
              variant="secondary"
              onClick={async () => {
                setError(null);
                try {
                  setBusy(true);
                  await loadReferrals();
                } catch (e: any) {
                  setError(e?.message || "Reload failed");
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
              message="Create your first referral using the form on the left."
            />
          )}

          {!busy && referrals.length > 0 && (
            <Flex direction="column" gap="md">
              {referrals.map((r) => (
                <Box key={r.id} style={{ padding: "12px", border: "1px solid #e0e0e0", borderRadius: "4px" }}>
                  <Flex direction="column" gap="sm">
                    <Text format={{ fontWeight: "bold" }}>
                      {r.company?.name || "Unknown Company"}
                    </Text>

                    <Text format={{ fontSize: "small" }}>
                      Program: {r.program?.name || "N/A"}
                    </Text>

                    <Text format={{ fontSize: "small" }}>
                      Session: {r.session?.name || "N/A"}
                      {r.session?.startDate && ` (${r.session.startDate})`}
                    </Text>

                    {r.createdAt && (
                      <Text format={{ fontSize: "small", color: "gray" }}>
                        Created: {new Date(r.createdAt).toLocaleDateString()}
                      </Text>
                    )}

                    <Select
                      name={`outreach-${r.id}`}
                      label="Status"
                      options={outreachOptions}
                      value={r.outreachStatus || ""}
                      onChange={(val: string) => {
                        setReferrals((prev) =>
                          prev.map((x) =>
                            x.id === r.id ? { ...x, outreachStatus: val } : x
                          )
                        );
                      }}
                    />

                    <Select
                      name={`interest-${r.id}`}
                      label="Client Interest"
                      options={interestOptions}
                      value={r.clientInterest || ""}
                      onChange={(val: string) => {
                        setReferrals((prev) =>
                          prev.map((x) =>
                            x.id === r.id ? { ...x, clientInterest: val } : x
                          )
                        );
                      }}
                    />

                    <TextArea
                      name={`note-${r.id}`}
                      label="Note"
                      value={r.note || ""}
                      onChange={(val: string) => {
                        setReferrals((prev) =>
                          prev.map((x) => (x.id === r.id ? { ...x, note: val } : x))
                        );
                      }}
                    />

                    <Button
                      size="small"
                      onClick={async () => {
                        setError(null);
                        try {
                          setBusy(true);
                          await updateReferral(r.id, {
                            referral_status: r.outreachStatus || "",
                            client_interest: r.clientInterest || "",
                            referral_note_to_company: r.note || "",
                          });
                        } catch (e: any) {
                          setError(e?.message || "Update failed");
                        } finally {
                          setBusy(false);
                        }
                      }}
                      disabled={busy}
                    >
                      Save Changes
                    </Button>
                  </Flex>
                </Box>
              ))}
            </Flex>
          )}
        </Box>
      </Flex>
    </Flex>
  );
}
