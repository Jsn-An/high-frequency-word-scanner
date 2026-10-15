/**
 * Dictionary lookup orchestrator.
 *
 * Responsibilities:
 *   - try the providers in priority order and stop at the first real hit;
 *   - cache results in memory and in chrome.storage.local so a word is fetched once;
 *   - keep the cache bounded, because chrome.storage.local has a 10 MB quota and this
 *     extension does not request unlimitedStorage;
 *   - deduplicate concurrent lookups of the same word, which happens when an export
 *     prepares many words at once;
 *   - report what each provider answered, so the UI can show provenance and explain a
 *     failed lookup instead of going blank.
 *
 * Status values returned to the UI: 'ok', 'missing' (no source has the word) and 'error'
 * (every source that could answer failed). All three are cached, with different lifetimes.
 */

import {
  DICTIONARY_CACHE_TTL_MS,
  LOOKUP_BUDGET_MS,
  PROVIDER_MIN_SLICE_MS,
  PROVIDER_ORDER,
  PROVIDER_OVERHEAD_MS,
  PROVIDER_TIMEOUT_MS,
  STORAGE_KEYS
} from '../../lib/constants.js';
import * as datamuse from './providers/datamuse.js';
import * as freeDictionary from './providers/free-dictionary.js';
import * as wiktionary from './providers/wiktionary.js';
import * as wordnetOffline from './providers/wordnet-offline.js';

/** Provider registry, in the order given by lib/constants.js. */
const PROVIDERS = new Map([
  ['free-dictionary', freeDictionary],
  ['wiktionary', wiktionary],
  ['datamuse', datamuse],
  ['wordnet-offline', wordnetOffline]
]);

/** Kept for the lifetime of the service worker, which makes a repeat click instant. */
const memoryCache = new Map();

/** In-flight lookups, so two callers never fetch the same word twice. */
const inFlight = new Map();

/** Entries in the storage cache before eviction starts. */
const MAX_CACHED_WORDS = 800;

/** How many of the oldest entries are dropped when the cap is reached. */
const EVICT_BATCH = 200;

/** Cache lifetimes per status. */
const TTL = Object.freeze({
  ok: DICTIONARY_CACHE_TTL_MS,
  missing: 3 * 24 * 60 * 60 * 1000,
  // A failure is worth retrying soon: the network may simply have been down.
  error: 10 * 60 * 1000
});

/** Pause between the two attempts of the last provider, mirrored from the http helper. */
const RETRY_BACKOFF_MS = 250;

/** Single English word, allowing internal hyphens and apostrophes. */
const WORD_PATTERN = /^[a-z][a-z'’-]{0,63}$/;

/**
 * Validates and normalizes the requested word.
 *
 * @param {unknown} value
 * @returns {string|null} Lowercased word, or null when it is not a single word.
 */
export function normalizeLookupWord(value) {
  const word = String(value ?? '').trim().toLowerCase().replace(/\u2019/g, "'");
  if (!WORD_PATTERN.test(word)) return null;
  return word;
}

function cacheKey(word) {
  return `${STORAGE_KEYS.dictionaryPrefix}${word}`;
}

/** True when a cached record is still within its lifetime. */
function isFresh(record) {
  if (!record || typeof record.fetchedAt !== 'number') return false;
  const ttl = TTL[record.status] ?? TTL.error;
  return Date.now() - record.fetchedAt < ttl;
}

/** Reads the cache index used for eviction and statistics. */
async function readIndex() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.dictionaryIndex);
    const index = stored[STORAGE_KEYS.dictionaryIndex];
    return index && typeof index === 'object' ? index : {};
  } catch {
    return {};
  }
}

/**
 * Writes a cache record and keeps the cache bounded.
 *
 * Failure to cache is never fatal: the caller still receives its result, it just gets
 * refetched later.
 */
async function writeCache(word, record) {
  memoryCache.set(word, record);
  try {
    await chrome.storage.local.set({ [cacheKey(word)]: record });

    const index = await readIndex();
    index[word] = record.fetchedAt;
    const words = Object.keys(index);

    if (words.length > MAX_CACHED_WORDS) {
      const oldest = words
        .sort((a, b) => (index[a] || 0) - (index[b] || 0))
        .slice(0, EVICT_BATCH);
      for (const stale of oldest) {
        delete index[stale];
        memoryCache.delete(stale);
      }
      await chrome.storage.local.remove(oldest.map(cacheKey));
    }

    await chrome.storage.local.set({ [STORAGE_KEYS.dictionaryIndex]: index });
  } catch {
    // Quota or a concurrent write: the result is still returned to the caller.
  }
}

/** Reads a cached record, preferring the in-memory copy. */
async function readCache(word, allowExpired) {
  const inMemory = memoryCache.get(word);
  if (inMemory && (allowExpired || isFresh(inMemory))) return inMemory;

  try {
    const key = cacheKey(word);
    const stored = await chrome.storage.local.get(key);
    const record = stored[key];
    if (record && (allowExpired || isFresh(record))) {
      memoryCache.set(word, record);
      return record;
    }
  } catch {
    // Ignore and treat as a cache miss.
  }
  return null;
}

/** Runs the provider chain for one word, inside a fixed wall-clock budget. */
async function runProviders(word) {
  const providersTried = [];
  const offlineAvailable = await wordnetOffline.isAvailable();

  // The providers that could actually answer this word, in priority order. The offline
  // layer is only a candidate when its subset has been imported.
  const candidates = PROVIDER_ORDER.filter(
    (providerId) => providerId !== 'wordnet-offline' || offlineAvailable
  );

  const deadline = Date.now() + LOOKUP_BUDGET_MS;

  for (const providerId of PROVIDER_ORDER) {
    const provider = PROVIDERS.get(providerId);
    if (!provider) continue;

    if (!candidates.includes(providerId)) {
      providersTried.push({
        id: providerId,
        label: provider.label,
        outcome: 'skipped',
        message: 'the offline subset is not installed'
      });
      continue;
    }

    // Hold back one minimum slice for every provider that still has to be tried, so one
    // slow host cannot consume the whole budget and leave the fallbacks unasked.
    const position = candidates.indexOf(providerId);
    const laterCount = candidates.length - position - 1;
    const remaining = deadline - Date.now();
    const reserve = laterCount * (PROVIDER_MIN_SLICE_MS + PROVIDER_OVERHEAD_MS);
    const slice = Math.min(PROVIDER_TIMEOUT_MS, Math.round(remaining - reserve));

    if (slice < PROVIDER_MIN_SLICE_MS) {
      providersTried.push({
        id: providerId,
        label: provider.label,
        outcome: 'skipped',
        budget: true,
        message: `the ${LOOKUP_BUDGET_MS} ms lookup budget ran out`
      });
      continue;
    }

    // Retrying the same host only makes sense when no fallback is left to try instead.
    const wantsRetry = laterCount === 0 && slice >= 2 * PROVIDER_MIN_SLICE_MS + RETRY_BACKOFF_MS;
    const attempts = wantsRetry ? 2 : 1;
    const timeoutMs = wantsRetry ? Math.floor((slice - RETRY_BACKOFF_MS) / 2) : slice;

    try {
      const entry = await provider.lookup(word, { timeoutMs, attempts });
      if (entry) {
        providersTried.push({ id: providerId, label: provider.label, outcome: 'ok', message: '' });
        return { status: 'ok', entry, providersTried, error: null };
      }
      providersTried.push({ id: providerId, label: provider.label, outcome: 'miss', message: '' });
    } catch (error) {
      providersTried.push({
        id: providerId,
        label: provider.label,
        outcome: 'error',
        message: (error && error.message) || String(error)
      });
    }
  }

  const failures = providersTried.filter((attempt) => attempt.outcome === 'error');
  const misses = providersTried.filter((attempt) => attempt.outcome === 'miss');
  const starved = providersTried.filter((attempt) => attempt.budget === true);

  // Every source that could have answered failed, and none of them said "not found":
  // that is a network problem, not a missing word.
  if (failures.length > 0 && misses.length === 0) {
    return {
      status: 'error',
      entry: null,
      providersTried,
      error: failures.map((failure) => failure.message).filter(Boolean).join(' | ') ||
        'Every dictionary source failed.'
    };
  }

  // The budget ran out before some sources were asked, so "no source has this word"
  // cannot be claimed. Report a failure so the panel offers to retry.
  if (starved.length > 0 && misses.length === 0) {
    return {
      status: 'error',
      entry: null,
      providersTried,
      error: `The lookup took longer than the ${LOOKUP_BUDGET_MS} ms budget, so not every source was asked.`
    };
  }

  return {
    status: 'missing',
    entry: null,
    providersTried,
    error: null
  };
}

/**
 * Looks a word up through the provider chain, using the cache when possible.
 *
 * @param {string} rawWord
 * @param {{force?: boolean}} [options] `force` skips the cache and refetches.
 * @returns {Promise<{word: string, status: string, entry: Object|null, providersTried: Array,
 *   error: string|null, fetchedAt: number, fromCache: boolean, allowed: boolean}>}
 */
export async function lookupWord(rawWord, options = {}) {
  const word = normalizeLookupWord(rawWord);
  if (!word) {
    return {
      word: String(rawWord ?? ''),
      status: 'error',
      entry: null,
      providersTried: [],
      error: 'Only single English words with optional hyphens or apostrophes can be looked up.',
      fetchedAt: Date.now(),
      fromCache: false,
      allowed: false
    };
  }

  if (!options.force) {
    const cached = await readCache(word, false);
    if (cached) return Object.assign({}, cached, { word, fromCache: true, allowed: true });
  }

  if (inFlight.has(word)) {
    return inFlight.get(word);
  }

  const pending = (async () => {
    const outcome = await runProviders(word);
    const record = {
      status: outcome.status,
      entry: outcome.entry,
      providersTried: outcome.providersTried,
      error: outcome.error,
      fetchedAt: Date.now()
    };
    await writeCache(word, record);
    return Object.assign({}, record, { word, fromCache: false, allowed: true });
  })().finally(() => {
    inFlight.delete(word);
  });

  inFlight.set(word, pending);
  return pending;
}

/**
 * Statistics and maintenance for the options page.
 *
 * The status breakdown is read from storage rather than from the in-memory map, because a
 * service worker that has just been restarted has an empty memory cache while the storage
 * cache is still full.
 *
 * @returns {Promise<{count: number, byStatus: Record<string, number>, bytes: number,
 *   newestAt: number|null, maxWords: number}>}
 */
export async function getCacheStats() {
  const index = await readIndex();
  const words = Object.keys(index);
  const byStatus = { ok: 0, missing: 0, error: 0 };
  let bytes = 0;
  let newestAt = null;

  if (words.length > 0) {
    try {
      const stored = await chrome.storage.local.get(words.map(cacheKey));
      for (const word of words) {
        const record = stored[cacheKey(word)];
        if (!record) continue;
        if (byStatus[record.status] !== undefined) byStatus[record.status] += 1;
        // Approximate on purpose: measuring the exact serialized size of every record
        // would mean re-encoding the whole cache.
        bytes += JSON.stringify(record).length;
        const fetchedAt = index[word] || record.fetchedAt || 0;
        if (newestAt === null || fetchedAt > newestAt) newestAt = fetchedAt;
      }
    } catch {
      // Storage unavailable: the count from the index is still useful.
    }
  }

  return { count: words.length, byStatus, bytes, newestAt, maxWords: MAX_CACHED_WORDS };
}

/** Removes every cached lookup. */
export async function clearDictionaryCache() {
  memoryCache.clear();
  const index = await readIndex();
  const keys = Object.keys(index).map(cacheKey);
  if (keys.length > 0) await chrome.storage.local.remove(keys);
  await chrome.storage.local.remove(STORAGE_KEYS.dictionaryIndex);
  return keys.length;
}

/** Warms the in-memory cache from storage for a list of words (used before an export). */
export async function primeMemoryCache(words) {
  const wanted = words.map(normalizeLookupWord).filter(Boolean);
  for (const word of wanted) {
    if (!memoryCache.has(word)) {
      // Reading is lazy on purpose: only the words the caller named are touched, so an
      // export of 200 words does not pull the whole cache into memory.
      const record = await readCache(word, true);
      if (record) memoryCache.set(word, record);
    }
  }
  return memoryCache.size;
}
