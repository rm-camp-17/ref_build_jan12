// Environment configuration for HubSpot integration
export const config = {
  hubspot: {
    accessToken: process.env.HUBSPOT_ACCESS_TOKEN || '',
  },
  objectTypes: {
    program: process.env.HS_PROGRAM_OBJECT_TYPE || 'p_program',
    session: process.env.HS_SESSION_OBJECT_TYPE || 'p_session',
    referral: process.env.HS_REFERRAL_OBJECT_TYPE || 'p_referral',
  },
  properties: {
    referral: {
      key: process.env.HS_REFERRAL_KEY_PROP || 'referral_key',
      outreach: process.env.HS_REFERRAL_OUTREACH_PROP || 'referral_status',
      interest: process.env.HS_REFERRAL_INTEREST_PROP || 'client_interest',
      note: process.env.HS_REFERRAL_NOTE_PROP || 'referral_note_to_company',
      previouslySent: process.env.HS_REFERRAL_PREVIOUSLY_SENT_PROP || 'previously_sent_to_camp',
      name: process.env.HS_REFERRAL_NAME_PROP || 'referral_name',
      copiedDealKey: process.env.HS_REFERRAL_COPIED_DEAL_KEY_PROP || 'copied_from_deal_key',
      copiedYear: process.env.HS_REFERRAL_COPIED_YEAR_PROP || 'copied_from_year',
    },
    deal: {
      key: process.env.HS_DEAL_KEY_PROP || 'deal_key',
      year: process.env.HS_DEAL_YEAR_PROP || 'deal_year',
    },
  },
};
