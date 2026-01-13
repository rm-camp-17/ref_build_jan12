/**
 * Association helpers for HubSpot CRM
 * HubSpot Platform Version 2025.02 compatible
 * Uses @hubspot/api-client v11.x correct method signatures
 */

import { hubspotClient } from './hubspot';

// ============================================================================
// Types
// ============================================================================

export interface AssociationSpec {
  fromId: string;
  fromType: string;
  toId: string;
  toType: string;
}

export interface AssociationResult {
  success: boolean;
  alreadyExists?: boolean;
  error?: string;
}

export interface BatchAssociationResult {
  successful: AssociationSpec[];
  failed: Array<AssociationSpec & { error: string }>;
  allSucceeded: boolean;
}

// ============================================================================
// Cache for Association Type IDs
// ============================================================================

const associationTypeCache: Map<string, number> = new Map();

/**
 * Get cache key for association type lookup
 */
function getCacheKey(fromType: string, toType: string): string {
  return `${fromType}:${toType}`;
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Fetch association type ID between two object types
 * Results are cached for the lifetime of the process
 *
 * @param fromObjectType - Source object type (e.g., 'deals', 'p_referral')
 * @param toObjectType - Target object type (e.g., 'companies', 'p_program')
 * @returns Association type ID
 */
export async function getAssociationTypeId(
  fromObjectType: string,
  toObjectType: string
): Promise<number> {
  const cacheKey = getCacheKey(fromObjectType, toObjectType);

  // Return cached value if exists
  const cached = associationTypeCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    // Fetch association schema using v4 definitions API
    const types = await hubspotClient.crm.associations.v4.schema.definitionsApi.getAll(
      fromObjectType,
      toObjectType
    );

    if (!types.results || types.results.length === 0) {
      throw new Error(
        `No association types defined for ${fromObjectType} → ${toObjectType}`
      );
    }

    // Use the first (default) association type
    // For custom labels, add a label parameter and search for it
    const typeId = types.results[0].typeId;

    // Cache and return
    associationTypeCache.set(cacheKey, typeId);
    console.log(`[associations] Cached type ID: ${fromObjectType} → ${toObjectType} = ${typeId}`);

    return typeId;
  } catch (error: any) {
    console.error(
      `[associations] Failed to get association type ID for ${fromObjectType} → ${toObjectType}:`,
      error.message
    );
    throw new Error(
      `Failed to get association type: ${fromObjectType} → ${toObjectType}: ${error.message}`
    );
  }
}

/**
 * Check if an association already exists between two objects
 * Used for idempotent association creation
 *
 * HubSpot SDK v11.x signature for batchApi.read:
 * read(fromObjectType: string, toObjectType: string, request: BatchInputPublicObjectId)
 */
export async function associationExists(
  fromObjectType: string,
  fromObjectId: string,
  toObjectType: string,
  toObjectId: string
): Promise<boolean> {
  try {
    // HubSpot SDK v11.x correct signature
    const result = await hubspotClient.crm.associations.v4.batchApi.getPage(
      fromObjectType,
      toObjectType,
      { inputs: [{ id: fromObjectId }] }
    );

    if (!result.results || result.results.length === 0) {
      return false;
    }

    // Check if target object is in the associations
    const associations = result.results[0]?.to || [];
    return associations.some(
      (assoc: any) => String(assoc.toObjectId) === String(toObjectId)
    );
  } catch (error: any) {
    // If we get a 404 or similar, association doesn't exist
    if (error.code === 404 || error.statusCode === 404) {
      return false;
    }
    console.error(
      `[associations] Error checking association existence:`,
      error.message
    );
    // On error, assume it doesn't exist (let create attempt handle it)
    return false;
  }
}

/**
 * Create an association between two objects (idempotent)
 * If association already exists, returns success with alreadyExists=true
 *
 * HubSpot SDK v11.x signature for batchApi.create:
 * create(fromObjectType: string, toObjectType: string, request: BatchInputPublicAssociationMultiPost)
 */
export async function createAssociationIdempotent(
  spec: AssociationSpec
): Promise<AssociationResult> {
  const { fromId, fromType, toId, toType } = spec;

  try {
    // First check if association already exists
    const exists = await associationExists(fromType, fromId, toType, toId);
    if (exists) {
      console.log(
        `[associations] Association already exists: ${fromType}:${fromId} → ${toType}:${toId}`
      );
      return { success: true, alreadyExists: true };
    }

    // Get association type ID
    const typeId = await getAssociationTypeId(fromType, toType);

    // Create association using v4 batch API (correct for SDK v11.x)
    // Use type assertion for the enum value
    await hubspotClient.crm.associations.v4.batchApi.create(
      fromType,
      toType,
      {
        inputs: [
          {
            _from: { id: fromId },
            to: { id: toId },
            types: [
              {
                associationCategory: 'HUBSPOT_DEFINED' as any,
                associationTypeId: typeId,
              },
            ],
          },
        ],
      }
    );

    console.log(
      `[associations] Created: ${fromType}:${fromId} → ${toType}:${toId}`
    );
    return { success: true, alreadyExists: false };
  } catch (error: any) {
    console.error(
      `[associations] Failed to create: ${fromType}:${fromId} → ${toType}:${toId}:`,
      error.message
    );
    return {
      success: false,
      error: `Failed to associate ${fromType} → ${toType}: ${error.message}`,
    };
  }
}

/**
 * Create multiple associations (all idempotent)
 * Continues on individual failures and reports results
 */
export async function createAssociationsBatch(
  specs: AssociationSpec[]
): Promise<BatchAssociationResult> {
  const successful: AssociationSpec[] = [];
  const failed: Array<AssociationSpec & { error: string }> = [];

  // Process associations sequentially to avoid rate limits
  // Could be parallelized with Promise.allSettled if needed
  for (const spec of specs) {
    const result = await createAssociationIdempotent(spec);
    if (result.success) {
      successful.push(spec);
    } else {
      failed.push({ ...spec, error: result.error || 'Unknown error' });
    }
  }

  return {
    successful,
    failed,
    allSucceeded: failed.length === 0,
  };
}

/**
 * Get associated object IDs from a source object
 *
 * HubSpot SDK v11.x correct signature
 */
export async function getAssociatedIds(
  fromObjectType: string,
  fromObjectId: string,
  toObjectType: string
): Promise<string[]> {
  try {
    const result = await hubspotClient.crm.associations.v4.batchApi.getPage(
      fromObjectType,
      toObjectType,
      { inputs: [{ id: fromObjectId }] }
    );

    if (!result.results || result.results.length === 0) {
      return [];
    }

    const associations = result.results[0]?.to || [];
    return associations.map((assoc: any) => String(assoc.toObjectId));
  } catch (error: any) {
    console.error(
      `[associations] Failed to get associations for ${fromObjectType}:${fromObjectId} → ${toObjectType}:`,
      error.message
    );
    return [];
  }
}

// ============================================================================
// Legacy function for backwards compatibility
// ============================================================================

/**
 * @deprecated Use createAssociationIdempotent instead
 */
export async function createAssociation(
  fromObjectId: string,
  fromObjectType: string,
  toObjectId: string,
  toObjectType: string
): Promise<void> {
  const result = await createAssociationIdempotent({
    fromId: fromObjectId,
    fromType: fromObjectType,
    toId: toObjectId,
    toType: toObjectType,
  });

  if (!result.success) {
    throw new Error(result.error);
  }
}
