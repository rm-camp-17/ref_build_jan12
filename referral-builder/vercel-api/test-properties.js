// Quick test to see what HubSpot returns for property options
const { Client } = require('@hubspot/api-client');

const client = new Client({ accessToken: process.env.HUBSPOT_ACCESS_TOKEN });

async function test() {
  try {
    const statusProp = await client.crm.properties.coreApi.getByName(
      '2-55790899',
      'referral_status'
    );
    
    console.log('Status Property Options:');
    console.log(JSON.stringify(statusProp.options, null, 2));
  } catch (e) {
    console.error('Error:', e.message);
  }
}

test();
