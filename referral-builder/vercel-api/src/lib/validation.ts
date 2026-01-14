/**
 * Validation module for Referral Builder
 * Provides input validation and canonical payload building
 */

import { config } from './config';

// ============================================================================
// Types
// ============================================================================

export interface CreateReferralInput {
  dealId: string;
  companyId: string;
  programId?: string;
  sessionId?: string;
  note?: string;
  outreachStatus?: string;
  clientInterest?: string;
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

  // Optional ID fields (must be valid if provided)
  if (data.programId !== undefined && data.programId !== null && data.programId !== '') {
    if (!isValidObjectId(data.programId)) {
      errors.push('programId must be a valid HubSpot ID if provided');
    }
  }

  if (data.sessionId !== undefined && data.sessionId !== null && data.sessionId !== '') {
    if (!isValidObjectId(data.sessionId)) {
      errors.push('sessionId must be a valid HubSpot ID if provided');
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
    programId: data.programId ? String(data.programId).trim() : undefined,
    sessionId: data.sessionId ? String(data.sessionId).trim() : undefined,
    note: note || undefined,
    outreachStatus: data.outreachStatus ? String(data.outreachStatus) : undefined,
    clientInterest: data.clientInterest ? String(data.clientInterest) : undefined,
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
 */
export function buildReferralPayload(input: CreateReferralInput): ReferralPayload {
  const referralKey = `${input.dealId}-${input.companyId}`;

  // Build properties using config property names
  const properties: Record<string, string> = {
    // Key for upsert lookup
    [config.properties.referral.key]: referralKey,
    // Display name
    [config.properties.referral.name]: `Referral for Deal ${input.dealId}`,
    // Status with default
    [config.properties.referral.outreach]: input.outreachStatus || DEFAULTS.REFERRAL_STATUS,
    // Interest with default
    [config.properties.referral.interest]: input.clientInterest || DEFAULTS.CLIENT_INTEREST,
    // Note (empty string if not provided)
    [config.properties.referral.note]: input.note || '',
  };

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

  // Validate each property if provided
  const statusProp = config.properties.referral.outreach;
  const interestProp = config.properties.referral.interest;
  const noteProp = config.properties.referral.note;

  // Accept any string values for enum properties
  // HubSpot will validate against its configured options
  if (props[statusProp] !== undefined) {
    cleanedProps[statusProp] = String(props[statusProp]);
  }

  if (props[interestProp] !== undefined) {
    cleanedProps[interestProp] = String(props[interestProp]);
  }

  if (props[noteProp] !== undefined) {
    cleanedProps[noteProp] = String(props[noteProp]);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data: { properties: cleanedProps } };
}
