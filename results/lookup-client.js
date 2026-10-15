/**
 * Lookup client used by both the detail drawer and the export.
 *
 * One shared cache means a word the user opened is already in memory when an export
 * needs it, and an export that prepares 200 words never asks for the same word twice.
 * Requests are also deduplicated while in flight, which matters because the export runs
 * three lookups concurrently.
 */

import { MSG } from '../lib/constants.js';

/**
 * @returns {{load: (word: string, options?: {force?: boolean}) => Promise<Object>,
 *   get: (word: string) => Object|undefined, has: (word: string) => boolean,
 *   size: () => number, clear: () => void}}
 */
export function createLookupClient() {
  /** word -> result object ({status, entry, providersTried, error}) */
  const cache = new Map();
  /** word -> promise while a request is in flight */
  const inFlight = new Map();

  /**
   * Resolves one word. Never rejects: a transport failure becomes an 'error' result, so
   * every caller can render something instead of a blank panel.
   */
  async function load(word, { force = false } = {}) {
    if (!force && cache.has(word)) return cache.get(word);
    if (inFlight.has(word)) return inFlight.get(word);

    const pending = chrome.runtime
      .sendMessage({ type: MSG.LOOKUP, word, force })
      .then((response) => {
        if (response && response.ok && response.result) return response.result;
        return {
          word,
          status: 'error',
          entry: null,
          providersTried: [],
          error: (response && response.error) || 'The extension background service did not answer.',
          fromCache: false
        };
      })
      .catch((error) => ({
        word,
        status: 'error',
        entry: null,
        providersTried: [],
        error:
          'The extension background service could not be reached ' +
          `(${(error && error.message) || error}). Reload the extension and try again.`,
        fromCache: false
      }));

    inFlight.set(word, pending);

    try {
      const result = await pending;
      cache.set(word, result);
      return result;
    } finally {
      inFlight.delete(word);
    }
  }

  return {
    load,
    get: (word) => cache.get(word),
    has: (word) => cache.has(word),
    size: () => cache.size,
    clear: () => cache.clear()
  };
}
