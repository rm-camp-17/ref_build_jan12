import { Client } from '@hubspot/api-client';
import { config } from './config';

let _client: Client | undefined;

function getClient(): Client {
  if (!_client) {
    if (!config.hubspot.accessToken) {
      throw new Error(
        'HUBSPOT_ACCESS_TOKEN is not defined. Please set it in your environment variables.'
      );
    }
    _client = new Client({ accessToken: config.hubspot.accessToken });
  }
  return _client;
}

// Lazy proxy: defers client construction (and the env-var check) until first
// property access. This lets `next build` complete its page-data-collection
// pass without HUBSPOT_ACCESS_TOKEN — the env var is required at request time
// on Vercel, not at build time.
export const hubspotClient = new Proxy({} as Client, {
  get(_target, prop) {
    const value = Reflect.get(getClient(), prop);
    return typeof value === 'function' ? value.bind(getClient()) : value;
  },
});
