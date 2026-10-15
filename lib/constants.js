/**
 * Shared constants for the extension.
 *
 * This module is imported by the service worker (which is a module worker) and by
 * extension pages (which load ES modules directly). The content script is a classic
 * script and cannot import modules, so it repeats the three literals it needs
 * (the two storage keys and the three message types). Keep those in sync.
 */

/** Keys used in chrome.storage.local. */
export const STORAGE_KEYS = Object.freeze({
  /** The most recent scan payload. */
  scan: 'scan.current',
  /** User settings (analysis toggles plus extraction switches). */
  settings: 'settings',
  /** Per-scan saved selection: `selection:<scanId>` -> { words: string[], updatedAt: number }. */
  selectionPrefix: 'selection:',
  /** Per-word dictionary cache: `dictionary:<word>` -> CachedLookup. */
  dictionaryPrefix: 'dictionary:',
  /** Index of cached words with their timestamps, used for eviction and stats. */
  dictionaryIndex: 'dictionary.index',
  /** Set once when the user has seen the privacy notice on the options page. */
  privacyAcknowledged: 'privacy.acknowledged',
  /** Id of the results tab, so a new scan reuses it instead of opening another one. */
  resultsTab: 'results.tab',
  /** Id of the tab a scan came from, so the results page can reveal a word on the page. */
  scanTab: 'scan.tab'
});

/** Message types exchanged between content script, service worker and pages. */
export const MSG = Object.freeze({
  /** content script -> service worker: a scan payload has been stored, open the results page. */
  OPEN_RESULTS: 'scan/openResults',
  /** service worker -> results page: a newer scan is available, reload from storage. */
  SCAN_UPDATED: 'scan/updated',
  /** content script -> service worker: a scan failed, only logged. */
  SCAN_FAILED: 'scan/failed',
  /** results page -> service worker: resolve one word through the provider chain. */
  LOOKUP: 'dictionary/lookup',
  /** options page -> service worker: dictionary cache statistics. */
  CACHE_STATS: 'dictionary/cacheStats',
  /** options page -> service worker: drop every cached lookup. */
  CACHE_CLEAR: 'dictionary/cacheClear',
  /** options page -> service worker: the offline subset was imported or removed. */
  WORDNET_CHANGED: 'wordnet/changed',
  /** results page -> content script: reveal the n-th token of the last scan. */
  HIGHLIGHT: 'page/highlight',
  /** results page -> content script: rescan the page with fresh extraction settings. */
  RESCAN: 'page/rescan'
});

/** Bounds enforced while walking the DOM. */
export const LIMITS = Object.freeze({
  /** Stop collecting text after this many characters of visible text. */
  maxChars: 200000,
  /** Stop walking after this many DOM nodes, whichever comes first. */
  maxNodes: 120000,
  /** Hard ceiling on stored tokens, as a second safety net. */
  maxTokens: 60000,
  /** Minimum and maximum accepted values for the "minimum word length" control. */
  minLengthRange: [1, 20],
  /** Concurrent dictionary lookups issued by the results page. */
  lookupConcurrency: 3,
  /** Per-word budget for one lookup when the results page prepares an export. */
  exportLookupTimeoutMs: 7000
});

/** Defaults for both the analysis toggles and the extraction switches. */
export const DEFAULT_SETTINGS = Object.freeze({
  /** Merge running / runs / ran into run. */
  lemmatize: true,
  /** Drop words that carry little information (the, and, of ...). */
  stopWords: true,
  /** Drop words shorter than this many characters. */
  minLength: 3,
  /** Skip code and preformatted blocks while extracting. */
  excludeCode: true,
  /** Skip navigation, cookie banners and footers while extracting. */
  excludeBoilerplate: false,
  /** Default ordering of the results list: 'freq' or 'alpha'. */
  sort: 'freq'
});

/** Path of the results page, relative to the extension root. */
export const RESULTS_PAGE_PATH = 'results/results.html';

/** Dictionary cache entries older than this are refreshed on the next lookup. */
export const DICTIONARY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Per-provider network budget. */
export const PROVIDER_TIMEOUT_MS = 6000;

/**
 * Total wall clock a single lookup may spend in the provider chain, across every source
 * and every retry.
 *
 * Without a ceiling, one unresponsive host multiplies out: four providers times two
 * attempts times the per-request timeout is over a minute, and the detail panel would sit
 * on its skeleton the whole time. With a ceiling the panel always resolves to either an
 * entry or a message the user can act on, and the retry button re-runs the chain.
 */
export const LOOKUP_BUDGET_MS = 7000;

/** A provider is not started with less than this much of the budget left. */
export const PROVIDER_MIN_SLICE_MS = 900;

/**
 * Charged against the budget for each provider that still has to be tried, on top of its
 * minimum slice. Without it the reserved slices add up to the budget exactly, and a few
 * milliseconds of ordinary await and rounding overhead are enough to push a fallback
 * below PROVIDER_MIN_SLICE_MS and skip it.
 */
export const PROVIDER_OVERHEAD_MS = 150;

/**
 * Identifying header sent with Wikimedia requests.
 *
 * Browsers forbid setting the `User-Agent` header from fetch(), so Wikimedia's
 * documented alternative for browser clients is used instead: a descriptive
 * `Api-User-Agent` value. Keep it descriptive if you fork this extension.
 */
export const WIKIMEDIA_API_USER_AGENT =
  'HighFrequencyWordScanner/1.0 (Chrome extension; local word-frequency tool; deterministic User-Agent policy)';

/** IndexedDB database that holds the optional offline WordNet subset. */
export const WORDNET_DB = Object.freeze({
  name: 'hfws-wordnet',
  version: 1,
  entriesStore: 'entries',
  metaStore: 'meta'
});

/** Key inside the metadata store that records where the subset came from. */
export const WORDNET_META_KEY = 'subset';

/** Provider identifiers, in the order they are tried. */
export const PROVIDER_ORDER = Object.freeze([
  'free-dictionary',
  'wiktionary',
  'datamuse',
  'wordnet-offline'
]);
