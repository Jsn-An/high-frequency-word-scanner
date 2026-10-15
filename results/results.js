/**
 * Results page controller: header, toolbar, virtualized list, selection, and export.
 *
 * List rendering: windowed virtualization with a recycled pool of row elements. With
 * several thousand unique words, pagination would force the reader to page through the
 * ranking, and incremental appending would grow the DOM without bound and make filtering
 * stutter. A fixed 44 pixel row height makes the window arithmetic exact, keeps the DOM at
 * roughly 40 nodes regardless of the word count, and keeps keyboard navigation
 * deterministic because the active row is always just an index.
 *
 * All analysis happens here (not in the content script) so the three toggles can be
 * re-applied to the stored token list instantly.
 */

import { analyze, filterRecords, normalizeSettings } from '../lib/analyze.js';
import { DEFAULT_SETTINGS, LIMITS, MSG, STORAGE_KEYS } from '../lib/constants.js';
import { clamp, formatCount, formatDateTimeLong, slugify } from '../lib/format.js';
import { buildMarkdown, exportFilename } from '../lib/markdown.js';
import { createDetailPanel } from './detail.js';
import { createLookupClient } from './lookup-client.js';

// --- Element handles ------------------------------------------------------------

const dom = {
  title: document.getElementById('scan-title'),
  url: document.getElementById('scan-url'),
  chips: document.getElementById('scan-chips'),
  truncateNote: document.getElementById('truncate-note'),
  rescan: document.getElementById('btn-rescan'),
  source: document.getElementById('btn-source'),
  search: document.getElementById('search'),
  searchClear: document.getElementById('search-clear'),
  sort: document.getElementById('sort'),
  stopWords: document.getElementById('opt-stopwords'),
  minLength: document.getElementById('opt-minlength'),
  lemmatize: document.getElementById('opt-lemmatize'),
  code: document.getElementById('opt-code'),
  boilerplate: document.getElementById('opt-boilerplate'),
  applyExtraction: document.getElementById('btn-apply-extraction'),
  selectAll: document.getElementById('btn-select-all'),
  selectFiltered: document.getElementById('btn-select-filtered'),
  invert: document.getElementById('btn-invert'),
  clearSelection: document.getElementById('btn-clear-selection'),
  selectionCount: document.getElementById('selection-count'),
  export: document.getElementById('btn-export'),
  viewport: document.getElementById('viewport'),
  spacer: document.getElementById('spacer'),
  rows: document.getElementById('rows'),
  listFooter: document.getElementById('list-footer'),
  emptyState: document.getElementById('empty-state'),
  emptyTitle: document.getElementById('empty-title'),
  emptyBody: document.getElementById('empty-body'),
  confirmDialog: document.getElementById('confirm-dialog'),
  confirmTitle: document.getElementById('confirm-title'),
  confirmBody: document.getElementById('confirm-body'),
  confirmAccept: document.getElementById('confirm-accept'),
  confirmCancel: document.getElementById('confirm-cancel'),
  progressOverlay: document.getElementById('progress-overlay'),
  progressTitle: document.getElementById('progress-title'),
  progressFill: document.getElementById('progress-fill'),
  progressDetail: document.getElementById('progress-detail'),
  progressCancel: document.getElementById('progress-cancel'),
  toasts: document.getElementById('toast-region'),
  rowTemplate: document.getElementById('row-template')
};

// --- State ------------------------------------------------------------------------

const state = {
  payload: null,
  records: [],
  stats: null,
  settings: Object.assign({}, DEFAULT_SETTINGS),
  sort: DEFAULT_SETTINGS.sort,
  query: '',
  filtered: [],
  selection: new Set(),
  activeIndex: 0,
  maxCount: 1,
  sourceTabId: null,
  selectionSaveTimer: 0
};

const lookupClient = createLookupClient();

const ROW_HEIGHT = (() => {
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--row-height')
  );
  return Number.isFinite(value) && value > 0 ? value : 44;
})();

const OVERSCAN_ROWS = 6;

// --- Small utilities --------------------------------------------------------------

/** Transient message in the bottom right corner. */
function notify(message, kind = 'info') {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.dataset.kind = kind;
  toast.textContent = message;
  dom.toasts.append(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));

  const lifetime = kind === 'error' ? 6500 : kind === 'warning' ? 5000 : 3600;
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 240);
  }, lifetime);
}

/** Resolves after `ms`, used to bound a lookup while preparing an export. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms))
  ]);
}

/** Promisified wrapper around the confirmation dialog. */
function confirmDialog({ title, body, acceptLabel }) {
  return new Promise((resolve) => {
    dom.confirmTitle.textContent = title;
    dom.confirmBody.textContent = body;
    dom.confirmAccept.textContent = acceptLabel;

    const cleanup = (result) => {
      dom.confirmAccept.removeEventListener('click', onAccept);
      dom.confirmCancel.removeEventListener('click', onCancel);
      dom.confirmDialog.removeEventListener('close', onCancel);
      if (dom.confirmDialog.open) dom.confirmDialog.close();
      resolve(result);
    };
    const onAccept = () => cleanup(true);
    const onCancel = () => cleanup(false);

    dom.confirmAccept.addEventListener('click', onAccept);
    dom.confirmCancel.addEventListener('click', onCancel);
    dom.confirmDialog.addEventListener('close', onCancel);
    dom.confirmDialog.showModal();
  });
}

let progressCancelHandler = null;

function showProgress({ title, detail, indeterminate = false, onCancel = null }) {
  dom.progressTitle.textContent = title;
  dom.progressDetail.textContent = detail || '';
  dom.progressFill.style.width = indeterminate ? '35%' : '0%';
  dom.progressCancel.hidden = !onCancel;
  progressCancelHandler = onCancel;
  dom.progressOverlay.hidden = false;
}

function updateProgress(ratio, detail) {
  dom.progressFill.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
  if (detail) dom.progressDetail.textContent = detail;
}

function hideProgress() {
  dom.progressOverlay.hidden = true;
  progressCancelHandler = null;
}

dom.progressCancel.addEventListener('click', () => {
  if (progressCancelHandler) progressCancelHandler();
});

// --- Rendering: header ------------------------------------------------------------

function chip(text, variant) {
  const node = document.createElement('span');
  node.className = variant ? `chip ${variant}` : 'chip';
  node.textContent = text;
  return node;
}

/** A chip with a value in bold followed by a label. */
function statChip(value, label) {
  const node = document.createElement('span');
  node.className = 'chip';
  const strong = document.createElement('strong');
  strong.textContent = value;
  node.append(strong, document.createTextNode(` ${label}`));
  return node;
}

function renderHeader() {
  const payload = state.payload;

  if (!payload) {
    dom.title.textContent = 'No scan yet';
    dom.url.textContent = '';
    dom.url.removeAttribute('href');
    dom.chips.replaceChildren();
    dom.truncateNote.hidden = true;
    return;
  }

  dom.title.textContent = payload.title || 'Untitled page';
  dom.url.textContent = payload.url;
  dom.url.href = payload.url;

  const stats = state.stats || {};
  const chips = [
    statChip(formatCount(stats.totalTokens || 0), 'tokens'),
    statChip(formatCount(stats.uniqueWords || 0), 'unique words'),
    chip(`Scanned ${formatDateTimeLong(payload.scannedAt)}`)
  ];

  const extraction = payload.extraction || {};
  chips.push(
    chip(extraction.excludeCode ? 'Code blocks excluded' : 'Code blocks included'),
    chip(extraction.excludeBoilerplate ? 'Boilerplate excluded' : 'Boilerplate included')
  );

  if (stats.droppedStopWords) {
    chips.push(chip(`${formatCount(stats.droppedStopWords)} stop words filtered`));
  }
  if (stats.droppedShort) {
    chips.push(chip(`${formatCount(stats.droppedShort)} short words filtered`));
  }
  if (payload.truncated) {
    chips.push(chip('Scan truncated', 'chip-warning'));
  }

  dom.chips.replaceChildren(...chips);

  if (payload.truncated) {
    dom.truncateNote.hidden = false;
    dom.truncateNote.textContent =
      'This page was larger than the scan limits, so the results are partial: ' +
      `${(payload.truncateReasons || []).join('; ')}.`;
  } else {
    dom.truncateNote.hidden = true;
  }
}

function renderListFooter() {
  if (!state.payload) {
    dom.listFooter.textContent = '';
    return;
  }
  const visible = state.filtered.length;
  const total = state.records.length;
  const parts = [
    state.query
      ? `Showing ${formatCount(visible)} of ${formatCount(total)} words matching "${state.query}"`
      : `Showing ${formatCount(total)} words`
  ];
  const stats = state.stats || {};
  if (stats.droppedStopWords || stats.droppedShort) {
    parts.push(
      `${formatCount((stats.droppedStopWords || 0) + (stats.droppedShort || 0))} tokens removed by the filters`
    );
  }
  parts.push(`${formatCount(stats.countedTokens || 0)} of ${formatCount(stats.totalTokens || 0)} tokens counted`);
  dom.listFooter.textContent = parts.join(' - ');
}

// --- Rendering: the virtualized list ----------------------------------------------

/** Pool of reusable row elements. */
const rowPool = [];

function createRow() {
  const fragment = dom.rowTemplate.content.cloneNode(true);
  const row = fragment.querySelector('.row');
  const checkbox = row.querySelector('.row-checkbox');
  const wordButton = row.querySelector('.row-word');

  checkbox.addEventListener('change', () => {
    const record = state.filtered[Number(row.dataset.index)];
    if (record) setSelected(record.word, checkbox.checked);
  });

  wordButton.addEventListener('click', () => {
    const record = state.filtered[Number(row.dataset.index)];
    if (record) openDetail(record);
  });

  row.addEventListener('click', (event) => {
    // The checkbox owns its own interactions. Leaving the row handler in the path here
    // would re-render the row, and re-rendering writes `checked` back from the selection
    // set, which happens before the checkbox fires its change event. The click would then
    // look like a deselect and no click on the box would ever select anything.
    if (event.target === checkbox) return;

    const record = state.filtered[Number(row.dataset.index)];
    if (!record) return;

    setActiveIndex(Number(row.dataset.index), { scrollIntoView: false });
    if (wordButton.contains(event.target)) return;
    toggleSelection(record.word);
  });

  dom.rows.append(row);
  return row;
}

function ensurePool(size) {
  while (rowPool.length < size) rowPool.push(createRow());
  return rowPool.length;
}

function updateSpacer() {
  dom.spacer.style.height = `${state.filtered.length * ROW_HEIGHT}px`;
}

function updateRow(row, index) {
  const record = state.filtered[index];
  if (!record) {
    row.hidden = true;
    return;
  }

  row.hidden = false;
  row.dataset.index = String(index);
  row.id = `word-row-${index}`;
  row.dataset.selected = state.selection.has(record.word) ? 'true' : 'false';
  row.dataset.active = index === state.activeIndex ? 'true' : 'false';

  const checkbox = row.querySelector('.row-checkbox');
  checkbox.checked = state.selection.has(record.word);
  checkbox.setAttribute('aria-label', `Select the word ${record.word}`);

  row.querySelector('.row-word').textContent = record.word;

  const flag = row.querySelector('.row-flag');
  const oftenCapitalized = record.count >= 5 && record.capitalizedRatio >= 0.8;
  flag.hidden = !oftenCapitalized;
  if (oftenCapitalized) {
    flag.title = `Capitalized in ${formatCount(record.capitalizedCount)} of ${formatCount(
      record.count
    )} occurrences on the page, which usually means a proper noun.`;
  }

  const ratio = state.maxCount > 0 ? record.count / state.maxCount : 0;
  row.querySelector('.row-bar i').style.width = `${Math.max(2, Math.round(ratio * 100))}%`;
  row.querySelector('.row-count').textContent = formatCount(record.count);
}

function renderRows() {
  const total = state.filtered.length;
  const scrollTop = dom.viewport.scrollTop;
  const height = dom.viewport.clientHeight || 0;

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
  const last = Math.min(total, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN_ROWS);
  const needed = Math.max(0, last - first);

  ensurePool(needed);
  dom.rows.style.transform = `translateY(${first * ROW_HEIGHT}px)`;

  for (let slot = 0; slot < rowPool.length; slot += 1) {
    const index = first + slot;
    if (slot >= needed || index >= total) {
      rowPool[slot].hidden = true;
      continue;
    }
    updateRow(rowPool[slot], index);
  }

  updateActiveDescendant();
}

let scrollFramePending = false;

function onScroll() {
  if (scrollFramePending) return;
  scrollFramePending = true;
  requestAnimationFrame(() => {
    scrollFramePending = false;
    renderRows();
  });
}

function updateActiveDescendant() {
  if (state.filtered.length === 0) {
    dom.viewport.removeAttribute('aria-activedescendant');
    return;
  }
  dom.viewport.setAttribute('aria-activedescendant', `word-row-${state.activeIndex}`);
}

function scrollIndexIntoView(index) {
  const top = index * ROW_HEIGHT;
  const bottom = top + ROW_HEIGHT;
  if (top < dom.viewport.scrollTop) {
    dom.viewport.scrollTop = top;
  } else if (bottom > dom.viewport.scrollTop + dom.viewport.clientHeight) {
    dom.viewport.scrollTop = bottom - dom.viewport.clientHeight;
  }
}

function setActiveIndex(index, { scrollIntoView = false } = {}) {
  if (state.filtered.length === 0) {
    state.activeIndex = 0;
    return;
  }
  state.activeIndex = Math.min(state.filtered.length - 1, Math.max(0, index));
  if (scrollIntoView) scrollIndexIntoView(state.activeIndex);
  renderRows();
}

// --- Empty state -------------------------------------------------------------------

function renderEmptyState() {
  if (!state.payload) {
    dom.emptyState.hidden = false;
    dom.emptyTitle.textContent = 'No scan data yet';
    dom.emptyBody.textContent =
      'Open a page and click the scan button in the bottom-left corner. The results of the ' +
      'most recent scan are kept here until the next one replaces them.';
    dom.viewport.hidden = true;
    return;
  }

  if (state.records.length === 0) {
    dom.emptyState.hidden = false;
    dom.emptyTitle.textContent = 'No English words found';
    dom.emptyBody.textContent =
      'The scan found no countable English words. The page may be mostly images, or its text ' +
      'may live inside an iframe (iframes are not scanned). Open the extension options if you ' +
      'want to rescan with a different minimum word length.';
    dom.viewport.hidden = true;
    return;
  }

  if (state.filtered.length === 0) {
    dom.emptyState.hidden = false;
    dom.emptyTitle.textContent = 'No words match the current filters';
    dom.emptyBody.textContent =
      'Try a shorter filter, a lower minimum word length, or turn the stop word filter off.';
    dom.viewport.hidden = true;
    return;
  }

  dom.emptyState.hidden = true;
  dom.viewport.hidden = false;
  // The viewport was display:none while the empty state was up, so it had no measurable
  // height and the row window has to be recomputed now.
  updateSpacer();
  renderRows();
}

// --- Selection ----------------------------------------------------------------------

function saveSelectionSoon() {
  window.clearTimeout(state.selectionSaveTimer);
  state.selectionSaveTimer = window.setTimeout(() => {
    if (!state.payload) return;
    const key = `${STORAGE_KEYS.selectionPrefix}${state.payload.id}`;
    chrome.storage.local
      .set({ [key]: { words: Array.from(state.selection), updatedAt: Date.now() } })
      .catch(() => notify('The selection could not be saved locally.', 'warning'));
  }, 300);
}

function updateSelectionUi() {
  dom.selectionCount.textContent = `${formatCount(state.selection.size)} selected`;
  dom.selectionCount.dataset.hasSelection = state.selection.size > 0 ? 'true' : 'false';
  dom.export.textContent = state.selection.size > 0 ? `Export ${formatCount(state.selection.size)} .md` : 'Export .md';
}

function setSelected(word, selected) {
  if (selected) state.selection.add(word);
  else state.selection.delete(word);
  updateSelectionUi();
  saveSelectionSoon();
  renderRows();
}

function toggleSelection(word) {
  setSelected(word, !state.selection.has(word));
}

// --- Analysis pipeline ----------------------------------------------------------------

/** Recomputes the analysis and re-renders everything that depends on it. */
function recompute({ resetScroll = true } = {}) {
  if (!state.payload) {
    state.records = [];
    state.filtered = [];
    state.stats = null;
    renderHeader();
    renderListFooter();
    renderEmptyState();
    updateSelectionUi();
    dom.applyExtraction.hidden = true;
    return;
  }

  const result = analyze(state.payload, Object.assign({}, state.settings, { sort: state.sort }));
  state.records = result.records;
  state.stats = result.stats;
  state.maxCount = result.records.reduce((max, record) => Math.max(max, record.count), 0);

  // The filters can remove the word the drawer is showing; the drawer keeps its own copy
  // of the record, so nothing breaks, but the stats line shows the page numbers.
  state.filtered = filterRecords(state.records, state.query);
  state.activeIndex = Math.min(state.activeIndex, Math.max(0, state.filtered.length - 1));

  if (resetScroll) dom.viewport.scrollTop = 0;

  updateSpacer();
  renderHeader();
  renderListFooter();
  renderRows();
  renderEmptyState();
  updateSelectionUi();
  updateExtractionDirtyState();
}

/** Re-filters without re-running the analysis (the search box path). */
function applyFilter({ resetScroll = true } = {}) {
  state.filtered = filterRecords(state.records, state.query);
  state.activeIndex = Math.min(state.activeIndex, Math.max(0, state.filtered.length - 1));
  if (resetScroll) dom.viewport.scrollTop = 0;
  updateSpacer();
  renderListFooter();
  renderRows();
  renderEmptyState();
}

/** Shows the "apply extraction settings" button when the toggles differ from the scan. */
function updateExtractionDirtyState() {
  if (!state.payload) {
    dom.applyExtraction.hidden = true;
    return;
  }
  const extraction = state.payload.extraction || {};
  const differs =
    Boolean(extraction.excludeCode) !== Boolean(state.settings.excludeCode) ||
    Boolean(extraction.excludeBoilerplate) !== Boolean(state.settings.excludeBoilerplate);
  dom.applyExtraction.hidden = !differs;
}

// --- Settings persistence --------------------------------------------------------------

async function persistSettings() {
  const settings = Object.assign({}, state.settings, { sort: state.sort });
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  } catch {
    notify('Settings could not be saved.', 'warning');
  }
}

function syncControls() {
  dom.stopWords.checked = state.settings.stopWords;
  dom.lemmatize.checked = state.settings.lemmatize;
  dom.minLength.value = String(state.settings.minLength);
  dom.code.checked = !state.settings.excludeCode;
  dom.boilerplate.checked = state.settings.excludeBoilerplate;
  dom.sort.value = state.sort;
}

// --- Detail panel ---------------------------------------------------------------------

const detail = createDetailPanel({
  getScan: () => ({ payload: state.payload, sourceTabId: state.sourceTabId }),
  isSelected: (word) => state.selection.has(word),
  toggleSelection: (word) => {
    toggleSelection(word);
    detail.refresh();
  },
  notify,
  lookupClient
});

function openDetail(record) {
  detail.open(record.word, record);
}

dom.rows.addEventListener('dblclick', (event) => {
  const row = event.target.closest && event.target.closest('.row');
  if (!row) return;
  const record = state.filtered[Number(row.dataset.index)];
  if (record) openDetail(record);
});

// --- Data loading ----------------------------------------------------------------------

/** Applies a payload: analysis toggles come from settings, extraction state from the scan. */
async function applyPayload(payload, settings, { preserveSelection = false } = {}) {
  const previousSelection = preserveSelection ? new Set(state.selection) : null;

  state.payload = payload;
  state.settings = normalizeSettings(settings);
  state.sort = settings.sort === 'alpha' ? 'alpha' : 'freq';
  state.query = '';
  dom.search.value = '';
  dom.searchClear.hidden = true;

  state.selection = new Set();
  if (previousSelection) {
    state.selection = previousSelection;
  } else if (payload) {
    try {
      const key = `${STORAGE_KEYS.selectionPrefix}${payload.id}`;
      const stored = await chrome.storage.local.get(key);
      const saved = stored[key];
      if (saved && Array.isArray(saved.words)) state.selection = new Set(saved.words);
    } catch {
      // A missing or unreadable selection is not an error: the user simply starts fresh.
    }
  }

  syncControls();
  recompute();
  if (previousSelection) saveSelectionSoon();
}

async function loadFromStorage({ preserveSelection = false } = {}) {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.scan,
    STORAGE_KEYS.settings,
    STORAGE_KEYS.scanTab
  ]);

  const payload = stored[STORAGE_KEYS.scan] || null;
  const settings = Object.assign({}, DEFAULT_SETTINGS, stored[STORAGE_KEYS.settings] || {});
  const scanTab = stored[STORAGE_KEYS.scanTab];

  // The stored tab id is only trusted when it belongs to the scan being displayed.
  state.sourceTabId =
    payload && scanTab && scanTab.scanId === payload.id && typeof scanTab.tabId === 'number'
      ? scanTab.tabId
      : null;

  await applyPayload(payload, settings, { preserveSelection });
}

// --- Toolbar wiring --------------------------------------------------------------------

let searchTimer = 0;

dom.search.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  dom.searchClear.hidden = dom.search.value.length === 0;
  searchTimer = window.setTimeout(() => {
    state.query = dom.search.value.trim();
    applyFilter({ resetScroll: true });
  }, 120);
});

dom.searchClear.addEventListener('click', () => {
  dom.search.value = '';
  dom.searchClear.hidden = true;
  state.query = '';
  applyFilter({ resetScroll: true });
  dom.search.focus();
});

dom.search.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    dom.viewport.focus();
    moveActive(event.key === 'ArrowDown' ? 1 : -1);
  }
});

dom.sort.addEventListener('change', () => {
  state.sort = dom.sort.value === 'alpha' ? 'alpha' : 'freq';
  recompute({ resetScroll: false });
  persistSettings();
});

dom.stopWords.addEventListener('change', () => {
  state.settings.stopWords = dom.stopWords.checked;
  recompute();
  persistSettings();
});

dom.lemmatize.addEventListener('change', () => {
  state.settings.lemmatize = dom.lemmatize.checked;
  recompute();
  persistSettings();
});

dom.minLength.addEventListener('change', () => {
  const [min, max] = LIMITS.minLengthRange;
  state.settings.minLength = clamp(dom.minLength.value, min, max, DEFAULT_SETTINGS.minLength);
  dom.minLength.value = String(state.settings.minLength);
  recompute();
  persistSettings();
});

dom.code.addEventListener('change', () => {
  // The checkbox is "scan code blocks", the setting is "exclude code blocks".
  state.settings.excludeCode = !dom.code.checked;
  updateExtractionDirtyState();
  persistSettings();
});

dom.boilerplate.addEventListener('change', () => {
  state.settings.excludeBoilerplate = dom.boilerplate.checked;
  updateExtractionDirtyState();
  persistSettings();
});

dom.applyExtraction.addEventListener('click', () => rescan());

dom.rescan.addEventListener('click', () => rescan());

dom.source.addEventListener('click', async () => {
  if (typeof state.sourceTabId !== 'number') {
    notify('The scanned tab is no longer known.', 'warning');
    return;
  }
  try {
    await chrome.tabs.update(state.sourceTabId, { active: true });
  } catch {
    notify('The scanned tab has been closed.', 'warning');
  }
});

// --- Bulk actions ------------------------------------------------------------------------

dom.selectAll.addEventListener('click', () => {
  for (const record of state.records) state.selection.add(record.word);
  updateSelectionUi();
  saveSelectionSoon();
  renderRows();
});

dom.selectFiltered.addEventListener('click', () => {
  for (const record of state.filtered) state.selection.add(record.word);
  updateSelectionUi();
  saveSelectionSoon();
  renderRows();
  notify(`${formatCount(state.filtered.length)} filtered words selected.`);
});

dom.invert.addEventListener('click', () => {
  for (const record of state.records) {
    if (state.selection.has(record.word)) state.selection.delete(record.word);
    else state.selection.add(record.word);
  }
  updateSelectionUi();
  saveSelectionSoon();
  renderRows();
});

dom.clearSelection.addEventListener('click', () => {
  state.selection.clear();
  updateSelectionUi();
  saveSelectionSoon();
  renderRows();
});

// --- Keyboard navigation -------------------------------------------------------------------

function moveActive(delta) {
  if (state.filtered.length === 0) return;
  setActiveIndex(state.activeIndex + delta, { scrollIntoView: true });
}

dom.viewport.addEventListener('keydown', (event) => {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      moveActive(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      moveActive(-1);
      break;
    case 'PageDown':
      event.preventDefault();
      moveActive(Math.max(1, Math.floor(dom.viewport.clientHeight / ROW_HEIGHT) - 1));
      break;
    case 'PageUp':
      event.preventDefault();
      moveActive(-Math.max(1, Math.floor(dom.viewport.clientHeight / ROW_HEIGHT) - 1));
      break;
    case 'Home':
      event.preventDefault();
      setActiveIndex(0, { scrollIntoView: true });
      break;
    case 'End':
      event.preventDefault();
      setActiveIndex(state.filtered.length - 1, { scrollIntoView: true });
      break;
    case 'Enter': {
      const record = state.filtered[state.activeIndex];
      if (record) {
        event.preventDefault();
        openDetail(record);
      }
      break;
    }
    case ' ': {
      const record = state.filtered[state.activeIndex];
      if (record) {
        event.preventDefault();
        toggleSelection(record.word);
      }
      break;
    }
    default:
      break;
  }
});

document.addEventListener('keydown', (event) => {
  const target = event.target;
  const typing =
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable);

  // "/" focuses the filter box, the way list tools usually behave.
  if (event.key === '/' && !typing) {
    event.preventDefault();
    dom.search.focus();
    dom.search.select();
  }
});

// --- Rescan ----------------------------------------------------------------------------------

/** Asks the scanned tab to re-extract with the current extraction settings. */
async function rescan() {
  if (typeof state.sourceTabId !== 'number') {
    notify('The tab that was scanned is no longer available, so the page cannot be rescanned.', 'warning');
    return;
  }

  const settings = Object.assign({}, state.settings);
  showProgress({
    title: 'Rescanning the page...',
    detail: 'Re-reading the visible text with the current extraction settings.',
    indeterminate: true
  });

  try {
    const response = await chrome.tabs.sendMessage(state.sourceTabId, {
      type: MSG.RESCAN,
      settings,
      scanId: state.payload ? state.payload.id : undefined
    });
    if (!response || !response.ok) {
      notify((response && response.error) || 'The rescan failed.', 'error');
      return;
    }
    await loadFromStorage({ preserveSelection: true });
    notify('Rescan complete.', 'success');
  } catch {
    notify('The tab that was scanned is no longer available.', 'error');
  } finally {
    hideProgress();
  }
}

// --- Export -----------------------------------------------------------------------------------

/** Creates the file and hands it to the browser's downloader. */
function downloadMarkdown(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some Chrome versions, so the object
  // URL is released a minute later.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Prepares the lookup results for the words being exported, then downloads the file. */
async function exportMarkdown() {
  if (!state.payload) {
    notify('There is nothing to export yet. Scan a page first.', 'warning');
    return;
  }

  let records = state.records.filter((record) => state.selection.has(record.word));

  if (records.length === 0) {
    if (state.records.length === 0) {
      notify('There are no words to export.', 'warning');
      return;
    }
    const accepted = await confirmDialog({
      title: 'Nothing is selected',
      body:
        `Export all ${formatCount(state.records.length)} words instead? Choose "Export all" to build ` +
        'the file from the complete ranked list, or cancel and pick individual words with the checkboxes.',
      acceptLabel: `Export all ${formatCount(state.records.length)}`
    });
    if (!accepted) return;
    records = state.records.slice();
  }

  const control = { cancelled: false };
  const queue = records
    .map((record) => record.word)
    .filter((word) => !lookupClient.has(word));

  if (queue.length > 0) {
    showProgress({
      title: 'Fetching definitions...',
      detail: `0 of ${formatCount(queue.length)} words`,
      onCancel: () => {
        control.cancelled = true;
        hideProgress();
        notify('Export cancelled. Nothing was downloaded.', 'warning');
      }
    });
  }

  try {
    let cursor = 0;
    let completed = 0;

    const worker = async () => {
      while (!control.cancelled) {
        const index = cursor;
        cursor += 1;
        if (index >= queue.length) return;
        const word = queue[index];
        await withTimeout(lookupClient.load(word), LIMITS.exportLookupTimeoutMs);
        completed += 1;
        updateProgress(completed / queue.length, `${formatCount(completed)} of ${formatCount(queue.length)} words`);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(LIMITS.lookupConcurrency, queue.length) }, () => worker())
    );

    if (control.cancelled) return;

    const statusByWord = new Map();
    for (const record of records) {
      const result = lookupClient.get(record.word);
      if (!result) {
        statusByWord.set(record.word, { entry: null, status: 'pending' });
      } else if (result.status === 'ok' && result.entry) {
        statusByWord.set(record.word, { entry: result.entry, status: 'ok' });
      } else {
        statusByWord.set(record.word, { entry: null, status: result.status });
      }
    }

    const exportedAt = Date.now();
    const markdown = buildMarkdown({
      scan: state.payload,
      records,
      statusByWord,
      settings: Object.assign({}, state.settings, {
        excludeCode: (state.payload.extraction || {}).excludeCode,
        excludeBoilerplate: (state.payload.extraction || {}).excludeBoilerplate
      }),
      exportedAt,
      stats: state.stats || {}
    });

    const filename = exportFilename(slugify(state.payload.domain), exportedAt);
    downloadMarkdown(filename, markdown);

    const unresolved = Array.from(statusByWord.values()).filter((value) => !value.entry).length;
    notify(
      `Exported ${formatCount(records.length)} words to ${filename}` +
        (unresolved > 0 ? ` (${formatCount(unresolved)} without a definition).` : '.'),
      unresolved > 0 ? 'warning' : 'success'
    );
  } catch (error) {
    notify(`The export failed: ${(error && error.message) || error}`, 'error');
  } finally {
    hideProgress();
  }
}

dom.export.addEventListener('click', () => {
  exportMarkdown();
});

// --- Cross-context messages ---------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === MSG.SCAN_UPDATED) {
    // The worker reuses this tab when a new scan finishes elsewhere.
    loadFromStorage({ preserveSelection: true }).catch(() => {});
  }
  return undefined;
});

// --- Boot ----------------------------------------------------------------------------------------

function watchViewport() {
  dom.viewport.addEventListener('scroll', onScroll, { passive: true });
  const observer = new ResizeObserver(() => renderRows());
  observer.observe(dom.viewport);
}

async function init() {
  watchViewport();
  syncControls();
  try {
    await loadFromStorage();
  } catch (error) {
    notify(`The saved scan could not be read: ${(error && error.message) || error}`, 'error');
    renderHeader();
    renderEmptyState();
  }
}

init();
