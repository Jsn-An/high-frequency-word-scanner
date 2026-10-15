/**
 * Provider 4: bundled WordNet subset, read from IndexedDB (optional, offline layer).
 *
 * Priority: last. It exists so the extension still answers when there is no network at
 * all, and it is opt-in because shipping the data would add megabytes to the unpacked
 * folder.
 *
 * How the data gets here: the user runs `node tools/build-wordnet-subset.mjs`, which
 * downloads the WordNet 3.0 database from Princeton, trims it and writes
 * `data/wordnet-subset.ndjson.gz` plus `data/wordnet-LICENSE.txt`. The options page then
 * streams that file once and imports it into IndexedDB. See the README for the exact
 * commands and the resulting file size.
 *
 * Why IndexedDB: chrome.storage.local has a roughly 10 MB default quota and this
 * extension does not request unlimitedStorage. IndexedDB on the extension origin has no
 * such limit and supports keyed reads, so a lookup is one index hit instead of parsing a
 * multi-megabyte blob.
 *
 * When the subset is not installed this provider reports itself as skipped, which costs
 * one `count()` call per service worker lifetime.
 */

import { countWordnetEntries, getWordnetEntry } from '../../../lib/wordnet-store.js';

export const id = 'wordnet-offline';
export const label = 'WordNet 3.0 (local subset)';
export const attribution =
  'WordNet 3.0, Princeton University. Redistributed under its permissive licence.';

/** Cached availability for the lifetime of the service worker. */
let installedCache = null;
let installedCheckedAt = 0;

/** Re-check the database at most this often, so an import is picked up quickly. */
const AVAILABILITY_TTL_MS = 30000;

/**
 * True when a subset has been imported. The answer is cached with a short lifetime so an
 * import performed on the options page (a different JavaScript context) is noticed without
 * needing to restart the worker.
 *
 * @param {boolean} [refresh] Force a fresh count.
 */
export async function isAvailable(refresh = false) {
  const stale = Date.now() - installedCheckedAt > AVAILABILITY_TTL_MS;
  if (installedCache !== null && !refresh && !stale) return installedCache;
  try {
    installedCache = (await countWordnetEntries()) > 0;
  } catch {
    installedCache = false;
  }
  installedCheckedAt = Date.now();
  return installedCache;
}

/** Invalidates the cached availability after an import or a removal. */
export function resetAvailability() {
  installedCache = null;
  installedCheckedAt = 0;
}

/**
 * @param {string} word Lowercased single word.
 * @param {{timeoutMs?: number, attempts?: number}} [budget] Accepted and ignored: this
 *   provider reads a local database and never touches the network.
 * @returns {Promise<Object|null>} The stored normalized entry, or null.
 */
export async function lookup(word, budget = {}) {
  void budget;
  if (!(await isAvailable())) return null;

  try {
    const entry = await getWordnetEntry(word);
    if (!entry || !Array.isArray(entry.meanings) || entry.meanings.length === 0) return null;

    // Entries are stored already normalized; the source label is refreshed here so a
    // subset built by an older script version cannot make the UI lie about provenance.
    return Object.assign({}, entry, { source: label, attribution });
  } catch {
    return null;
  }
}

/** Status for the options page. */
export async function status() {
  try {
    const count = await countWordnetEntries();
    return { installed: count > 0, count };
  } catch {
    return { installed: false, count: 0 };
  }
}
