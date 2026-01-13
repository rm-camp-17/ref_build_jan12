import { hubspotClient } from './hubspot';

/**
 * Fetch a single HubSpot object by ID with specified properties
 */
export async function getObject(
  objectType: string,
  objectId: string,
  properties: string[]
): Promise<any> {
  try {
    const result = await hubspotClient.crm.objects.basicApi.getById(
      objectType,
      objectId,
      properties
    );
    return result;
  } catch (error: any) {
    console.error(`Failed to fetch ${objectType}:${objectId}:`, error);
    throw new Error(`Failed to fetch ${objectType}: ${error.message}`);
  }
}

/**
 * Fetch associated objects
 * Example: getAssociatedObjects('deals', '12345', 'companies')
 */
export async function getAssociatedObjects(
  fromObjectType: string,
  fromObjectId: string,
  toObjectType: string
): Promise<any[]> {
  try {
    const result = await hubspotClient.crm.associations.batchApi.read({
      inputs: [
        {
          id: fromObjectId,
        },
      ],
      fromObjectType,
      toObjectType,
    });

    if (result.results.length === 0 || !result.results[0].to) {
      return [];
    }

    return result.results[0].to.map((assoc: any) => assoc.toObjectId);
  } catch (error: any) {
    console.error(
      `Failed to fetch associated ${toObjectType} for ${fromObjectType}:${fromObjectId}:`,
      error
    );
    return [];
  }
}
