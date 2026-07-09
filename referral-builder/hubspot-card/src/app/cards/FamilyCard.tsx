/**
 * Family Deals card — rendered on Child, Household, and Parent (contact)
 * records. Gives Camp Experts the family's whole deal picture at a glance and
 * a one-click "Add Deal" that creates the deal with all required fields and
 * associations (child, household, parent contacts) in one shot.
 *
 * Views by record type (context.crm.objectTypeId):
 *   Child     — that kid's open deals, then historic Attended / Closed Lost.
 *   Household — every kid's deals, with a kid filter + group-by control.
 *   Contact   — same as household (resolved via the parent's household).
 *
 * Deal creation is deliberately explicit about WHICH kid: the kid dropdown is
 * required (preselected and shown read-only on a child record), and the
 * button echoes the exact deal name it will create.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  hubspot,
  Alert,
  Box,
  Button,
  Checkbox,
  Divider,
  Flex,
  Input,
  Link,
  LoadingSpinner,
  Select,
  Tag,
  Text,
} from "@hubspot/ui-extensions";
import { API_BASE } from "./views/types";

// ============================================================================
// Types (mirror the /api/v2/family responses)
// ============================================================================

interface Kid {
  id: string;
  name: string;
}

interface DealSummary {
  dealId: string;
  dealName: string;
  dealUrl: string;
  year: string;
  pipeline: string;
  category: "open" | "won" | "lost";
  statusLabel: string;
  camp: string;
  tuition: string;
  currency: string;
  weeks: string;
  sessionName: string;
  expertProfile: string;
  closedLostCategory: string;
  closedLostReason: string;
  childId: string | null;
  childName: string;
}

interface Overview {
  objectType: "child" | "household" | "contact";
  objectId: string;
  householdId: string | null;
  kids: Kid[];
  deals: DealSummary[];
}

interface Option {
  label: string;
  value: string;
}

// ============================================================================
// Helpers
// ============================================================================

function money(amount: string, currency: string): string {
  const n = parseFloat(amount);
  if (!amount || Number.isNaN(n)) return "";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `$${n.toLocaleString()}`;
  }
}

function typeFromContext(objectTypeId: string | undefined): Overview["objectType"] | null {
  if (!objectTypeId) return null;
  if (objectTypeId === "0-1") return "contact";
  if (objectTypeId === "2-53610744") return "household";
  if (objectTypeId === "2-50911061") return "child";
  return null;
}

/**
 * Expert-profile filtering: each expert should only be offered THEIR
 * profiles (Karen Meister → "Karen Meister", "Karen Meister EXPO",
 * "Karen Meister SPECIAL"…). Matching is name-based against the logged-in
 * HubSpot user:
 *   - the label contains the user's full name (normalized), OR
 *   - the label is a combo profile ("CarrieAndFiona", "Amanda/Eliza",
 *     "EmilyAndBeth") that contains the user's first name.
 * Fails open: when nothing matches (assistants, admins, name mismatches) the
 * full list is shown, and a "Show all profiles" toggle is always available.
 */
function normalize(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function filterExpertOptionsForUser(
  options: Option[],
  firstName: string,
  lastName: string
): Option[] {
  const nf = normalize(firstName);
  const nl = normalize(lastName);
  if (!nf) return options;
  const mine = options.filter((o) => {
    const label = o.label || "";
    const n = normalize(label);
    if (nl && n.includes(nf + nl)) return true; // "Karen Meister EXPO"
    if (nl && n.includes(nf) && n.includes(nl)) return true; // reordered
    // Combo profiles list first names joined by And / & / slash.
    if (n.includes(nf) && /(and|&|\/)/i.test(label)) return true;
    return false;
  });
  return mine.length > 0 ? mine : options;
}

const LOST_LABELS: Record<string, string> = {
  WAIT_NEXT_YEAR: "Waiting for next year",
  RETURNING_CAMPER: "Returning camper",
  OTHER_PROGRAM: "Picked another program",
  OUT_OF_MARKET: "Aging out / staying home",
  MONEY: "Tuition / can't afford",
  NON_RESPONSIVE: "Went silent",
  OTHER: "Other",
};

// ============================================================================
// Entry
// ============================================================================

hubspot.extend(({ context, actions }) => (
  <FamilyCard context={context} actions={actions} />
));

function FamilyCard({ context, actions }: { context: any; actions?: any }) {
  const objectId = context?.crm?.objectId ? String(context.crm.objectId) : null;
  const objectType = typeFromContext(
    context?.crm?.objectTypeId ? String(context.crm.objectTypeId) : undefined
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [expertOptions, setExpertOptions] = useState<Option[]>([]);

  const load = useCallback(async () => {
    if (!objectId || !objectType) return;
    setLoading(true);
    setError(null);
    try {
      const [ovResp, exResp] = await Promise.all([
        hubspot.fetch(
          `${API_BASE}/api/v2/family/${objectType}/${objectId}/overview`
        ),
        hubspot.fetch(`${API_BASE}/api/v2/family/expert-profiles`),
      ]);
      if (!ovResp.ok) throw new Error(`overview HTTP ${ovResp.status}`);
      const ov = (await ovResp.json()) as Overview;
      setOverview(ov);
      if (exResp.ok) {
        const ex = await exResp.json().catch(() => ({}));
        setExpertOptions(ex?.options || []);
      }
    } catch (e: any) {
      setError(e?.message || "Failed to load family deals.");
    } finally {
      setLoading(false);
    }
  }, [objectId, objectType]);

  useEffect(() => {
    load();
  }, [load]);

  if (!objectId || !objectType) {
    return (
      <Alert title="Unsupported record" variant="info">
        This card runs on Child, Household, and Parent records.
      </Alert>
    );
  }
  if (loading) {
    return (
      <Flex direction="column" align="center" gap="sm">
        <LoadingSpinner />
        <Text>Loading family deals…</Text>
      </Flex>
    );
  }
  if (error || !overview) {
    return (
      <Flex direction="column" gap="sm">
        <Alert title="Error" variant="error">
          {error || "No data."}
        </Alert>
        <Button variant="primary" onClick={load}>
          Retry
        </Button>
      </Flex>
    );
  }

  return (
    <FamilyOverviewView
      overview={overview}
      expertOptions={expertOptions}
      user={context?.user || null}
      onChanged={load}
      actions={actions}
    />
  );
}

// ============================================================================
// Overview view
// ============================================================================

/**
 * Tiny uppercase label so sections read as quiet dividers while bold text
 * stays reserved for the names that matter (kids, camps, group headers).
 */
function SectionLabel({ text }: { text: string }) {
  return (
    <Text variant="microcopy" format={{ fontWeight: "bold" }}>
      {text.toUpperCase()}
    </Text>
  );
}

function byYearDesc(a: DealSummary, b: DealSummary): number {
  return (b.year || "").localeCompare(a.year || "");
}

function FamilyOverviewView({
  overview,
  expertOptions,
  user,
  onChanged,
  actions,
}: {
  overview: Overview;
  expertOptions: Option[];
  user: { firstName?: string; lastName?: string } | null;
  onChanged: () => void;
  actions?: any;
}) {
  const multiKid = overview.kids.length > 1;
  const [kidFilter, setKidFilter] = useState<string>("ALL");
  const [groupBy, setGroupBy] = useState<string>("year");

  const deals = useMemo(
    () =>
      kidFilter === "ALL"
        ? overview.deals
        : overview.deals.filter((d) => d.childId === kidFilter),
    [overview.deals, kidFilter]
  );

  const open = deals
    .filter((d) => d.category === "open")
    .sort((a, b) => (a.year || "").localeCompare(b.year || ""));
  const won = deals.filter((d) => d.category === "won").sort(byYearDesc);
  const lost = deals.filter((d) => d.category === "lost").sort(byYearDesc);

  // Kid names only add signal when several kids could appear in one list.
  const showKidNames = multiKid && kidFilter === "ALL";
  const historyGroupBy = multiKid ? groupBy : "year";

  return (
    <Flex direction="column" gap="xs">
      <Flex direction="row" justify="space-between" align="center" wrap="wrap">
        <Text format={{ fontWeight: "bold" }}>Camp deals</Text>
        <Text variant="microcopy">
          {overview.kids.length} kid{overview.kids.length === 1 ? "" : "s"} ·{" "}
          {overview.deals.length} deal{overview.deals.length === 1 ? "" : "s"}
        </Text>
      </Flex>

      {multiKid && (
        <Flex direction="row" gap="sm" wrap="wrap">
          <Select
            name="kidFilter"
            label="Kid"
            options={[
              { label: "All kids", value: "ALL" },
              ...overview.kids.map((k) => ({ label: k.name, value: k.id })),
            ]}
            value={kidFilter}
            onChange={(v) => setKidFilter(v as string)}
          />
          <Select
            name="groupBy"
            label="Group history by"
            options={[
              { label: "Year", value: "year" },
              { label: "Kid", value: "kid" },
              { label: "Camp", value: "camp" },
            ]}
            value={groupBy}
            onChange={(v) => setGroupBy(v as string)}
          />
        </Flex>
      )}

      {/* ---- Open deals ---- */}
      <SectionLabel text={`Open (${open.length})`} />
      {open.length === 0 ? (
        <Text variant="microcopy">No open deals.</Text>
      ) : (
        <Flex direction="column" gap="flush">
          {open.map((d) => (
            <OpenRow key={d.dealId} d={d} showKid={showKidNames} />
          ))}
        </Flex>
      )}

      <Divider />

      {/* ---- Historic: attended (Closed Won) ---- */}
      <SectionLabel text={`Attended (${won.length})`} />
      {won.length === 0 ? (
        <Text variant="microcopy">No past enrollments.</Text>
      ) : (
        <GroupedDealList
          deals={won}
          groupBy={historyGroupBy}
          kids={overview.kids}
          showKidNames={showKidNames}
          renderRow={(d, o) => (
            <WonRow key={d.dealId} d={d} showKid={o.showKid} showCamp={o.showCamp} />
          )}
        />
      )}

      <Divider />

      {/* ---- Historic: closed lost ---- */}
      <SectionLabel text={`Closed Lost (${lost.length})`} />
      {lost.length === 0 ? (
        <Text variant="microcopy">None.</Text>
      ) : (
        <GroupedDealList
          deals={lost}
          groupBy={historyGroupBy}
          kids={overview.kids}
          showKidNames={showKidNames}
          renderRow={(d, o) => (
            <LostRow key={d.dealId} d={d} showKid={o.showKid} showCamp={o.showCamp} />
          )}
        />
      )}

      <Divider />

      <AddDealSection
        overview={overview}
        expertOptions={expertOptions}
        user={user}
        onCreated={onChanged}
        actions={actions}
      />
    </Flex>
  );
}

// ---- Deal rows (one line each; the bold year anchors the eye) --------------

/** Open deal: year · camp, status as a tag, quiet View link. */
function OpenRow({ d, showKid }: { d: DealSummary; showKid: boolean }) {
  return (
    <Flex direction="row" gap="xs" align="center" wrap="wrap">
      {showKid && d.childName && (
        <Text format={{ fontWeight: "bold" }}>{d.childName}</Text>
      )}
      <Text variant="microcopy" format={{ fontWeight: "bold" }}>
        {d.year || "—"}
      </Text>
      {d.camp && <Text variant="microcopy">{d.camp}</Text>}
      {d.statusLabel && <Tag variant="default">{d.statusLabel}</Tag>}
      <Link href={d.dealUrl}>View</Link>
    </Flex>
  );
}

/** Closed-Won row: camp, tuition, weeks — the facts that matter later. */
function WonRow({
  d,
  showKid,
  showCamp,
}: {
  d: DealSummary;
  showKid: boolean;
  showCamp: boolean;
}) {
  const facts = [
    showCamp ? d.camp || "Camp not recorded" : "",
    d.tuition ? money(d.tuition, d.currency) : "",
    d.weeks ? `${d.weeks} wk` : "",
    d.sessionName,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Flex direction="row" gap="xs" align="baseline" wrap="wrap">
      {showKid && d.childName && (
        <Text format={{ fontWeight: "bold" }}>{d.childName}</Text>
      )}
      <Text variant="microcopy" format={{ fontWeight: "bold" }}>
        {d.year || "—"}
      </Text>
      {facts && <Text variant="microcopy">{facts}</Text>}
      <Link href={d.dealUrl}>View</Link>
    </Flex>
  );
}

function LostRow({
  d,
  showKid,
  showCamp,
}: {
  d: DealSummary;
  showKid: boolean;
  showCamp: boolean;
}) {
  const reason =
    LOST_LABELS[d.closedLostCategory] ||
    d.closedLostCategory ||
    "No reason recorded";
  return (
    <Flex direction="row" gap="xs" align="baseline" wrap="wrap">
      {showKid && d.childName && (
        <Text format={{ fontWeight: "bold" }}>{d.childName}</Text>
      )}
      <Text variant="microcopy" format={{ fontWeight: "bold" }}>
        {d.year || "—"}
      </Text>
      <Text variant="microcopy">
        {reason + (showCamp && d.camp ? ` — ${d.camp}` : "")}
      </Text>
      <Link href={d.dealUrl}>View</Link>
    </Flex>
  );
}

// ---- Grouping --------------------------------------------------------------

interface RowOpts {
  showKid: boolean;
  showCamp: boolean;
}

/**
 * History list with the "Group history by" behavior. Ungrouped ("year") is a
 * flat year-sorted list; "kid" and "camp" nest rows under a bold group header
 * with a count, and drop the grouped-on field from each row so the header is
 * doing the work. Kid groups follow the household's kid order.
 */
function GroupedDealList({
  deals,
  groupBy,
  kids,
  showKidNames,
  renderRow,
}: {
  deals: DealSummary[];
  groupBy: string;
  kids: Kid[];
  showKidNames: boolean;
  renderRow: (d: DealSummary, opts: RowOpts) => React.ReactNode;
}) {
  if (groupBy !== "kid" && groupBy !== "camp") {
    return (
      <Flex direction="column" gap="flush">
        {deals.map((d) => renderRow(d, { showKid: showKidNames, showCamp: true }))}
      </Flex>
    );
  }

  const keyOf = (d: DealSummary) =>
    groupBy === "kid"
      ? d.childName || "Unknown kid"
      : d.camp || "Camp not recorded";
  const groups = new Map<string, DealSummary[]>();
  for (const d of deals) {
    const k = keyOf(d);
    groups.set(k, [...(groups.get(k) || []), d]);
  }

  const entries = Array.from(groups.entries());
  if (groupBy === "kid") {
    const order = new Map(kids.map((k, i) => [k.name, i]));
    entries.sort(
      (a, b) =>
        (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999) ||
        a[0].localeCompare(b[0])
    );
  } else {
    entries.sort((a, b) => a[0].localeCompare(b[0]));
  }

  const rowOpts: RowOpts = {
    showKid: groupBy !== "kid" && showKidNames,
    showCamp: groupBy !== "camp",
  };

  return (
    <Flex direction="column" gap="xs">
      {entries.map(([label, ds]) => (
        <Box key={label}>
          <Flex direction="row" gap="xs" align="baseline">
            <Text format={{ fontWeight: "bold" }}>{label}</Text>
            <Text variant="microcopy">
              {ds.length} deal{ds.length === 1 ? "" : "s"}
            </Text>
          </Flex>
          <Flex direction="column" gap="flush">
            {ds.map((d) => renderRow(d, rowOpts))}
          </Flex>
        </Box>
      ))}
    </Flex>
  );
}

// ============================================================================
// Add Deal
// ============================================================================

function AddDealSection({
  overview,
  expertOptions,
  user,
  onCreated,
  actions,
}: {
  overview: Overview;
  expertOptions: Option[];
  user: { firstName?: string; lastName?: string } | null;
  onCreated: () => void;
  actions?: any;
}) {
  const singleKid = overview.kids.length === 1;
  const nextYear = String(new Date().getFullYear() + 1);

  const [kidId, setKidId] = useState<string>(
    singleKid ? overview.kids[0].id : ""
  );
  const [year, setYear] = useState(nextYear);
  const [expert, setExpert] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState<string | null>(null);
  // Experts only see THEIR profiles by default (matched on the logged-in
  // user's name); the toggle reveals the full list for admins/assistants.
  const [showAllProfiles, setShowAllProfiles] = useState(false);
  const myOptions = useMemo(
    () =>
      filterExpertOptionsForUser(
        expertOptions,
        user?.firstName || "",
        user?.lastName || ""
      ),
    [expertOptions, user]
  );
  const isFiltered = myOptions.length < expertOptions.length;
  const visibleExpertOptions = showAllProfiles ? expertOptions : myOptions;
  const [created, setCreated] = useState<{ dealName: string; dealUrl: string } | null>(
    null
  );

  const kidName = overview.kids.find((k) => k.id === kidId)?.name || "";
  const ready = Boolean(kidId && year && expert);

  // Gentle guide (not a block): what this kid already has for the target year
  // — a family can run two programs in one summer, so a second deal is fine.
  const sameYearDeals = useMemo(
    () =>
      overview.deals.filter((d) => d.childId === kidId && d.year === year.trim()),
    [overview.deals, kidId, year]
  );

  const create = useCallback(
    async (confirmDuplicate: boolean) => {
      if (!ready) return;
      setBusy(true);
      setError(null);
      setCreated(null);
      try {
        const resp = await hubspot.fetch(`${API_BASE}/api/v2/family/create-deal`, {
          method: "POST",
          body: JSON.stringify({
            childId: kidId,
            year: parseInt(year, 10),
            expertProfile: expert,
            householdId: overview.householdId || undefined,
            confirmDuplicate,
          }),
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 409 && data?.requiresConfirmation) {
          setNeedsConfirm(
            data.message || "This kid already has a deal for that year."
          );
          return;
        }
        if (resp.ok && data?.success) {
          setNeedsConfirm(null);
          setCreated({ dealName: data.dealName, dealUrl: data.dealUrl });
          actions?.addAlert?.({
            type: "success",
            message: `Created ${data.dealName} with all associations.`,
          });
          onCreated();
        } else {
          setError(data?.message || "Failed to create the deal.");
        }
      } catch (e: any) {
        setError(e?.message || "Failed to create the deal.");
      } finally {
        setBusy(false);
      }
    },
    [ready, kidId, year, expert, overview.householdId, onCreated, actions]
  );

  return (
    <Flex direction="column" gap="xs">
      <SectionLabel text="Add deal" />
      <Text variant="microcopy">
        Creates the deal at New Lead with the household, parent, and child
        associations set automatically.
      </Text>

      {error && <Alert variant="error">{error}</Alert>}
      {created && (
        <Alert title="Deal created" variant="success">
          <Flex direction="column" gap="xs">
            <Text>{created.dealName}</Text>
            <Link href={created.dealUrl}>Open the new deal</Link>
          </Flex>
        </Alert>
      )}

      {/* Gentle heads-up, not a block — two programs in one year is valid. */}
      {!needsConfirm && sameYearDeals.length > 0 && (
        <Text variant="microcopy">
          {`Note: ${kidName || "this kid"} already has ${year} deal${
            sameYearDeals.length === 1 ? "" : "s"
          } — ${sameYearDeals
            .map((d) => `"${d.dealName}" (${d.statusLabel})`)
            .join(", ")}. You can still add another (e.g. a second program).`}
        </Text>
      )}

      {singleKid ? (
        <Flex direction="row" gap="sm" align="center">
          <Text format={{ fontWeight: "bold" }}>Kid:</Text>
          <Text>{overview.kids[0]?.name}</Text>
        </Flex>
      ) : (
        <Select
          name="addDealKid"
          label="Which kid?"
          options={overview.kids.map((k) => ({ label: k.name, value: k.id }))}
          value={kidId}
          onChange={(v) => setKidId(v as string)}
          required
          description="Double-check this — the deal, its name, and all associations are created for this kid."
        />
      )}

      <Input
        name="addDealYear"
        label="Year"
        value={year}
        onChange={(v) => setYear(v as string)}
      />

      <Select
        name="addDealExpert"
        label="Expert profile"
        options={visibleExpertOptions}
        value={expert}
        onChange={(v) => setExpert(v as string)}
        required
        description={
          expertOptions.length === 0
            ? "Loading expert list…"
            : !showAllProfiles && isFiltered
            ? `Showing your profiles (${myOptions.length} of ${expertOptions.length})`
            : undefined
        }
      />

      {isFiltered && (
        <Checkbox
          name="showAllProfiles"
          checked={showAllProfiles}
          onChange={(v: boolean) => setShowAllProfiles(Boolean(v))}
        >
          Show all expert profiles
        </Checkbox>
      )}

      {needsConfirm ? (
        <Flex direction="column" gap="sm">
          <Alert title="Existing deals this year" variant="warning">
            {needsConfirm}
          </Alert>
          <Flex direction="row" gap="sm" wrap="wrap">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => create(true)}
            >
              {busy ? "Creating…" : "Create anyway (second program)"}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setNeedsConfirm(null)}
            >
              Cancel
            </Button>
          </Flex>
        </Flex>
      ) : (
        <Button
          variant="primary"
          disabled={!ready || busy}
          onClick={() => create(false)}
        >
          {busy
            ? "Creating…"
            : ready
            ? `Create "${kidName} | ${year}"`
            : "Pick a kid, year, and expert"}
        </Button>
      )}
    </Flex>
  );
}
