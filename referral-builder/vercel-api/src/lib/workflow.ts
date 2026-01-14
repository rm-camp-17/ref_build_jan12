/**
 * CreateReferralWorkflow - Single entry point for referral creation
 *
 * This module orchestrates the complete referral creation flow:
 * 1. Validate inputs
 * 2. Build canonical payload with defaults
 * 3. Search for existing referral (upsert logic)
 * 4. Create or update referral
 * 5. Create all associations (idempotent)
 * 6. Optionally associate Deal ↔ Company
 * 7. Return structured result
 *
 * HubSpot Platform Version 2025.02 compatible
 */

import { hubspotClient } from './hubspot';
import { config } from './config';
import {
  validateCreateReferralInput,
  buildReferralPayload,
  CreateReferralInput,
} from './validation';
import {
  createAssociationsBatch,
  AssociationSpec,
  getAssociatedIds,
} from './associations';

// ============================================================================
// Types
// ============================================================================

export interface WorkflowResult {
  success: boolean;
  referralId?: string;
  created?: boolean;
  updated?: boolean;
  associationsCreated?: number;
  associationsFailed?: number;
  dealCompanyAssociated?: boolean;
  errors?: string[];
  validationErrors?: string[];
}

interface CreateOrUpdateResult {
  referralId: string;
  created: boolean;
}

// ============================================================================
// Internal Helper Functions
// ============================================================================

/**
 * Fetch company name by ID
 */
async function fetchCompanyName(companyId: string): Promise<string | null> {
  try {
    const result = await hubspotClient.crm.companies.basicApi.getById(companyId, ['name']);
    return result.properties?.name || null;
  } catch (error: any) {
    console.warn(`[workflow] Failed to fetch company name for ${companyId}:`, error.message);
    return null;
  }
}

/**
 * Fetch session details by ID
 */
async function fetchSessionDetails(sessionId: string): Promise<{
  startDate?: string;
  endDate?: string;
  price?: string;
  weeks?: string;
} | null> {
  try {
    const sessionProps = [
      config.properties.session.startDate,
      config.properties.session.endDate,
      config.properties.session.price,
      config.properties.session.weeks,
    ];

    const result = await hubspotClient.crm.objects.basicApi.getById(
      config.objectTypes.session,
      sessionId,
      sessionProps
    );

    return {
      startDate: result.properties?.[config.properties.session.startDate] || undefined,
      endDate: result.properties?.[config.properties.session.endDate] || undefined,
      price: result.properties?.[config.properties.session.price] || undefined,
      weeks: result.properties?.[config.properties.session.weeks] || undefined,
    };
  } catch (error: any) {
    console.warn(`[workflow] Failed to fetch session details for ${sessionId}:`, error.message);
    return null;
  }
}

/**
 * Search for existing referral by key
 */
async function findExistingReferral(referralKey: string): Promise<string | null> {
  try {
    const searchResult = await hubspotClient.crm.objects.searchApi.doSearch(
      config.objectTypes.referral,
      {
        filterGroups: [
          {
            filters: [
              {
                propertyName: config.properties.referral.key,
                operator: 'EQ' as any,
                value: referralKey,
              },
            ],
          },
        ],
        properties: [config.properties.referral.key],
        sorts: [],
        after: '0',
        limit: 1,
      }
    );

    if (searchResult.results && searchResult.results.length > 0) {
      return searchResult.results[0].id;
    }

    return null;
  } catch (error: any) {
    console.error('[workflow] Error searching for referral:', error.message);
    throw new Error(`Failed to search for existing referral: ${error.message}`);
  }
}

/**
 * Create or update referral
 */
async function createOrUpdateReferral(
  payload: ReturnType<typeof buildReferralPayload>
): Promise<CreateOrUpdateResult> {
  const existingId = await findExistingReferral(payload.referralKey);

  if (existingId) {
    // Update existing
    await hubspotClient.crm.objects.basicApi.update(
      config.objectTypes.referral,
      existingId,
      { properties: payload.properties }
    );
    console.log(`[workflow] Updated referral: ${existingId}`);
    return { referralId: existingId, created: false };
  }

  // Create new
  const createResult = await hubspotClient.crm.objects.basicApi.create(
    config.objectTypes.referral,
    { properties: payload.properties, associations: [] }
  );
  console.log(`[workflow] Created referral: ${createResult.id}`);
  return { referralId: createResult.id, created: true };
}

/**
 * Build list of associations to create
 */
function buildAssociationSpecs(
  referralId: string,
  input: CreateReferralInput
): AssociationSpec[] {
  const specs: AssociationSpec[] = [];

  // Always: Referral ↔ Deal
  specs.push({
    fromId: referralId,
    fromType: config.objectTypes.referral,
    toId: input.dealId,
    toType: 'deals',
  });

  // Always: Referral ↔ Company
  specs.push({
    fromId: referralId,
    fromType: config.objectTypes.referral,
    toId: input.companyId,
    toType: 'companies',
  });

  // Optional: Referral ↔ Program
  if (input.programId) {
    specs.push({
      fromId: referralId,
      fromType: config.objectTypes.referral,
      toId: input.programId,
      toType: config.objectTypes.program,
    });
  }

  // Optional: Referral ↔ Session
  if (input.sessionId) {
    specs.push({
      fromId: referralId,
      fromType: config.objectTypes.referral,
      toId: input.sessionId,
      toType: config.objectTypes.session,
    });
  }

  return specs;
}

/**
 * Check if deal already has an associated company
 */
async function dealHasCompany(dealId: string): Promise<boolean> {
  const companyIds = await getAssociatedIds('deals', dealId, 'companies');
  return companyIds.length > 0;
}

// ============================================================================
// Main Workflow Function
// ============================================================================

/**
 * Create Referral Workflow
 *
 * Single entry point that:
 * 1. Validates input
 * 2. Builds canonical payload with defaults
 * 3. Creates or updates referral (upsert)
 * 4. Creates all associations (idempotent)
 * 5. Optionally associates Deal ↔ Company
 * 6. Returns structured result
 *
 * @param rawInput - Raw input from API request
 * @returns WorkflowResult with success status and details
 */
export async function createReferralWorkflow(
  rawInput: unknown
): Promise<WorkflowResult> {
  const errors: string[] = [];

  // Step 1: Validate input
  const validation = validateCreateReferralInput(rawInput);
  if (!validation.valid || !validation.data) {
    return {
      success: false,
      validationErrors: validation.errors,
    };
  }

  const input = validation.data;
  console.log(`[workflow] Starting referral creation for deal ${input.dealId} → company ${input.companyId}`);

  // Step 2: Fetch company and session details to enrich the referral
  console.log(`[workflow] Fetching company name and session details...`);

  // Fetch company name
  const companyName = await fetchCompanyName(input.companyId);
  if (companyName) {
    input.companyName = companyName;
    console.log(`[workflow] Company name: ${companyName}`);
  }

  // Fetch session details if sessionId is provided
  if (input.sessionId) {
    const sessionDetails = await fetchSessionDetails(input.sessionId);
    if (sessionDetails) {
      input.sessionStartDate = sessionDetails.startDate;
      input.sessionEndDate = sessionDetails.endDate;
      input.sessionPrice = sessionDetails.price;
      input.sessionWeeks = sessionDetails.weeks;
      console.log(`[workflow] Session details:`, sessionDetails);
    }
  }

  // Step 3: Build canonical payload
  const payload = buildReferralPayload(input);

  // Step 4: Create or update referral
  let referralId: string;
  let created: boolean;

  try {
    const result = await createOrUpdateReferral(payload);
    referralId = result.referralId;
    created = result.created;
  } catch (error: any) {
    console.error('[workflow] Failed to create/update referral:', error.message);
    return {
      success: false,
      errors: [`Failed to create referral: ${error.message}`],
    };
  }

  // Step 5: Create associations (idempotent)
  const associationSpecs = buildAssociationSpecs(referralId, input);
  const associationResult = await createAssociationsBatch(associationSpecs);

  if (associationResult.failed.length > 0) {
    for (const failure of associationResult.failed) {
      errors.push(failure.error);
    }
    // Log but don't fail the entire workflow for association errors
    console.warn('[workflow] Some associations failed:', associationResult.failed);
  }

  // Step 6: Optionally associate Deal ↔ Company
  let dealCompanyAssociated = false;

  if (input.associateDealToCompany) {
    // Check if deal already has a company
    const hasCompany = await dealHasCompany(input.dealId);

    if (!hasCompany) {
      const dealCompanyResult = await createAssociationsBatch([
        {
          fromId: input.dealId,
          fromType: 'deals',
          toId: input.companyId,
          toType: 'companies',
        },
      ]);

      if (dealCompanyResult.allSucceeded) {
        dealCompanyAssociated = true;
        console.log(`[workflow] Created Deal ↔ Company association: ${input.dealId} ↔ ${input.companyId}`);
      } else {
        errors.push('Failed to associate deal with company');
      }
    } else {
      console.log(`[workflow] Deal ${input.dealId} already has associated company, skipping`);
    }
  }

  // Step 7: Return structured result
  return {
    success: true,
    referralId,
    created,
    updated: !created,
    associationsCreated: associationResult.successful.length,
    associationsFailed: associationResult.failed.length,
    dealCompanyAssociated,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// ============================================================================
// Update Workflow
// ============================================================================

export interface UpdateReferralInput {
  referralId: string;
  properties: Record<string, string>;
}

export interface UpdateWorkflowResult {
  success: boolean;
  errors?: string[];
}

/**
 * Update Referral Workflow
 *
 * Updates an existing referral's properties
 */
export async function updateReferralWorkflow(
  referralId: string,
  properties: Record<string, string>
): Promise<UpdateWorkflowResult> {
  if (!referralId || !/^\d+$/.test(referralId)) {
    return {
      success: false,
      errors: ['Invalid referral ID'],
    };
  }

  if (!properties || Object.keys(properties).length === 0) {
    return {
      success: false,
      errors: ['No properties to update'],
    };
  }

  try {
    await hubspotClient.crm.objects.basicApi.update(
      config.objectTypes.referral,
      referralId,
      { properties }
    );

    console.log(`[workflow] Updated referral ${referralId}:`, Object.keys(properties));
    return { success: true };
  } catch (error: any) {
    console.error(`[workflow] Failed to update referral ${referralId}:`, error.message);
    return {
      success: false,
      errors: [`Failed to update referral: ${error.message}`],
    };
  }
}
