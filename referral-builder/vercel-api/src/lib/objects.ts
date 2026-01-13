/**
 * Object helper utilities for HubSpot CRM
 *
 * HubSpot SDK v11.x compatible with correct API signatures.
 */

import { hubspotClient } from './hubspot';

// ============================================================================
// Types
// ============================================================================

export interface ObjectResult {
  id: string;
  properties: Record<string, string | null>;
}

// ============================================================================
// Functions
// ============================================================================

/**
 * Fetch a single HubSpot object by ID with specified properties
 */
export async function getObject(
  objectType: string,
  objectId: string,
  properties: string[]
): Promise<ObjectResult> {
  try {
    const result = await hubspotClient.crm.objects.basicApi.getById(
      objectType,
      objectId,
      properties
    );
    return {
      id: result.id,
      properties: result.properties as Record<string, string | null>,
    };
  } catch (error: any) {
    console.error(`[objects] Failed to fetch ${objectType}:${objectId}:`, error.message);
    throw new Error(`Failed to fetch ${objectType}: ${error.message}`);
  }
}

/**
 * Search for objects by property value
 */
export async function searchObjects(
  objectType: string,
  propertyName: string,
  value: string,
  operator: 'EQ' | 'CONTAINS_TOKEN' = 'EQ',
  properties: string[] = []
): Promise<ObjectResult[]> {
  try {
    const result = await hubspotClient.crm.objects.searchApi.doSearch(objectType, {
      filterGroups: [
        {
          filters: [
            {
              propertyName,
              operator: operator as any,
              value,
            },
          ],
        },
      ],
      properties,
      sorts: [],
      after: '0',
      limit: 100,
    });

    return (result.results || []).map((obj: any) => ({
      id: obj.id,
      properties: obj.properties as Record<string, string | null>,
    }));
  } catch (error: any) {
    console.error(`[objects] Failed to search ${objectType}:`, error.message);
    throw new Error(`Failed to search ${objectType}: ${error.message}`);
  }
}

/**
 * Create a HubSpot object
 */
export async function createObject(
  objectType: string,
  properties: Record<string, string>
): Promise<string> {
  try {
    const result = await hubspotClient.crm.objects.basicApi.create(objectType, {
      properties,
      associations: [],
    });
    return result.id;
  } catch (error: any) {
    console.error(`[objects] Failed to create ${objectType}:`, error.message);
    throw new Error(`Failed to create ${objectType}: ${error.message}`);
  }
}

/**
 * Update a HubSpot object
 */
export async function updateObject(
  objectType: string,
  objectId: string,
  properties: Record<string, string>
): Promise<void> {
  try {
    await hubspotClient.crm.objects.basicApi.update(objectType, objectId, {
      properties,
    });
  } catch (error: any) {
    console.error(`[objects] Failed to update ${objectType}:${objectId}:`, error.message);
    throw new Error(`Failed to update ${objectType}: ${error.message}`);
  }
}

// ============================================================================
// Legacy function - deprecated
// ============================================================================

/**
 * @deprecated Use getAssociatedIds from associations.ts instead
 */
export async function getAssociatedObjects(
  fromObjectType: string,
  fromObjectId: string,
  toObjectType: string
): Promise<string[]> {
  // Import dynamically to avoid circular dependency
  const { getAssociatedIds } = await import('./associations');
  return getAssociatedIds(fromObjectType, fromObjectId, toObjectType);
}
