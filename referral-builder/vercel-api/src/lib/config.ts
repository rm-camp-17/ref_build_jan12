/**
 * Environment configuration for HubSpot Referral Builder
 *
 * All configuration is driven by environment variables with sensible defaults.
 * Property names match HubSpot internal names (not labels).
 */

// ============================================================================
// Configuration Object
// ============================================================================

export const config = {
  hubspot: {
    accessToken: process.env.HUBSPOT_ACCESS_TOKEN || '',
    // Optional dedicated token used ONLY for the memo's HubSpot Files upload.
    // Set this to a token whose app has the `files` scope (e.g. the Camp
    // Referral Builder app's static token) so you don't have to add `files` to
    // — or risk — the main access token. Falls back to accessToken when unset.
    filesToken: process.env.HUBSPOT_FILES_TOKEN || '',
  },

  // Custom object type identifiers
  // Note: Program and Session are NOT HubSpot custom objects in portal 50530609.
  // Sessions live in Postgres (camp-experts-session-card's external DB) and are
  // looked up via Company.programid (= Postgres companies.access_id). Earlier
  // drafts referenced p_program / p_session HubSpot object types — those were
  // never created in this portal.
  objectTypes: {
    referral: process.env.HS_REFERRAL_OBJECT_TYPE || '2-55790899',
    household: process.env.HS_HOUSEHOLD_OBJECT_TYPE || '2-53610744',
    child: process.env.HS_CHILD_OBJECT_TYPE || '2-50911061',
  },

  // Property internal names by object type
  properties: {
    referral: {
      // Primary key for upsert (dealId-companyId)
      key: process.env.HS_REFERRAL_KEY_PROP || 'referral_key',
      // Display name
      name: process.env.HS_REFERRAL_NAME_PROP || 'referral_name',
      //
      // Outreach status enum — see PROPERTY_NAME_AUDIT.md.
      // Canonical (enum dropdown):  `referral_status`             (label: "referral_outreach_status")
      // Legacy   (string text):     `referral_outreach_status`    (label: "Referral Outreach Status")
      // Earlier code wrote to the legacy STRING field by mistake. We now
      // dual-write both during the migration window. Reads prefer canonical.
      outreachCanonical: process.env.HS_REFERRAL_OUTREACH_CANONICAL_PROP || 'referral_status',
      outreach: process.env.HS_REFERRAL_OUTREACH_PROP || 'referral_outreach_status',
      //
      // Client interest enum — see PROPERTY_NAME_AUDIT.md.
      // Canonical (enum dropdown):  `client_interest`            (label: "referral_client_interest")
      // Legacy   (LABEL-AS-NAME):   `referral_client_interest`   (NOT a real property)
      // The legacy name was the property's label, not its internal name.
      // HubSpot may or may not coerce label → name on write. Dual-writing
      // is harmless either way: writes to a non-existent name are dropped.
      interestCanonical: process.env.HS_REFERRAL_INTEREST_CANONICAL_PROP || 'client_interest',
      interest: process.env.HS_REFERRAL_INTEREST_PROP || 'referral_client_interest',
      // Note to company
      note: process.env.HS_REFERRAL_NOTE_PROP || 'referral_note_to_company',
      // Previously sent checkbox
      previouslySent: process.env.HS_REFERRAL_PREVIOUSLY_SENT_PROP || 'previously_sent_to_camp',
      // Copied from deal key
      copiedDealKey: process.env.HS_REFERRAL_COPIED_DEAL_KEY_PROP || 'copied_from_deal_key',
      // Copied from year
      copiedYear: process.env.HS_REFERRAL_COPIED_YEAR_PROP || 'copied_from_year',
      // Company name (denormalized from Company)
      companyName: process.env.HS_REFERRAL_COMPANY_NAME_PROP || 'company_name',
      // Owner ID (from associated Deal)
      ownerId: process.env.HS_REFERRAL_OWNER_PROP || 'hubspot_owner_id',
      // Resend requested checkbox (computed from outreach status)
      resendRequested: process.env.HS_REFERRAL_RESEND_REQUESTED_PROP || 'resend_requested',
      // Selected session fields (only set when client_interest == "Selected")
      selectedSessionStartDate: process.env.HS_REFERRAL_SELECTED_START_PROP || 'selected_session_start_date',
      selectedSessionEndDate: process.env.HS_REFERRAL_SELECTED_END_PROP || 'selected_session_end_date',
      selectedSessionPrice: process.env.HS_REFERRAL_SELECTED_PRICE_PROP || 'selected_session_price',
      // Email tracking fields
      emailLastSentDatetime: process.env.HS_REFERRAL_EMAIL_LAST_SENT_PROP || 'email_last_sent_datetime',
      emailSendCount: process.env.HS_REFERRAL_EMAIL_SEND_COUNT_PROP || 'email_send_count',
    },
    deal: {
      key: process.env.HS_DEAL_KEY_PROP || 'deal_key',
      year: process.env.HS_DEAL_YEAR_PROP || 'year1',
      name: process.env.HS_DEAL_NAME_PROP || 'dealname', // Usually contains child's name
      // Integration properties - written when referral is marked "Selected"
      programId: process.env.HS_DEAL_PROGRAM_ID_PROP || 'program_id',
      programName: process.env.HS_DEAL_PROGRAM_NAME_PROP || 'programname',
      stage: 'dealstage',
      tuitionAtEnrollment: 'tuition_at_enrollment',
      sessionName: process.env.HS_DEAL_SESSION_NAME_PROP || 'session_name',
      // Enrollment-email fields (already exist on the Deal in portal 50530609).
      // Checking `send_enrollment_email` triggers an existing HubSpot-side
      // poller (every ~2 min) that sends the camp enrollment email and
      // unchecks the box, stamping enrollment_email_sent + _date.
      sendEnrollmentEmail: process.env.HS_DEAL_SEND_ENROLLMENT_EMAIL_PROP || 'send_enrollment_email',
      enrollmentEmailSent: process.env.HS_DEAL_ENROLLMENT_EMAIL_SENT_PROP || 'enrollment_email_sent',
      enrollmentEmailSentDate: process.env.HS_DEAL_ENROLLMENT_EMAIL_SENT_DATE_PROP || 'enrollment_email_sent_date',
    },
    company: {
      status: process.env.HS_COMPANY_STATUS_PROP || 'partner_status',
      // Legacy ID used by Session Card for session lookup (maps to PostgreSQL companies.access_id)
      programId: process.env.HS_COMPANY_PROGRAM_ID_PROP || 'programid',
    },
  },

  // Pipeline stage configuration
  // Stage IDs from the "Deal Pipeline" (pipeline ID: "default")
  // Note: in the active pipeline, `decisionmakerboughtin` ("Program Selected")
  // is the closed-won terminal state — `hs_is_closed_won` is true on those deals.
  // The historic ID `1282918770` previously stored under `closedWon` belongs to
  // the "Historic 2015-2025" pipeline and is not used by current code.
  stages: {
    newLead: process.env.HS_STAGE_NEW_LEAD || 'appointmentscheduled',
    introCallCompleted: process.env.HS_STAGE_INTRO_CALL || 'qualifiedtobuy',
    // Tier 1 de-selection rollback target / clone landing stage when referrals carry over
    recommendationPresented: process.env.HS_STAGE_RECOMMENDATION_PRESENTED || 'presentationscheduled',
    tuitionUndecided: process.env.HS_STAGE_TUITION_UNDECIDED || '1282923123',
    programSelected: process.env.HS_STAGE_PROGRAM_SELECTED || 'decisionmakerboughtin',
    closedLost: process.env.HS_STAGE_CLOSED_LOST || 'closedlost',
  },

  // Default enum values
  defaults: {
    // Stamped on referrals copied to a clone (Closed Lost → next year). These
    // MUST be exact option values for this portal's referral_status /
    // client_interest properties — the earlier snake_case values 400'd with
    // INVALID_OPTION. Copied referrals default to "already sent" (the new
    // year's outreach hasn't happened yet) and "active / considering".
    // "Don’t" uses a curly apostrophe (U+2019) — the literal option value.
    referralStatus: process.env.HS_REFERRAL_CLONE_STATUS || 'Don’t send (already sent)',
    clientInterest: process.env.HS_REFERRAL_CLONE_INTEREST || 'Active / considering',
    // Value written to sibling referrals when one program is Selected
    // (item 5): they drop off the active list but keep their associations.
    // Capitalized to match how the saga writes the "Selected" value.
    clientInterestDeclined: process.env.HS_REFERRAL_INTEREST_DECLINED_VALUE || 'Declined',
  },

  // Admin alerting (item 7). When a pipeline action fails we email the
  // admin via Resend; if RESEND_API_KEY isn't configured we fall back to
  // creating a HubSpot task assigned to the admin owner with an immediate
  // reminder (which generates an email).
  notifications: {
    adminEmail: process.env.ALERT_ADMIN_EMAIL || 'riley@campexperts.com',
    resendApiKey: process.env.RESEND_API_KEY || '',
    resendFrom: process.env.ALERT_FROM_EMAIL || 'alerts@campexperts.com',
    // Riley McDonough's HubSpot owner id in portal 50530609 (fallback task assignee).
    adminOwnerId: process.env.ALERT_ADMIN_OWNER_ID || '83628479',
    portalId: process.env.HS_PORTAL_ID || '50530609',
  },

  // Memo builder — generates a client-facing Word doc of camp recommendations
  // from the deal's associated companies (camps), using Claude to compose the
  // narrative from each camp's write-up + structured session data.
  memo: {
    // Anthropic API key (set in Vercel). When unset, the generate-memo route
    // returns a clear error instead of attempting the call.
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    // Claude model used to compose the memo. Defaults to Opus for prose
    // quality — memo generation is asynchronous now (job + poll), so the old
    // HubSpot-fetch gateway timeout no longer constrains the model. Override
    // with MEMO_MODEL=claude-sonnet-4-6 if you want lower latency.
    model: process.env.MEMO_MODEL || 'claude-opus-4-8',
    // Reasoning effort for the composer. 'medium' keeps Opus comfortably under
    // the function's maxDuration for multi-camp memos while still producing
    // strong prose; bump to 'high' if you accept the extra latency.
    effort: process.env.MEMO_EFFORT || 'medium',
    // Per-camp narrative character cap fed to the model (0 = no cap). Bounds the
    // prompt for multi-camp memos. Raised to 6000 so the model sees enough of
    // each write-up to draw the camp's real, specific character (the textures
    // that make the voice land), not just the opening. Input tokens are cheap;
    // generation time is driven by output, which is short here.
    writeupCharCap: Number(process.env.MEMO_WRITEUP_CHAR_CAP || '6000'),
    // Where the generated .docx is delivered. We upload to HubSpot Files and
    // attach to the deal via a note engagement. This folder path is created
    // lazily by the Files API on first upload.
    filesFolderPath: process.env.MEMO_FILES_FOLDER || 'camp-recommendation-memos',
    // Write-up source selector: 'seed' reads the committed data/writeups.json
    // (default — zero runtime setup); 'db' reads a camp_writeups table from the
    // session Postgres; 'auto' tries db then falls back to seed.
    writeupSource: process.env.MEMO_WRITEUP_SOURCE || 'seed',
  },
} as const;

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate that required configuration is present
 */
export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.hubspot.accessToken) {
    errors.push('HUBSPOT_ACCESS_TOKEN environment variable is required');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// Type Exports
// ============================================================================

export type Config = typeof config;
export type ObjectTypes = typeof config.objectTypes;
export type ReferralProperties = typeof config.properties.referral;
