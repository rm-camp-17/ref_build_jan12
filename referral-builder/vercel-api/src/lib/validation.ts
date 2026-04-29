/**
 * Validation module for Referral Builder
 * Provides input validation and canonical payload building
 */

import { config } from './config';
import { dualWriteReferralProperty } from './property-aliases';

// ============================================================================
// Types
// ============================================================================

export interface CreateReferralInput {
  dealId: string;
  companyId: string;
  note?: string;
  outreachStatus?: string;
  clientInterest?: string;
  copiedFromDealKey?: string;   // Set only if copied from prior-year deal
  copiedFromYear?: number;      // Set only if copiedFromDealKey is set
  associateDealToCompany?: boolean;
}

export interface ValidationResult<T> {
  valid: boolean;
  data?: T;
  errors?: string[];
}

export interface ReferralPayload {
  properties: Record<string, string>;
  referralKey: string;
}

// ============================================================================
// Default Values (Source of Truth)
// ============================================================================

export const DEFAULTS = {
  // Referral status default: "Ready to Send"
  // NOTE: HubSpot properties use labels as values (e.g., "Ready to Send" not "ready_to_send")
  REFERRAL_STATUS: 'Ready to Send',
  // Client interest default: "Active / considering"
  CLIENT_INTEREST: 'Active / considering',
} as const;

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate a HubSpot object ID (should be numeric string)
 */
function isValidObjectId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (!id.trim()) return false;
  // HubSpot IDs are numeric
  return /^\d+$/.test(id.trim());
}

/**
 * Validate CreateReferral input
 * Returns validation result with cleaned data or errors
 */
export function validateCreateReferralInput(
  input: unknown
): ValidationResult<CreateReferralInput> {
  const errors: string[] = [];

  if (!input || typeof input !== 'object') {
    return { valid: false, errors: ['Invalid input: expected object'] };
  }

  const data = input as Record<string, unknown>;

  // Required fields
  if (!isValidObjectId(data.dealId)) {
    errors.push('dealId is required and must be a valid HubSpot ID');
  }

  if (!isValidObjectId(data.companyId)) {
    errors.push('companyId is required and must be a valid HubSpot ID');
  }

  // Validate copied fields - copiedFromYear only valid if copiedFromDealKey is set
  let copiedFromDealKey: string | undefined;
  let copiedFromYear: number | undefined;
  if (data.copiedFromDealKey && typeof data.copiedFromDealKey === 'string') {
    copiedFromDealKey = data.copiedFromDealKey.trim();
    if (data.copiedFromYear !== undefined && data.copiedFromYear !== null) {
      const year = Number(data.copiedFromYear);
      if (!isNaN(year) && year > 2000 && year < 2100) {
        copiedFromYear = year;
      }
    }
  }

  // Enum fields: Accept any string value
  // HubSpot will validate against its configured options when creating/updating
  // We don't validate enum values here because they can vary (labels vs internal values)

  // Note is optional, sanitize if provided
  const note = typeof data.note === 'string' ? data.note.trim() : '';

  // associateDealToCompany is optional boolean
  const associateDealToCompany = data.associateDealToCompany === true;

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Build validated input
  const validatedInput: CreateReferralInput = {
    dealId: String(data.dealId).trim(),
    companyId: String(data.companyId).trim(),
    note: note || undefined,
    outreachStatus: data.outreachStatus ? String(data.outreachStatus) : undefined,
    clientInterest: data.clientInterest ? String(data.clientInterest) : undefined,
    copiedFromDealKey,
    copiedFromYear,
    associateDealToCompany,
  };

  return { valid: true, data: validatedInput };
}

// ============================================================================
// Payload Builder
// ============================================================================

/**
 * Build canonical Referral create payload
 * Uses internal property names and applies defaults
 *
 * NOTE: This builds the base properties. Additional computed properties
 * (company_name, hubspot_owner_id, resend_requested) are added by the
 * workflow after fetching related data.
 */
export function buildReferralPayload(input: CreateReferralInput): ReferralPayload {
  const referralKey = `${input.dealId}-${input.companyId}`;

  // Build properties using config property names. Status + interest are
  // dual-written to canonical + legacy names — see PROPERTY_NAME_AUDIT.md.
  const properties: Record<string, string> = {
    // Key for upsert lookup
    [config.properties.referral.key]: referralKey,
    // Display name
    [config.properties.referral.name]: `Referral for Deal ${input.dealId}`,
    // Status (dual-write)
    ...dualWriteReferralProperty('outreach', input.outreachStatus || DEFAULTS.REFERRAL_STATUS),
    // Interest (dual-write)
    ...dualWriteReferralProperty('interest', input.clientInterest || DEFAULTS.CLIENT_INTEREST),
    // Note (empty string if not provided)
    [config.properties.referral.note]: input.note || '',
  };

  // Add copied_from fields only if copied from prior-year deal
  if (input.copiedFromDealKey) {
    properties[config.properties.referral.copiedDealKey] = input.copiedFromDealKey;
    if (input.copiedFromYear) {
      properties[config.properties.referral.copiedYear] = String(input.copiedFromYear);
    }
  }

  return {
    properties,
    referralKey,
  };
}

/**
 * Validate update referral input
 */
export function validateUpdateReferralInput(
  input: unknown
): ValidationResult<{ properties: Record<string, string> }> {
  const errors: string[] = [];

  if (!input || typeof input !== 'object') {
    return { valid: false, errors: ['Invalid input: expected object'] };
  }

  const data = input as Record<string, unknown>;

  if (!data.properties || typeof data.properties !== 'object') {
    return { valid: false, errors: ['properties object is required'] };
  }

  const props = data.properties as Record<string, unknown>;
  const cleanedProps: Record<string, string> = {};

  // Validate each property if provided. Status + interest accept either the
  // canonical or legacy name from the client — we expand to dual-write below.
  const statusCanonical = config.properties.referral.outreachCanonical;
  const statusLegacy = config.properties.referral.outreach;
  const interestCanonical = config.properties.referral.interestCanonical;
  const interestLegacy = config.properties.referral.interest;
  const noteProp = config.properties.referral.note;

  // Accept either name on the wire, expand to both names on disk.
  const incomingStatus =
    props[statusCanonical] !== undefined
      ? props[statusCanonical]
      : props[statusLegacy];
  if (incomingStatus !== undefined) {
    Object.assign(cleanedProps, dualWriteReferralProperty('outreach', String(incomingStatus)));
  }

  const incomingInterest =
    props[interestCanonical] !== undefined
      ? props[interestCanonical]
      : props[interestLegacy];
  if (incomingInterest !== undefined) {
    Object.assign(cleanedProps, dualWriteReferralProperty('interest', String(incomingInterest)));
  }

  if (props[noteProp] !== undefined) {
    cleanedProps[noteProp] = String(props[noteProp]);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data: { properties: cleanedProps } };
}
