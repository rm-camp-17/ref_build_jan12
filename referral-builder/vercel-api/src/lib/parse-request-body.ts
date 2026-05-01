/**
 * Parse a raw request body that may be double-JSON-encoded.
 *
 * Background: when the unified card calls our routes via `hubspot.fetch`
 * without a Content-Type header (we can't set one — HubSpot rejects with
 * HTTP 400 if any header other than Authorization is present), HubSpot's
 * CRM-extensibility proxy forwards the body double-encoded. We see:
 *
 *     rawBody = "\"{\\\"dealId\\\":\\\"59914872395\\\",...}\""
 *               ^ outer JSON-encoded string whose value is a JSON string
 *
 * `JSON.parse(rawBody)` then returns the inner string (still a string),
 * not the parsed object. Our validators reject with "expected object".
 *
 * This helper detects the case and parses a second time. Single-encoded
 * bodies (from curl, tests, or any caller that sends a real JSON object)
 * still work — `JSON.parse` returns the object on the first pass and we
 * skip the second.
 *
 * Throws SyntaxError if either parse fails. Callers should wrap and
 * convert to a 400 response.
 */
export function parseRequestBody(rawBody: string): unknown {
  if (!rawBody) return {};
  let parsed = JSON.parse(rawBody);
  if (typeof parsed === 'string') {
    parsed = JSON.parse(parsed);
  }
  return parsed;
}
