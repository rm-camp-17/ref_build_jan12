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
  objectTypes: {
    program: process.env.HS_PROGRAM_OBJECT_TYPE || 'p_program',
    session: process.env.HS_SESSION_OBJECT_TYPE || 'p_session',
    referral: process.env.HS_REFERRAL_OBJECT_TYPE || '2-55790899',
  },

  // Property internal names by object type
  properties: {
    referral: {
      // Primary key for upsert (dealId-companyId)
      key: process.env.HS_REFERRAL_KEY_PROP || 'referral_key',
      // Display name
      name: process.env.HS_REFERRAL_NAME_PROP || 'referral_name',
      // Status dropdown (enum) - property name: referral_status, label: referral_outreach_status
      outreach: process.env.HS_REFERRAL_OUTREACH_PROP || 'referral_outreach_status',
      // Interest dropdown (enum) - property name: client_interest, label: referral_client_interest
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
      year: process.env.HS_DEAL_YEAR_PROP || 'deal_year',
      name: process.env.HS_DEAL_NAME_PROP || 'dealname', // Usually contains child's name
    },
    company: {
      status: process.env.HS_COMPANY_STATUS_PROP || 'partner_status',
    },
    program: {
      name: process.env.HS_PROGRAM_NAME_PROP || 'name',
    },
    session: {
      name: process.env.HS_SESSION_NAME_PROP || 'name',
      startDate: process.env.HS_SESSION_START_PROP || 'start_date',
      endDate: process.env.HS_SESSION_END_PROP || 'end_date',
      price: process.env.HS_SESSION_PRICE_PROP || 'price',
      weeks: process.env.HS_SESSION_WEEKS_PROP || 'weeks',
    },
  },

  // Default enum values (internal values, not labels)
  defaults: {
    referralStatus: 'ready_to_send',
    clientInterest: 'active_considering',
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
