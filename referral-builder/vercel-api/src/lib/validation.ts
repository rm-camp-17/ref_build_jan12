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
  // Referral status default: "Ready to send"
  REFERRAL_STATUS: 'ready_to_send',
  // Client interest default: "Active / considering"
  CLIENT_INTEREST: 'active_considering',
} as const;

// Valid internal values for enumeration properties
// These should match what's configured in HubSpot
export const VALID_STATUS_VALUES = [
  'draft',
  'ready_to_send',
  'sent',
  'resend',
  'dont_send',
] as const;

export const VALID_INTEREST_VALUES = [
  'active_considering',
  'shortlist',
  'neutral',
  'unlikely',
  'declined',
  'selected',
] as const;

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
 * Validate an enumeration value
 */
function isValidEnumValue(value: unknown, validValues: readonly string[]): boolean {
  if (typeof value !== 'string') return false;
  return validValues.includes(value);
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

  // Validate enum fields if provided (otherwise defaults will be used)
  if (data.outreachStatus !== undefined && data.outreachStatus !== null && data.outreachStatus !== '') {
    if (!isValidEnumValue(data.outreachStatus, VALID_STATUS_VALUES)) {
      errors.push(
        `outreachStatus must be one of: ${VALID_STATUS_VALUES.join(', ')}`
      );
    }
  }

  if (data.clientInterest !== undefined && data.clientInterest !== null && data.clientInterest !== '') {
    if (!isValidEnumValue(data.clientInterest, VALID_INTEREST_VALUES)) {
      errors.push(
        `clientInterest must be one of: ${VALID_INTEREST_VALUES.join(', ')}`
      );
    }
  }

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

  if (props[statusProp] !== undefined) {
    const val = String(props[statusProp]);
    if (val && !isValidEnumValue(val, VALID_STATUS_VALUES)) {
      errors.push(`${statusProp} must be one of: ${VALID_STATUS_VALUES.join(', ')}`);
    } else {
      cleanedProps[statusProp] = val;
    }
  }

  if (props[interestProp] !== undefined) {
    const val = String(props[interestProp]);
    if (val && !isValidEnumValue(val, VALID_INTEREST_VALUES)) {
      errors.push(`${interestProp} must be one of: ${VALID_INTEREST_VALUES.join(', ')}`);
    } else {
      cleanedProps[interestProp] = val;
    }
  }

  if (props[noteProp] !== undefined) {
    cleanedProps[noteProp] = String(props[noteProp]);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data: { properties: cleanedProps } };
}
