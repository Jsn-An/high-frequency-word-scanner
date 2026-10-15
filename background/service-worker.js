/**
 * Service worker: the only place in the extension that talks to the network.
 *
 * Why the network lives here and not in the content script or the results page:
 *   - Requests from the service worker use the extension origin, so the hostnames in
 *     `host_permissions` remove every CORS restriction. Dictionary APIs that do not send
 *     permissive CORS headers still work, and no preflight is sent.
 *   - A content script would inherit the page's origin and CSP, which is exactly how
 *     these requests usually fail.
 *   - One worker means one cache, so a word fetched for the detail panel is already there
 *     when an export needs it.
 *
 * The worker also owns tab management: it opens the results page from the scanning tab,
 * reuses the results tab if one is already open, and records which tab a scan came from so
 * the page can ask that tab to reveal a word.
 */

import {
  DEFAULT_SETTINGS,
  MSG,
  RESULTS_PAGE_PATH,
  STORAGE_KEYS
} from '../lib/constants.js';
import { clearDictionaryCache, getCacheStats, lookupWord } from './dictionary/lookup.js';
import { resetAvailability } from './dictionary/providers/wordnet-offline.js';

const RESULTS_URL = chrome.runtime.getURL(RESULTS_PAGE_PATH);

// --- Lifecycle ------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  ensureSettings();
  if (details.reason === 'install') {
    // Open the options page once, so the privacy statement, the data sources and the
    // optional offline layer are visible before the first scan.
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureSettings();
});

/** Writes the default settings on first run so the UI never has to guess. */
async function ensureSettings() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
    if (!stored[STORAGE_KEYS.settings]) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.settings]: Object.assign({}, DEFAULT_SETTINGS)
      });
    }
  } catch (error) {
    console.warn('Could not initialize settings:', (error && error.message) || error);
  }
}

// --- Results tab ----------------------------------------------------------------

/**
 * Opens the results page, or brings an already open one back to the front.
 *
 * Reusing the tab is possible without the `tabs` permission: the extension remembers the
 * tab id it created and updates that id. If the tab is gone, `tabs.update` rejects and a
 * new tab is created instead.
 */
async function openResults(message, sender) {
  const scanId = typeof message.scanId === 'string' ? message.scanId : '';
  const sourceTabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;

  if (sourceTabId !== null) {
    await chrome.storage.local.set({ [STORAGE_KEYS.scanTab]: { scanId, tabId: sourceTabId } });
  }

  const stored = await chrome.storage.local.get(STORAGE_KEYS.resultsTab);
  const previous = stored[STORAGE_KEYS.resultsTab];

  if (previous && typeof previous.tabId === 'number') {
    try {
      await chrome.tabs.update(previous.tabId, { active: true });
      await chrome.storage.local.set({
        [STORAGE_KEYS.resultsTab]: { tabId: previous.tabId, scanId }
      });
      // Ask the page to re-read the payload. If the page is not listening (a different
      // page is loaded in that tab), the rejection is expected and ignored.
      chrome.runtime.sendMessage({ type: MSG.SCAN_UPDATED, scanId }).catch(() => {});
      return { ok: true, reused: true, tabId: previous.tabId };
    } catch {
      // The remembered tab no longer exists; fall through and create one.
    }
  }

  const tab = await chrome.tabs.create({ url: RESULTS_URL, active: true });
  await chrome.storage.local.set({ [STORAGE_KEYS.resultsTab]: { tabId: tab.id, scanId } });
  return { ok: true, reused: false, tabId: tab.id };
}

// --- Lookups -------------------------------------------------------------------

/** Resolves one word. The result object is what the detail panel renders. */
async function handleLookup(message) {
  const result = await lookupWord(message && message.word, { force: !!(message && message.force) });
  return { ok: true, result };
}

// --- Message routing -----------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  switch (message.type) {
    case MSG.OPEN_RESULTS:
      openResults(message, sender)
        .then(sendResponse)
        .catch((error) => {
          console.error('Could not open the results page:', (error && error.message) || error);
          sendResponse({ ok: false, error: (error && error.message) || String(error) });
        });
      return true; // async response

    case MSG.LOOKUP:
      handleLookup(message)
        .then(sendResponse)
        .catch((error) => {
          console.warn('Lookup failed:', (error && error.message) || error);
          sendResponse({ ok: false, error: (error && error.message) || String(error) });
        });
      return true; // async response

    case MSG.CACHE_STATS:
      getCacheStats()
        .then((stats) => sendResponse({ ok: true, stats }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;

    case MSG.CACHE_CLEAR:
      clearDictionaryCache()
        .then((removed) => sendResponse({ ok: true, removed }))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;

    case MSG.WORDNET_CHANGED:
      resetAvailability();
      sendResponse({ ok: true });
      return false;

    case MSG.SCAN_FAILED:
      // Reported by the content script so a failing scan is visible in one place.
      console.warn('Content script reported a failed scan:', message.message);
      return undefined;

    default:
      return undefined;
  }
});

// --- Debug helpers --------------------------------------------------------------

// Exposed for manual poking from the service worker console during development.
self.hfwsDebug = {
  lookup: (word, force = false) => lookupWord(word, { force }),
  cacheStats: () => getCacheStats(),
  clearCache: () => clearDictionaryCache()
};
