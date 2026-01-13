import { Client } from '@hubspot/api-client';
import { config } from './config';

if (!config.hubspot.accessToken) {
  throw new Error(
    'HUBSPOT_ACCESS_TOKEN is not defined. Please set it in your environment variables.'
  );
}

export const hubspotClient = new Client({
  accessToken: config.hubspot.accessToken,
});
