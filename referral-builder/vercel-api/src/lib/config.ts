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

  // Default enum values (internal values, not labels)
  defaults: {
    referralStatus: 'ready_to_send',
    clientInterest: 'active_considering',
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
