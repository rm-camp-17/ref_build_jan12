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
 * 7. Return structured result
 *
 * Association Labels:
 * - "Recommendation": Default label for Referral ↔ Company associations
 * - "Selected_Referral": Label for Referral ↔ Company when client_interest == "Selected"
 *
 * Computed fields set by this workflow:
 * - hubspot_owner_id: from Deal.hubspot_owner_id
 * - resend_requested: true if referral_outreach_status == "Resend"
 *
 * Deal Integration (when client_interest == "Selected"):
 * - Checks for existing Selected referral on the deal (prevents duplicates)
 * - Reads Company.programid (legacy ID = PostgreSQL companies.access_id)
 * - Uses Company name as deal.programname (Program HubSpot object does not exist)
 * - Writes deal properties: program_id, programname, dealstage → "Tuition Undecided"
 * - This activates the Session Selection card for tuition entry
 *
 * De-selection (three-tier):
 * - Tier 1: Deal at Tuition Undecided, no tuition → reset deal to "Recommendation Presented"
 * - Tier 2: Tuition entered → block de-selection
 * - Tier 3: Closed Won → hard block
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
  dealUpdated?: boolean;
  errors?: string[];
  validationErrors?: string[];
}

interface CreateOrUpdateResult {
  referralId: string;
  created: boolean;
}

// ============================================================================
// Types for Deal Integration
// ============================================================================

/**
 * Two-tier de-selection result (collapsed from earlier 3-tier model).
 *
 * In the active "Deal Pipeline", `decisionmakerboughtin` ("Program Selected")
 * IS the closed-won state — there's no separate "Closed Won" stage to gate
 * differently. The earlier Tier 3 hard-block check against `1282918770`
 * (the historic-pipeline closed-won ID) never matched active deals.
 *
 * When a referral's client_interest changes FROM "Selected" to something else:
 *
 *   reset: Deal at "Tuition Undecided", no tuition entered
 *          → Allow. Reset program_id, programname, dealstage to Recommendation Presented.
 *   block: Deal at "Program Selected" (tuition entered = won)
 *          → Block de-selection.
 *   noOp:  Any other stage (Recommendation Presented, Closed Lost, etc.)
 *          → Allow. Update referral only; leave deal stage unchanged.
 */
type DeSelectionResult =
  | { action: 'reset'; rollbackStageId: string }
  | { action: 'block'; message: string }
  | { action: 'noOp' };

// ============================================================================
// Internal Helper Functions
// ============================================================================

/**
 * Fetch Deal to get owner ID, name, and other properties
 * Extended with integration properties (dealstage, program_id, tuition_at_enrollment)
 */
async function fetchDealData(dealId: string): Promise<{
  ownerId?: string;
  dealKey?: string;
  dealName?: string;
  year?: string;
  dealstage?: string;
  programId?: string;
  tuitionAtEnrollment?: string;
}> {
  try {
    const deal = await hubspotClient.crm.deals.basicApi.getById(dealId, [
      'hubspot_owner_id',
      config.properties.deal.key,
      config.properties.deal.year,
      config.properties.deal.name,
      config.properties.deal.stage,
      config.properties.deal.programId,
      config.properties.deal.tuitionAtEnrollment,
      'dealname',
    ]);
    return {
      ownerId: deal.properties.hubspot_owner_id || undefined,
      dealKey: deal.properties[config.properties.deal.key] || undefined,
      dealName: deal.properties[config.properties.deal.name] || deal.properties.dealname || undefined,
      year: deal.properties[config.properties.deal.year] || undefined,
      dealstage: deal.properties[config.properties.deal.stage] || undefined,
      programId: deal.properties[config.properties.deal.programId] || undefined,
      tuitionAtEnrollment: deal.properties[config.properties.deal.tuitionAtEnrollment] || undefined,
    };
  } catch (error: any) {
    console.error(`[workflow] Failed to fetch deal ${dealId}:`, error.message);
    // Return empty - don't fail the workflow for this
    return {};
  }
}

/**
 * Fetch Company's programid (legacy ID used by Session Card for session lookup).
 * Maps to PostgreSQL companies.access_id.
 *
 * Unlike other fetch functions, this MUST succeed for the "Selected" flow.
 * Returns null if programid is empty/missing — caller must handle as a blocking error.
 */
async function fetchCompanyProgramId(companyId: string): Promise<string | null> {
  try {
    const company = await hubspotClient.crm.companies.basicApi.getById(companyId, [
      config.properties.company.programId,
    ]);
    const programId = company.properties[config.properties.company.programId];
    if (!programId || programId.trim() === '') {
      console.warn(`[workflow] Company ${companyId} has no programid set`);
      return null;
    }
    return programId.trim();
  } catch (error: any) {
    console.error(`[workflow] Failed to fetch company programid for ${companyId}:`, error.message);
    return null;
  }
}

/**
 * Check if another referral on this deal is already marked "Selected".
 * Returns the existing Selected referral's ID if found, null otherwise.
 */
async function findExistingSelectedReferral(dealId: string): Promise<string | null> {
  try {
    // Get all referral IDs associated with this deal
    const referralIds = await getAssociatedIds(
      'deals',
      dealId,
      config.objectTypes.referral
    );

    if (referralIds.length === 0) return null;

    // Batch read client_interest for all referrals
    // HubSpot batch read supports up to 100 IDs
    const batchResult = await hubspotClient.crm.objects.batchApi.read(
      config.objectTypes.referral,
      {
        inputs: referralIds.map((id) => ({ id })),
        properties: [config.properties.referral.interest],
        propertiesWithHistory: [],
      }
    );

    for (const result of batchResult.results) {
      const interest = result.properties[config.properties.referral.interest];
      if (isClientInterestSelected(interest)) {
        return result.id;
      }
    }

    return null;
  } catch (error: any) {
    console.error(`[workflow] Failed to check existing Selected referrals for deal ${dealId}:`, error.message);
    // On error, allow the operation to proceed — don't block on a failed check
    return null;
  }
}

/**
 * Update deal properties for the referral-to-session integration.
 * Writes program_id, programname, and dealstage in a single PATCH call.
 *
 * Returns true on success, error message on failure.
 */
async function updateDealForSelection(
  dealId: string,
  companyProgramId: string,
  programName: string,
  stageId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await hubspotClient.crm.deals.basicApi.update(dealId, {
      properties: {
        [config.properties.deal.programId]: companyProgramId,
        [config.properties.deal.programName]: programName,
        [config.properties.deal.stage]: stageId,
      },
    });
    console.log(`[workflow] Updated deal ${dealId}: program_id=${companyProgramId}, programname=${programName}, dealstage=${stageId}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[workflow] Failed to update deal ${dealId} for selection:`, error.message);
    return { success: false, error: `Failed to update deal: ${error.message}` };
  }
}

/**
 * Reset deal properties when a referral is de-selected (Tier 1).
 * Clears program_id, programname, and moves deal to rollback stage.
 */
async function resetDealForDeSelection(
  dealId: string,
  rollbackStageId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await hubspotClient.crm.deals.basicApi.update(dealId, {
      properties: {
        [config.properties.deal.programId]: '',
        [config.properties.deal.programName]: '',
        [config.properties.deal.stage]: rollbackStageId,
      },
    });
    console.log(`[workflow] Reset deal ${dealId}: cleared program_id/programname, stage=${rollbackStageId}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[workflow] Failed to reset deal ${dealId}:`, error.message);
    return { success: false, error: `Failed to reset deal: ${error.message}` };
  }
}

/**
 * Determine de-selection action based on deal state.
 */
function determineDeSelectionTier(dealData: {
  dealstage?: string;
  tuitionAtEnrollment?: string;
}): DeSelectionResult {
  const { dealstage, tuitionAtEnrollment } = dealData;
  const hasTuition = !!tuitionAtEnrollment && parseFloat(tuitionAtEnrollment) > 0;

  // Block: Program Selected (= Closed Won) with tuition entered
  if (dealstage === config.stages.programSelected && hasTuition) {
    return {
      action: 'block',
      message: 'Tuition has been entered for this session. Clear the session selection on the Session Card tab first.',
    };
  }

  // Reset: Tuition Undecided — actively roll back to Recommendation Presented
  if (dealstage === config.stages.tuitionUndecided) {
    return {
      action: 'reset',
      rollbackStageId: config.stages.recommendationPresented,
    };
  }

  // No-op: any other stage (Recommendation Presented, Closed Lost, etc.)
  // Allow the referral edit but leave the deal stage unchanged. Previously
  // the fall-through reset closed-lost deals back to Recommendation Presented,
  // which silently re-opened them.
  return { action: 'noOp' };
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
 * Check if outreach status indicates resend is requested
 */
function isResendRequested(outreachStatus: string | null | undefined): boolean {
  if (!outreachStatus) return false;
  // Match "Resend" case-insensitively
  return outreachStatus.toLowerCase() === 'resend';
}

/**
 * Check if client interest is "Selected"
 */
function isClientInterestSelected(clientInterest: string | null | undefined): boolean {
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
 *
 * Association labels (string form — see PR for numeric type IDs):
 *   - "Recommendation" for Referral ↔ Company (default)
 *   - "Selected_Referral" for Referral ↔ Company when client_interest == "Selected"
 *
 * Program / Session associations are intentionally absent: those custom
 * objects do not exist in portal 50530609. Sessions live in Postgres and
 * are referenced by `Company.programid` instead.
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
  const isSelected = isClientInterestSelected(input.clientInterest);
  console.log(`[workflow] Starting referral creation for deal ${input.dealId} → company ${input.companyId}${isSelected ? ' (SELECTED)' : ''}`);

  // Step 1.5: If marking as Selected, check for existing Selected referral on this deal
  if (isSelected) {
    const existingSelectedId = await findExistingSelectedReferral(input.dealId);
    if (existingSelectedId) {
      return {
        success: false,
        errors: [
          `Another referral on this deal is already marked Selected (ID: ${existingSelectedId}). De-select it first before selecting a new one.`,
        ],
      };
    }
  }

  // Step 2: Fetch Deal and Company data in parallel.
  // Also fetch company.programid if marking Selected (mandatory for the
  // session-card hand-off — programid maps to the Postgres companies.access_id
  // used to look up sessions in the external session DB).
  const [dealData, companyName, companyProgramId] = await Promise.all([
    fetchDealData(input.dealId),
    fetchCompanyName(input.companyId),
    isSelected
      ? fetchCompanyProgramId(input.companyId)
      : Promise.resolve(null),
  ]);

  // If marking Selected, company must have a programid
  if (isSelected && !companyProgramId) {
    return {
      success: false,
      errors: [
        'Cannot mark Selected: the associated camp does not have a program ID configured. Contact admin to set up the camp\'s program.',
      ],
    };
  }

  console.log(`[workflow] Fetched data - Deal owner: ${dealData.ownerId}, Company: ${companyName}`);

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

  // selected_session_* fields are populated downstream by the unified app's
  // session-selection flow (Postgres-backed, wired in Phase 3). They are no
  // longer set here from a HubSpot Session object — that object type does not
  // exist in this portal.

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

  // Step 6: If marking as Selected, update deal properties to activate Session Card
  // Writes: program_id, programname, dealstage → "Program Selected - Tuition Undecided"
  let dealUpdated = false;
  if (isSelected && companyProgramId) {
    // Use the Company name as deal.programname. Earlier code fetched a
    // separate Program custom-object name, but Program is not a HubSpot
    // object in this portal; the camp's name on the Company record is the
    // canonical display name.
    const programName = companyName || 'Unknown Program';

    const dealUpdateResult = await updateDealForSelection(
      input.dealId,
      companyProgramId,
      programName,
      config.stages.tuitionUndecided
    );

    if (!dealUpdateResult.success) {
      // Deal update failed — do NOT mark referral as Selected
      // The referral was already created/updated above, but without the deal
      // transition the Session Card won't activate. Return error so the
      // frontend can show it and the user can retry.
      errors.push(dealUpdateResult.error || 'Failed to update deal for session selection');
      console.error(`[workflow] Deal update failed for selection. Referral ${referralId} was created but deal not transitioned.`);
      return {
        success: false,
        referralId,
        created,
        updated: !created,
        associationsCreated: associationResult.successful.length,
        associationsFailed: associationResult.failed.length,
        dealCompanyAssociated,
        errors,
      };
    }

    dealUpdated = true;
    console.log(`[workflow] Deal ${input.dealId} updated for selection: program_id=${companyProgramId}, programname=${programName}`);
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
    dealUpdated,
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
 * Updates an existing referral's properties.
 *
 * When client_interest changes TO "Selected":
 *   - Checks for existing Selected referral on the deal
 *   - Validates Company programid
 *   - Updates deal properties (program_id, programname, dealstage)
 *
 * When client_interest changes FROM "Selected":
 *   - Applies three-tier de-selection logic based on deal state
 *   - Tier 1: reset deal  |  Tier 2: block  |  Tier 3: hard block
 */
export async function updateReferralWorkflow(
  referralId: string,
  properties: Record<string, string>,
  context?: { dealId?: string; companyId?: string; previousClientInterest?: string }
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

  const newInterest = properties[config.properties.referral.interest];
  const isNowSelected = isClientInterestSelected(newInterest);
  const wasSelected = isClientInterestSelected(context?.previousClientInterest);

  // Handle transition TO "Selected"
  if (isNowSelected && !wasSelected && context?.dealId && context?.companyId) {
    // Check for existing Selected referral (not this one)
    const existingSelectedId = await findExistingSelectedReferral(context.dealId);
    if (existingSelectedId && existingSelectedId !== referralId) {
      return {
        success: false,
        errors: [
          `Another referral on this deal is already marked Selected (ID: ${existingSelectedId}). De-select it first.`,
        ],
      };
    }

    // Validate Company programid
    const companyProgramId = await fetchCompanyProgramId(context.companyId);
    if (!companyProgramId) {
      return {
        success: false,
        errors: [
          'Cannot mark Selected: the associated camp does not have a program ID configured. Contact admin to set up the camp\'s program.',
        ],
      };
    }

    // Use the Company name as deal.programname (Program HubSpot object does
    // not exist in this portal — the camp name on the Company record is the
    // canonical display name).
    const programName = (await fetchCompanyName(context.companyId)) || 'Unknown Program';

    // Update the referral first
    try {
      await hubspotClient.crm.objects.basicApi.update(
        config.objectTypes.referral,
        referralId,
        { properties }
      );
    } catch (error: any) {
      console.error(`[workflow] Failed to update referral ${referralId}:`, error.message);
      return { success: false, errors: [`Failed to update referral: ${error.message}`] };
    }

    // Then update the deal
    const dealUpdateResult = await updateDealForSelection(
      context.dealId,
      companyProgramId,
      programName,
      config.stages.tuitionUndecided
    );

    if (!dealUpdateResult.success) {
      return {
        success: false,
        errors: [dealUpdateResult.error || 'Failed to update deal for session selection'],
      };
    }

    console.log(`[workflow] Updated referral ${referralId} to Selected + deal ${context.dealId} transitioned`);
    return { success: true };
  }

  // Handle transition FROM "Selected"
  if (wasSelected && !isNowSelected && context?.dealId) {
    const dealData = await fetchDealData(context.dealId);
    const deSelectionResult = determineDeSelectionTier(dealData);

    if (deSelectionResult.action === 'block') {
      return {
        success: false,
        errors: [deSelectionResult.message],
      };
    }

    // 'reset' or 'noOp': both update the referral first
    try {
      await hubspotClient.crm.objects.basicApi.update(
        config.objectTypes.referral,
        referralId,
        { properties }
      );
    } catch (error: any) {
      console.error(`[workflow] Failed to update referral ${referralId}:`, error.message);
      return { success: false, errors: [`Failed to update referral: ${error.message}`] };
    }

    if (deSelectionResult.action === 'noOp') {
      console.log(`[workflow] De-selected referral ${referralId}, deal stage left unchanged (noOp)`);
      return { success: true };
    }

    // 'reset': roll back the deal to Recommendation Presented
    const resetResult = await resetDealForDeSelection(
      context.dealId,
      deSelectionResult.rollbackStageId
    );

    if (!resetResult.success) {
      // Referral was de-selected but deal wasn't reset — log but still return success
      // The deal is in a safe state (still at Tuition Undecided with no tuition)
      console.warn(`[workflow] Referral de-selected but deal reset failed: ${resetResult.error}`);
    }

    console.log(`[workflow] De-selected referral ${referralId}, deal ${context.dealId} reset to Recommendation Presented`);
    return { success: true };
  }

  // Standard update (no selection/de-selection transition)
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
