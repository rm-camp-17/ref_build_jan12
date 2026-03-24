/**
 * CreateReferralWorkflow - Single entry point for referral creation
 *
 * This module orchestrates the complete referral creation flow:
 * 1. Validate inputs
 * 2. Fetch Deal (to get hubspot_owner_id)
 * 3. Build canonical payload with defaults + computed fields
 * 4. Search for existing referral (upsert logic)
 * 5. Create or update referral (with retry for read-only properties)
 * 6. Create all associations (idempotent)
 *    - Referral ↔ Deal
 *    - Referral ↔ Company (with "Recommendation" or "Selected_Referral" label)
 *    - Deal ↔ Company (always created when referral is created)
 *    - Referral ↔ Program (optional)
 *    - Referral ↔ Sessions (optional, supports multiple)
 * 7. Return structured result
 *
 * Association Labels:
 * - "Recommendation": Default label for Referral ↔ Company associations
 * - "Selected_Referral": Label for Referral ↔ Company when client_interest == "Selected"
 *
 * Computed fields set by this workflow:
 * - hubspot_owner_id: from Deal.hubspot_owner_id
 * - resend_requested: true if referral_outreach_status == "Resend"
 * - selected_session_start_date, selected_session_end_date, selected_session_price:
 *   Only set when client_interest == "Selected" AND selectedBillingSessionId is provided
 *
 * Note: company_name is a calculated property in HubSpot (auto-populated from
 * the associated Company), so we don't set it here.
 *
 * Note: If HubSpot returns READ_ONLY_VALUE errors for any properties, we
 * automatically remove them and retry.
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
 * Fetch Deal to get owner ID, name, and other properties
 */
async function fetchDealData(dealId: string): Promise<{
  ownerId?: string;
  dealKey?: string;
  dealName?: string;
  year?: string;
}> {
  try {
    const deal = await hubspotClient.crm.deals.basicApi.getById(dealId, [
      'hubspot_owner_id',
      config.properties.deal.key,
      config.properties.deal.year,
      config.properties.deal.name,
      'dealname', // Standard HubSpot deal name property
    ]);
    return {
      ownerId: deal.properties.hubspot_owner_id || undefined,
      dealKey: deal.properties[config.properties.deal.key] || undefined,
      dealName: deal.properties[config.properties.deal.name] || deal.properties.dealname || undefined,
      year: deal.properties[config.properties.deal.year] || undefined,
    };
  } catch (error: any) {
    console.error(`[workflow] Failed to fetch deal ${dealId}:`, error.message);
    // Return empty - don't fail the workflow for this
    return {};
  }
}

/**
 * Build referral display name: "Child Name & Company Name - Date"
 */
function buildReferralName(dealName?: string, companyName?: string): string {
  const today = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const parts: string[] = [];
  if (dealName) parts.push(dealName);
  if (companyName) parts.push(companyName);

  if (parts.length === 0) {
    return `Referral - ${today}`;
  }
  return `${parts.join(' & ')} - ${today}`;
}

/**
 * Fetch Company to get name
 */
async function fetchCompanyName(companyId: string): Promise<string | undefined> {
  try {
    const company = await hubspotClient.crm.companies.basicApi.getById(companyId, ['name']);
    return company.properties.name || undefined;
  } catch (error: any) {
    console.error(`[workflow] Failed to fetch company ${companyId}:`, error.message);
    return undefined;
  }
}

/**
 * Fetch Session data for billing session fields
 */
async function fetchSessionData(sessionId: string): Promise<{
  startDate?: string;
  endDate?: string;
  price?: string;
} | null> {
  try {
    const session = await hubspotClient.crm.objects.basicApi.getById(
      config.objectTypes.session,
      sessionId,
      [
        config.properties.session.startDate,
        config.properties.session.endDate,
        config.properties.session.price,
      ]
    );
    return {
      startDate: session.properties[config.properties.session.startDate] || undefined,
      endDate: session.properties[config.properties.session.endDate] || undefined,
      price: session.properties[config.properties.session.price] || undefined,
    };
  } catch (error: any) {
    console.error(`[workflow] Failed to fetch session ${sessionId}:`, error.message);
    return null;
  }
}

/**
 * Check if outreach status indicates resend is requested
 */
function isResendRequested(outreachStatus: string | undefined): boolean {
  if (!outreachStatus) return false;
  // Match "Resend" case-insensitively
  return outreachStatus.toLowerCase() === 'resend';
}

/**
 * Check if client interest is "Selected"
 */
function isClientInterestSelected(clientInterest: string | undefined): boolean {
  if (!clientInterest) return false;
  return clientInterest.toLowerCase() === 'selected';
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
 * Extract read-only property names from HubSpot error response
 */
function extractReadOnlyProperties(error: any): string[] {
  const readOnlyProps: string[] = [];

  // Try to parse the error body
  const body = error?.body || error?.response?.body;
  if (!body) return readOnlyProps;

  // Check for errors array
  const errors = body.errors || [];
  for (const err of errors) {
    if (err.code === 'READ_ONLY_VALUE' && err.context?.propertyName) {
      const propNames = err.context.propertyName;
      if (Array.isArray(propNames)) {
        readOnlyProps.push(...propNames);
      } else if (typeof propNames === 'string') {
        readOnlyProps.push(propNames);
      }
    }
  }

  return readOnlyProps;
}

/**
 * Create or update referral with retry for read-only properties
 *
 * If HubSpot returns READ_ONLY_VALUE errors, we remove those properties
 * and retry (they're likely calculated properties in HubSpot).
 */
async function createOrUpdateReferral(
  payload: ReturnType<typeof buildReferralPayload>
): Promise<CreateOrUpdateResult> {
  const existingId = await findExistingReferral(payload.referralKey);

  // Properties to use (may be filtered on retry)
  let properties = { ...payload.properties };

  // Allow up to 2 retries for read-only property errors
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (existingId) {
        // Update existing
        await hubspotClient.crm.objects.basicApi.update(
          config.objectTypes.referral,
          existingId,
          { properties }
        );
        console.log(`[workflow] Updated referral: ${existingId}`);
        return { referralId: existingId, created: false };
      }

      // Create new
      const createResult = await hubspotClient.crm.objects.basicApi.create(
        config.objectTypes.referral,
        { properties, associations: [] }
      );
      console.log(`[workflow] Created referral: ${createResult.id}`);
      return { referralId: createResult.id, created: true };
    } catch (error: any) {
      // Check if this is a read-only property error
      const readOnlyProps = extractReadOnlyProperties(error);

      if (readOnlyProps.length > 0 && attempt < 2) {
        // Remove read-only properties and retry
        console.warn(
          `[workflow] Removing read-only properties and retrying:`,
          readOnlyProps
        );
        for (const prop of readOnlyProps) {
          delete properties[prop];
        }
        continue; // Retry with filtered properties
      }

      // Re-throw if not a read-only error or out of retries
      throw error;
    }
  }

  // Should not reach here, but TypeScript needs this
  throw new Error('Unexpected: exhausted retries without success or error');
}

/**
 * Build list of associations to create
 *
 * Supports:
 * - Deal ↔ Company (always created when referral is created)
 * - Multiple sessions (sessionIds array)
 * - Association labels:
 *   - "Recommendation" for Referral ↔ Company (default)
 *   - "Selected_Referral" for Referral ↔ Company when client_interest == "Selected"
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

  // Always: Referral ↔ Company with appropriate label
  // Use "Selected_Referral" label when client_interest is "Selected", otherwise "Recommendation"
  const companyLabel = isClientInterestSelected(input.clientInterest)
    ? 'Selected_Referral'
    : 'Recommendation';

  specs.push({
    fromId: referralId,
    fromType: config.objectTypes.referral,
    toId: input.companyId,
    toType: 'companies',
    label: companyLabel,
  });

  // Always: Deal ↔ Company (idempotent - won't create duplicates)
  // Every referral should link its deal to its company
  specs.push({
    fromId: input.dealId,
    fromType: 'deals',
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

  // Collect all session IDs to associate
  const allSessionIds = new Set<string>();

  // Add sessions from sessionIds array
  if (input.sessionIds && input.sessionIds.length > 0) {
    for (const sid of input.sessionIds) {
      allSessionIds.add(sid);
    }
  }

  // Add single sessionId for backwards compatibility
  if (input.sessionId) {
    allSessionIds.add(input.sessionId);
  }

  // Create associations for all sessions
  // Use "Selected_Referral" label when client_interest is "Selected"
  const isSelected = isClientInterestSelected(input.clientInterest);
  for (const sessionId of allSessionIds) {
    specs.push({
      fromId: referralId,
      fromType: config.objectTypes.referral,
      toId: sessionId,
      toType: config.objectTypes.session,
      label: isSelected ? 'Selected_Referral' : undefined,
    });
  }

  return specs;
}

// ============================================================================
// Main Workflow Function
// ============================================================================

/**
 * Create Referral Workflow
 *
 * Single entry point that:
 * 1. Validates input
 * 2. Fetches Deal (for hubspot_owner_id)
 * 3. Builds canonical payload with defaults + computed fields
 * 4. Creates or updates referral (upsert) with retry for read-only properties
 * 5. Creates all associations (idempotent)
 * 6. Optionally associates Deal ↔ Company
 * 7. Returns structured result
 *
 * Computed fields set:
 * - hubspot_owner_id: from Deal.hubspot_owner_id
 * - resend_requested: true if referral_outreach_status == "Resend"
 * - selected_session_*: only when client_interest == "Selected" AND billing session set
 *
 * Note: company_name is calculated by HubSpot from the associated Company.
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

  // Step 2: Fetch Deal and Company data in parallel
  // Also fetch billing session data if needed
  const shouldFetchBillingSession =
    isClientInterestSelected(input.clientInterest) && input.selectedBillingSessionId;

  const [dealData, companyName, billingSessionData] = await Promise.all([
    fetchDealData(input.dealId),
    fetchCompanyName(input.companyId),
    shouldFetchBillingSession
      ? fetchSessionData(input.selectedBillingSessionId!)
      : Promise.resolve(null),
  ]);

  console.log(`[workflow] Fetched data - Deal owner: ${dealData.ownerId}, Company: ${companyName}, Session: ${billingSessionData ? 'yes' : 'no'}`);

  // Step 3: Build canonical payload with computed fields
  const payload = buildReferralPayload(input);

  // Add computed properties

  // referral_name - "Child Name & Company Name - Date"
  payload.properties[config.properties.referral.name] = buildReferralName(
    dealData.dealName,
    companyName
  );

  // NOTE: company_name is a calculated property in HubSpot - it's automatically
  // computed from the associated Company, so we don't set it here.

  // hubspot_owner_id - from Deal
  if (dealData.ownerId) {
    payload.properties[config.properties.referral.ownerId] = dealData.ownerId;
  }

  // copied_from_year - always set on every referral, floor at current year
  const currentYear = new Date().getFullYear();
  const dealYear = dealData.year ? parseInt(dealData.year, 10) : NaN;
  const referralYear = !isNaN(dealYear) && dealYear >= currentYear
    ? dealYear
    : input.copiedFromYear && input.copiedFromYear >= currentYear
    ? input.copiedFromYear
    : currentYear;
  payload.properties[config.properties.referral.copiedYear] = String(referralYear);

  // resend_requested - computed from outreach status
  const outreachStatus = input.outreachStatus || payload.properties[config.properties.referral.outreach];
  payload.properties[config.properties.referral.resendRequested] = isResendRequested(outreachStatus)
    ? 'true'
    : 'false';

  // selected_session_* fields - only if client_interest == "Selected" AND billing session provided
  if (isClientInterestSelected(input.clientInterest) && billingSessionData) {
    if (billingSessionData.startDate) {
      payload.properties[config.properties.referral.selectedSessionStartDate] = billingSessionData.startDate;
    }
    if (billingSessionData.endDate) {
      payload.properties[config.properties.referral.selectedSessionEndDate] = billingSessionData.endDate;
    }
    if (billingSessionData.price) {
      payload.properties[config.properties.referral.selectedSessionPrice] = billingSessionData.price;
    }
    console.log(`[workflow] Set selected session fields from billing session ${input.selectedBillingSessionId}`);
  }

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
  // This includes: Referral↔Deal, Referral↔Company (with label), Deal↔Company, Program, Sessions
  const associationSpecs = buildAssociationSpecs(referralId, input);
  const associationResult = await createAssociationsBatch(associationSpecs);

  if (associationResult.failed.length > 0) {
    for (const failure of associationResult.failed) {
      errors.push(failure.error);
    }
    // Log but don't fail the entire workflow for association errors
    console.warn('[workflow] Some associations failed:', associationResult.failed);
  }

  // Check if Deal↔Company was created (it's in the association specs)
  const dealCompanyAssociated = associationResult.successful.some(
    (spec) => spec.fromType === 'deals' && spec.toType === 'companies'
  );

  // Step 6: Return structured result
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
