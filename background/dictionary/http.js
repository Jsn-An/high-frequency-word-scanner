/**
 * HTTP helper for the dictionary providers.
 *
 * Three things this module centralizes, so no provider has to think about them:
 *
 *  1. Timeouts. Every request is aborted after a fixed budget. A service worker fetch
 *     that never settles would keep a lookup pending forever and the detail panel would
 *     show a spinner instead of an error.
 *  2. Retries with backoff for transient failures only: network errors, 408, 429 and
 *     5xx. A 404 is an answer, not a failure, and is never retried.
 *  3. Per-host serialization and spacing. Wikimedia asks clients not to hammer the API
 *     and rate limits aggressively when they do, so requests to one host are queued and
 *     spaced instead of fired in parallel.
 *
 * Requests are issued from the service worker, never from a content script, and the
 * hostnames are declared in manifest host_permissions, so no CORS preflight is involved.
 */

import { PROVIDER_TIMEOUT_MS } from '../../lib/constants.js';

/** Largest response body we are willing to parse, as a guard against a hostile proxy. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Error carrying the HTTP status when the server answered with a failure status. */
export class HttpError extends Error {
  constructor(message, { status = 0, url = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/** Sleep helper. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Per-host queue -----------------------------------------------------------

const hostChains = new Map();
const hostLastRequestAt = new Map();

/**
 * Runs `task` after every earlier task for the same host finished, and at least
 * `minGapMs` after the previous request to that host started.
 */
async function withHostSlot(host, minGapMs, task) {
  const previous = hostChains.get(host) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  hostChains.set(host, previous.then(() => gate));

  await previous.catch(() => {});

  try {
    if (minGapMs > 0) {
      const elapsed = Date.now() - (hostLastRequestAt.get(host) || 0);
      if (elapsed < minGapMs) await sleep(minGapMs - elapsed);
    }
    hostLastRequestAt.set(host, Date.now());
    return await task();
  } finally {
    release();
  }
}

/** Reads the body as text, refusing absurdly large responses. */
async function readBodyText(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_RESPONSE_BYTES) {
    throw new HttpError(`Response too large (${declared} bytes).`, {
      status: response.status,
      url: response.url
    });
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new HttpError('Response too large.', { status: response.status, url: response.url });
  }
  return text;
}

/** Parses JSON without throwing: the caller decides what a malformed body means. */
function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Backoff for the given retry index. */
function backoffMs(attempt) {
  return 250 * 2 ** attempt;
}

/** Parses a Retry-After header, capped so a hostile value cannot stall the queue. */
function retryAfterMs(response) {
  const header = response.headers.get('retry-after');
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(3000, Math.max(0, seconds * 1000));
  const date = new Date(header);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.min(3000, Math.max(0, date.getTime() - Date.now()));
}

/**
 * Performs a GET request and returns the status plus a parsed body when there is one.
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {Record<string,string>} [options.headers]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.attempts] Total attempts, including the first one.
 * @param {number} [options.minGapMs] Minimum spacing between requests to the same host.
 * @returns {Promise<{status: number, body: any, text: string}>}
 * @throws {HttpError} When every attempt failed with a transient error.
 */
export async function requestJson(url, options = {}) {
  const {
    headers = {},
    timeoutMs = PROVIDER_TIMEOUT_MS,
    attempts = 2,
    minGapMs = 0
  } = options;

  const host = new URL(url).host;
  const totalAttempts = Math.max(1, attempts);

  return withHostSlot(host, minGapMs, async () => {
    let lastError = null;

    for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
          credentials: 'omit',
          redirect: 'follow',
          cache: 'default'
        });

        const text = await readBodyText(response);
        const status = response.status;

        // Success and "not found" are both final answers.
        if (status === 404 || (status >= 200 && status < 300)) {
          return { status, body: parseJson(text), text };
        }

        // Transient failures are retried, then reported as a failure status.
        if (status === 429 || status === 408 || status >= 500) {
          lastError = new HttpError(`HTTP ${status} from ${host}.`, { status, url });
          if (attempt < totalAttempts - 1) {
            await sleep(retryAfterMs(response) || backoffMs(attempt));
            continue;
          }
          return { status, body: null, text, error: lastError };
        }

        // Other 4xx responses are final: the request itself was wrong.
        return { status, body: parseJson(text), text };
      } catch (error) {
        const isTimeout = error && error.name === 'AbortError';
        lastError = new HttpError(
          isTimeout
            ? `Request to ${host} timed out after ${timeoutMs} ms.`
            : `Network error contacting ${host}: ${(error && error.message) || error}`,
          { status: 0, url }
        );
        if (attempt < totalAttempts - 1) {
          await sleep(backoffMs(attempt));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || new HttpError(`Request to ${host} failed.`, { url });
  });
}
