import { hubspotClient } from './hubspot';

// Cache for association type IDs to avoid repeated API calls
const associationTypeCache: Record<string, number> = {};

/**
 * Fetch association type ID between two object types
 * Example: getAssociationTypeId('deals', 'companies') → 3
 */
export async function getAssociationTypeId(
  fromObjectType: string,
  toObjectType: string,
  label?: string
): Promise<number> {
  const cacheKey = `${fromObjectType}-${toObjectType}`;

  // Return cached value if exists
  if (associationTypeCache[cacheKey]) {
    return associationTypeCache[cacheKey];
  }

  try {
    // Fetch association schema
    const types = await hubspotClient.crm.associations.schemaApi.getAll(
      fromObjectType,
      toObjectType
    );

    // Find matching type by label (or use first if no label provided)
    const matchingType = label
      ? types.results.find((t) => t.label === label)
      : types.results[0];

    if (!matchingType) {
      throw new Error(
        `No association type found for ${fromObjectType} → ${toObjectType}`
      );
    }

    // Cache and return
    associationTypeCache[cacheKey] = matchingType.typeId;
    return matchingType.typeId;
  } catch (error) {
    console.error(`Failed to fetch association type ID:`, error);
    throw error;
  }
}

/**
 * Create an association between two objects
 * Example: createAssociation('12345', 'referral', '67890', 'deals')
 */
export async function createAssociation(
  fromObjectId: string,
  fromObjectType: string,
  toObjectId: string,
  toObjectType: string
): Promise<void> {
  try {
    const associationTypeId = await getAssociationTypeId(
      fromObjectType,
      toObjectType
    );

    await hubspotClient.crm.associations.batchApi.create({
      inputs: [
        {
          from: { id: fromObjectId },
          to: { id: toObjectId },
          types: [
            {
              associationCategory: 'HUBSPOT_DEFINED',
              associationTypeId,
            },
          ],
        },
      ],
    });

    console.log(
      `✓ Created association: ${fromObjectType}:${fromObjectId} → ${toObjectType}:${toObjectId}`
    );
  } catch (error: any) {
    console.error(`Failed to create association:`, error);
    throw new Error(
      `Association failed: ${fromObjectType} → ${toObjectType}: ${error.message}`
    );
  }
}
