/**
 * Options page controller.
 *
 * This page owns three things: the default analysis and extraction settings, the
 * dictionary cache controls, and the optional offline WordNet subset. It never talks to a
 * dictionary host directly; the lookup test goes through the same message the detail panel
 * uses, so what you see here is exactly what the results page will see.
 *
 * The import path is the interesting part: data/wordnet-subset.ndjson.gz is streamed,
 * decompressed with DecompressionStream, split into lines and written to IndexedDB in
 * batches of 500. Nothing is ever fully in memory, which is what keeps a multi-megabyte
 * import from freezing the page.
 */

import { normalizeSettings } from '../lib/analyze.js';
import { DEFAULT_SETTINGS, LIMITS, MSG, STORAGE_KEYS } from '../lib/constants.js';
import { clamp, formatBytes, formatCount, formatDateTimeLong } from '../lib/format.js';
import {
  clearWordnetDb,
  countWordnetEntries,
  getWordnetMeta,
  importWordnetEntries,
  setWordnetMeta
} from '../lib/wordnet-store.js';

/** Where the builder script writes its output, relative to the extension root. */
const SUBSET_PATH = 'data/wordnet-subset.ndjson.gz';

/** Entries per IndexedDB transaction during an import. */
const IMPORT_BATCH_SIZE = 500;

const dom = {
  stopWords: document.getElementById('opt-stopwords'),
  lemmatize: document.getElementById('opt-lemmatize'),
  minLength: document.getElementById('opt-minlength'),
  code: document.getElementById('opt-code'),
  boilerplate: document.getElementById('opt-boilerplate'),
  sort: document.getElementById('opt-sort'),
  resetSettings: document.getElementById('reset-settings'),
  settingsState: document.getElementById('settings-state'),
  openResults: document.getElementById('open-results'),

  cacheCount: document.getElementById('cache-count'),
  cacheOk: document.getElementById('cache-ok'),
  cacheMissing: document.getElementById('cache-missing'),
  cacheError: document.getElementById('cache-error'),
  cacheBytes: document.getElementById('cache-bytes'),
  cacheNewest: document.getElementById('cache-newest'),
  refreshCache: document.getElementById('refresh-cache'),
  clearCache: document.getElementById('clear-cache'),
  cacheState: document.getElementById('cache-state'),

  lookupWord: document.getElementById('lookup-word'),
  lookupRun: document.getElementById('lookup-run'),
  lookupForce: document.getElementById('lookup-force'),
  lookupResult: document.getElementById('lookup-result'),

  wordnetStatus: document.getElementById('wordnet-status'),
  wordnetCount: document.getElementById('wordnet-count'),
  wordnetFile: document.getElementById('wordnet-file'),
  wordnetBuilt: document.getElementById('wordnet-built'),
  wordnetProgress: document.getElementById('wordnet-progress'),
  wordnetProgressFill: document.getElementById('wordnet-progress-fill'),
  wordnetProgressDetail: document.getElementById('wordnet-progress-detail'),
  wordnetImport: document.getElementById('wordnet-import'),
  wordnetRemove: document.getElementById('wordnet-remove'),
  wordnetState: document.getElementById('wordnet-state'),

  clearStorage: document.getElementById('clear-storage'),
  storageState: document.getElementById('storage-state'),
  toasts: document.getElementById('toast-region')
};

// --- Small helpers ------------------------------------------------------------

/** Creates an element with a class and optional text. Never builds markup from data. */
function el(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** Transient message in the bottom right corner. */
function toast(message, kind = 'info') {
  const node = el('div', 'toast', message);
  node.dataset.kind = kind;
  dom.toasts.append(node);
  requestAnimationFrame(() => node.classList.add('visible'));
  setTimeout(() => {
    node.classList.remove('visible');
    setTimeout(() => node.remove(), 240);
  }, kind === 'error' ? 6000 : 3600);
}

/** Writes a short status next to a group of buttons. */
function setStatus(node, text, kind = 'info') {
  node.textContent = text;
  node.dataset.kind = kind;
  if (kind === 'success' || kind === 'info') {
    setTimeout(() => {
      if (node.textContent === text) {
        node.textContent = '';
        delete node.dataset.kind;
      }
    }, 4000);
  }
}

/** Bounded delay, so an input change does not write on every keystroke. */
function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// --- Settings ------------------------------------------------------------------

/** Reads the settings object from storage, with defaults filled in. */
async function readSettings() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
    return normalizeSettings(Object.assign({}, DEFAULT_SETTINGS, stored[STORAGE_KEYS.settings] || {}));
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

/** Copies the settings object into the controls. */
function fillControls(settings) {
  dom.stopWords.checked = settings.stopWords;
  dom.lemmatize.checked = settings.lemmatize;
  dom.minLength.value = String(settings.minLength);
  // The control is phrased as "read code blocks", the setting as "exclude code blocks".
  dom.code.checked = !settings.excludeCode;
  dom.boilerplate.checked = settings.excludeBoilerplate;
  dom.sort.value = settings.sort;
}

/** Collects the control values into a settings object. */
function collectSettings() {
  return normalizeSettings({
    stopWords: dom.stopWords.checked,
    lemmatize: dom.lemmatize.checked,
    minLength: dom.minLength.value,
    excludeCode: !dom.code.checked,
    excludeBoilerplate: dom.boilerplate.checked,
    sort: dom.sort.value
  });
}

async function saveSettings() {
  const settings = collectSettings();
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
    fillControls(settings);
    setStatus(dom.settingsState, 'Saved', 'success');
  } catch (error) {
    setStatus(dom.settingsState, 'Could not save the settings.', 'error');
  }
}

const saveSettingsSoon = debounce(saveSettings, 250);

// --- Dictionary cache -----------------------------------------------------------

/** Asks the service worker for cache statistics and renders them. */
async function refreshCacheStats() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG.CACHE_STATS });
    if (!response || !response.ok) throw new Error((response && response.error) || 'no answer');
    const stats = response.stats || {};
    const byStatus = stats.byStatus || {};

    dom.cacheCount.textContent = formatCount(stats.count || 0);
    dom.cacheOk.textContent = formatCount(byStatus.ok || 0);
    dom.cacheMissing.textContent = formatCount(byStatus.missing || 0);
    dom.cacheError.textContent = formatCount(byStatus.error || 0);
    dom.cacheBytes.textContent = formatBytes(stats.bytes || 0);
    dom.cacheNewest.textContent = stats.newestAt ? formatDateTimeLong(stats.newestAt) : 'No lookup yet';
  } catch (error) {
    dom.cacheCount.textContent = 'Unavailable';
    dom.cacheOk.textContent = dom.cacheMissing.textContent = dom.cacheError.textContent = '-';
    dom.cacheBytes.textContent = dom.cacheNewest.textContent = '-';
    setStatus(dom.cacheState, `The service worker did not answer: ${(error && error.message) || error}`, 'error');
  }
}

async function clearCache() {
  dom.clearCache.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG.CACHE_CLEAR });
    if (!response || !response.ok) throw new Error((response && response.error) || 'no answer');
    setStatus(dom.cacheState, `Removed ${formatCount(response.removed || 0)} cached words.`, 'success');
    await refreshCacheStats();
  } catch (error) {
    setStatus(dom.cacheState, `The cache could not be cleared: ${(error && error.message) || error}`, 'error');
  } finally {
    dom.clearCache.disabled = false;
  }
}

// --- Lookup test ----------------------------------------------------------------

/** Renders a normalized entry, or explains why there is none. */
function renderLookupResult(result) {
  dom.lookupResult.replaceChildren();
  dom.lookupResult.hidden = false;

  if (!result || result.status !== 'ok' || !result.entry) {
    const missing = result && result.status === 'missing';
    dom.lookupResult.dataset.kind = missing ? 'warning' : 'error';
    dom.lookupResult.append(
      el('h3', null, missing ? 'No source has an entry for this word' : 'The lookup failed'),
      el('p', 'lookup-meta', (result && result.error) || 'Every source answered empty.')
    );
  } else {
    const entry = result.entry;
    dom.lookupResult.dataset.kind = 'success';
    dom.lookupResult.append(el('h3', null, entry.word));

    const metaParts = [`Source: ${entry.source}`];
    if (entry.phonetic) metaParts.push(`Phonetic: ${entry.phonetic}`);
    metaParts.push(entry.audioUrl ? 'Audio available' : 'No audio');
    if (result.fromCache) metaParts.push('Served from the local cache');
    dom.lookupResult.append(el('p', 'lookup-meta', metaParts.join(' | ')));

    const list = el('ul');
    let written = 0;
    for (const meaning of entry.meanings) {
      for (const definition of meaning.definitions) {
        if (written >= 5) break;
        written += 1;
        const item = el('li');
        item.append(el('strong', null, `${meaning.partOfSpeech}: `));
        item.append(document.createTextNode(definition.definition));
        if (definition.example) {
          item.append(el('span', 'lookup-example', definition.example));
        }
        list.append(item);
      }
    }
    if (written > 0) dom.lookupResult.append(list);
  }

  if (result && Array.isArray(result.providersTried) && result.providersTried.length > 0) {
    const list = el('ul');
    for (const attempt of result.providersTried) {
      list.append(el('li', 'lookup-meta', `${attempt.label}: ${attempt.outcome}${attempt.message ? ` (${attempt.message})` : ''}`));
    }
    dom.lookupResult.append(el('p', 'lookup-meta', 'Sources consulted, in priority order:'), list);
  }
}

async function runLookup(force) {
  const word = dom.lookupWord.value.trim();
  if (!word) {
    dom.lookupWord.focus();
    return;
  }

  const button = force ? dom.lookupForce : dom.lookupRun;
  button.disabled = true;
  dom.lookupResult.hidden = false;
  dom.lookupResult.dataset.kind = 'info';
  dom.lookupResult.replaceChildren(el('p', 'lookup-meta', `Looking up "${word}"...`));

  try {
    const response = await chrome.runtime.sendMessage({ type: MSG.LOOKUP, word, force });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'The service worker did not answer.');
    }
    renderLookupResult(response.result);
  } catch (error) {
    dom.lookupResult.dataset.kind = 'error';
    dom.lookupResult.replaceChildren(
      el('h3', null, 'The lookup could not be started'),
      el('p', 'lookup-meta', (error && error.message) || String(error))
    );
  } finally {
    button.disabled = false;
  }
}

// --- Offline WordNet subset -----------------------------------------------------

/** Reports whether the data file exists, and how large it is. */
async function describeDataFile() {
  const url = chrome.runtime.getURL(SUBSET_PATH);
  try {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    const length = Number(response.headers.get('content-length') || 0);
    dom.wordnetFile.textContent = length ? `Found (${formatBytes(length)})` : 'Found';
    return { present: true, url };
  } catch {
    dom.wordnetFile.textContent = 'Not built yet';
    return { present: false, url };
  }
}

async function refreshWordnetStatus() {
  const file = await describeDataFile();

  try {
    const count = await countWordnetEntries();
    const meta = await getWordnetMeta();

    dom.wordnetCount.textContent = formatCount(count);
    dom.wordnetBuilt.textContent = meta && meta.builtAt ? formatDateTimeLong(meta.builtAt) : '-';
    dom.wordnetStatus.textContent = count > 0 ? 'Installed and in use' : 'Not installed';
    dom.wordnetRemove.disabled = count === 0;
    dom.wordnetImport.disabled = !file.present;
  } catch (error) {
    dom.wordnetStatus.textContent = 'Unavailable';
    dom.wordnetCount.textContent = '-';
    dom.wordnetBuilt.textContent = '-';
    dom.wordnetImport.disabled = !file.present;
    dom.wordnetRemove.disabled = true;
    setStatus(dom.wordnetState, `The local database could not be opened: ${(error && error.message) || error}`, 'error');
  }
}

function showImportProgress(ratio, detail) {
  dom.wordnetProgress.hidden = false;
  dom.wordnetProgressFill.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
  dom.wordnetProgressDetail.textContent = detail;
}

/** Reads the gzipped newline-delimited file and imports it in batches. */
async function importSubset() {
  dom.wordnetImport.disabled = true;
  dom.wordnetRemove.disabled = true;
  dom.wordnetProgress.hidden = false;
  showImportProgress(0, 'Reading the data file...');

  const url = chrome.runtime.getURL(SUBSET_PATH);

  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(
        `The data file was not found (HTTP ${response.status}). Run "node tools/build-wordnet-subset.mjs" in the extension folder first.`
      );
    }

    await clearWordnetDb();

    const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();

    let buffer = '';
    let meta = null;
    let batch = [];
    let imported = 0;
    let skipped = 0;
    let total = 0;

    const flush = async () => {
      if (batch.length === 0) return;
      await importWordnetEntries(batch, undefined, IMPORT_BATCH_SIZE);
      imported += batch.length;
      batch = [];
      showImportProgress(
        total > 0 ? imported / total : 0,
        `${formatCount(imported)} of ${formatCount(total || imported)} entries`
      );
    };

    const handleLine = async (line) => {
      if (!line) return;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        skipped += 1;
        return;
      }

      if (!meta && parsed && parsed.format) {
        meta = parsed;
        total = Number(parsed.entries) || 0;
        showImportProgress(0, `Preparing to import ${formatCount(total)} entries...`);
        return;
      }

      if (parsed && typeof parsed.word === 'string' && Array.isArray(parsed.meanings)) {
        batch.push(parsed);
      } else {
        skipped += 1;
        return;
      }

      if (batch.length >= IMPORT_BATCH_SIZE) await flush();
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += value;

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        await handleLine(line);
        newlineIndex = buffer.indexOf('\n');
      }

      if (done) break;
    }

    if (buffer) await handleLine(buffer);
    await flush();

    await setWordnetMeta(
      Object.assign(
        {
          importedAt: Date.now(),
          skippedLines: skipped
        },
        meta || {}
      )
    );

    // The service worker caches the availability answer, so it has to be told.
    await chrome.runtime.sendMessage({ type: MSG.WORDNET_CHANGED }).catch(() => {});

    showImportProgress(1, `Imported ${formatCount(imported)} entries${skipped ? `, skipped ${formatCount(skipped)} unreadable lines` : ''}.`);
    setStatus(dom.wordnetState, 'Import finished.', 'success');
    toast(`Offline WordNet subset installed: ${formatCount(imported)} entries.`, 'success');
  } catch (error) {
    const message = (error && error.message) || String(error);
    const hint = message.includes('gzip') || message.includes('decompress')
      ? ' The file is not readable gzip output; rebuild it with the script.'
      : '';
    dom.wordnetProgress.hidden = true;
    setStatus(dom.wordnetState, `The import failed: ${message}.${hint}`, 'error');
  } finally {
    await refreshWordnetStatus();
  }
}

async function removeSubset() {
  dom.wordnetRemove.disabled = true;
  try {
    await clearWordnetDb();
    await chrome.runtime.sendMessage({ type: MSG.WORDNET_CHANGED }).catch(() => {});
    setStatus(dom.wordnetState, 'The offline data was removed.', 'success');
    toast('The offline WordNet data was removed from this device.', 'info');
  } catch (error) {
    setStatus(dom.wordnetState, `The data could not be removed: ${(error && error.message) || error}`, 'error');
  } finally {
    dom.wordnetProgress.hidden = true;
    await refreshWordnetStatus();
  }
}

// --- Stored data ----------------------------------------------------------------

/** Removes the scan payload, the saved selections and the dictionary cache. */
async function clearStoredData() {
  dom.clearStorage.disabled = true;
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(
      (key) =>
        key === STORAGE_KEYS.scan ||
        key === STORAGE_KEYS.scanTab ||
        key === STORAGE_KEYS.resultsTab ||
        key === STORAGE_KEYS.dictionaryIndex ||
        key.startsWith(STORAGE_KEYS.selectionPrefix) ||
        key.startsWith(STORAGE_KEYS.dictionaryPrefix)
    );

    if (keys.length > 0) await chrome.storage.local.remove(keys);
    // Settings are deliberately kept: they are preferences, not collected data.
    setStatus(dom.storageState, `Removed ${formatCount(keys.length)} stored entries.`, 'success');
    await refreshCacheStats();
  } catch (error) {
    setStatus(dom.storageState, `The stored data could not be removed: ${(error && error.message) || error}`, 'error');
  } finally {
    dom.clearStorage.disabled = false;
  }
}

// --- Wiring ---------------------------------------------------------------------

for (const control of [dom.stopWords, dom.lemmatize, dom.code, dom.boilerplate]) {
  control.addEventListener('change', () => saveSettingsSoon());
}
dom.minLength.addEventListener('change', () => {
  const [min, max] = LIMITS.minLengthRange;
  dom.minLength.value = String(clamp(dom.minLength.value, min, max, DEFAULT_SETTINGS.minLength));
  saveSettingsSoon();
});
dom.sort.addEventListener('change', () => saveSettingsSoon());

dom.resetSettings.addEventListener('click', async () => {
  fillControls(normalizeSettings(DEFAULT_SETTINGS));
  await saveSettings();
  toast('Settings restored to their defaults.', 'info');
});

dom.openResults.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('results/results.html'), active: true });
});

dom.refreshCache.addEventListener('click', () => refreshCacheStats());
dom.clearCache.addEventListener('click', () => clearCache());

dom.lookupRun.addEventListener('click', () => runLookup(false));
dom.lookupForce.addEventListener('click', () => runLookup(true));
dom.lookupWord.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runLookup(false);
});

dom.wordnetImport.addEventListener('click', () => importSubset());
dom.wordnetRemove.addEventListener('click', () => removeSubset());

dom.clearStorage.addEventListener('click', () => clearStoredData());

// --- Boot -------------------------------------------------------------------------

async function init() {
  fillControls(await readSettings());
  await Promise.all([refreshCacheStats(), refreshWordnetStatus()]);

  // Recorded so a future "privacy notice" reminder can tell whether it has been shown.
  // It is a timestamp and nothing else; no content of any kind is attached to it.
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.privacyAcknowledged);
    if (!stored[STORAGE_KEYS.privacyAcknowledged]) {
      await chrome.storage.local.set({ [STORAGE_KEYS.privacyAcknowledged]: { seenAt: Date.now() } });
    }
  } catch {
    // Not worth reporting: the notice has been displayed either way.
  }
}

init();
