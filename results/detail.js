/**
 * Detail drawer.
 *
 * Contract: this module renders the normalized entry shape only. It never looks at a raw
 * API response, and it never builds DOM from a string, so dictionary text can never
 * become markup.
 *
 * States it can be in, all of them non-blank:
 *   - loading, with a skeleton;
 *   - entry found, with phonetic, part of speech, definitions, examples, audio and source;
 *   - no entry found, listing what each source answered;
 *   - request failed, with the error and a retry button.
 */

import { MSG } from '../lib/constants.js';
import { formatCount, hostnameOf } from '../lib/format.js';

/** Small DOM helper: creates an element with a class and optional text. */
function el(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** Label for the phonetic field, which depends on what the source actually returned. */
function phoneticLabel(entry) {
  if (!entry || !entry.phonetic) return '';
  if (entry.source && entry.source.startsWith('Datamuse')) {
    // Datamuse returns an ARPAbet hint (CMUdict style), not IPA. Saying so avoids
    // presenting it as something it is not.
    return 'Pronunciation hint, ARPAbet';
  }
  return 'Phonetic';
}

const OUTCOME_TEXT = Object.freeze({
  ok: 'found an entry',
  miss: 'no entry for this spelling',
  error: 'failed',
  skipped: 'skipped'
});

/**
 * Creates the drawer controller.
 *
 * @param {Object} options
 * @param {() => {payload: Object|null, sourceTabId: number|null}} options.getScan
 * @param {(word: string) => void} options.toggleSelection
 * @param {(word: string) => boolean} options.isSelected
 * @param {(message: string, kind?: string) => void} options.notify
 * @param {{load: Function, get: Function, has: Function}} options.lookupClient
 * @param {(record: Object, entry: Object|null) => void} [options.onEntryLoaded]
 * @returns {Object} The panel API.
 */
export function createDetailPanel(options) {
  const { getScan, toggleSelection, isSelected, notify, lookupClient, onEntryLoaded } = options;

  const drawer = document.getElementById('drawer');
  const scrim = document.getElementById('scrim');
  const wordHeading = document.getElementById('drawer-word');
  const subtitle = document.getElementById('drawer-subtitle');
  const body = document.getElementById('drawer-body');
  const footer = document.getElementById('drawer-foot');
  const closeButton = document.getElementById('drawer-close');

  let requestToken = 0;
  let currentWord = null;
  let currentRecord = null;
  let audioElement = null;

  footer.textContent =
    'Wiktionary content is used under CC BY-SA 3.0 with attribution. WordNet 3.0 is ' +
    'redistributed under its permissive licence. Definitions are only requested for the ' +
    'words you open.';

  closeButton.addEventListener('click', () => close());
  scrim.addEventListener('click', () => close());

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      close();
    }
  });

  function isOpen() {
    return drawer.classList.contains('open');
  }

  function close() {
    if (!isOpen()) return;
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('drawer-open');
    scrim.hidden = true;
    stopAudio();
    currentWord = null;
    currentRecord = null;
  }

  function stopAudio() {
    if (audioElement) {
      audioElement.pause();
      audioElement = null;
    }
  }

  /** Opens the drawer for a word. Cached or in-flight results render immediately. */
  async function open(word, record, { force = false } = {}) {
    currentWord = word;
    currentRecord = record || null;
    const token = ++requestToken;

    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('drawer-open');
    scrim.hidden = false;
    stopAudio();

    wordHeading.textContent = word;
    renderSubtitle(record);

    // A word the user already opened renders instantly, including after a page refresh if
    // the service worker still has it cached. That is the "repeat clicks are instant" path.
    if (!force) {
      const cached = lookupClient.get(word);
      if (cached) {
        renderResult(word, record, cached, { fromCache: true });
        return;
      }
    }

    renderLoading();

    try {
      const result = await lookupClient.load(word, { force });
      if (token !== requestToken) return; // another word was opened meanwhile
      renderResult(word, record, result, { fromCache: !!result.fromCache });
    } catch (error) {
      if (token !== requestToken) return;
      renderFailure(word, record, (error && error.message) || String(error));
    }
  }

  /** Re-renders the open word, for example after a selection change. */
  function refresh() {
    if (!currentWord) return;
    renderSubtitle(currentRecord);
    const cached = lookupClient.get(currentWord);
    if (cached) renderResult(currentWord, currentRecord, cached, { fromCache: true });
  }

  function renderSubtitle(record) {
    if (!record) {
      subtitle.textContent = '';
      return;
    }
    const parts = [`${formatCount(record.count)} occurrence${record.count === 1 ? '' : 's'} on this page`];
    if (record.variants && record.variants.length > 1) {
      parts.push(`forms: ${record.variants.slice(0, 6).join(', ')}`);
    }
    subtitle.textContent = parts.join(' - ');
  }

  function renderLoading() {
    body.replaceChildren();
    const wrapper = el('div', 'detail-loading');
    for (const width of ['w-40', 'w-85', 'w-60', 'w-85', 'w-60']) {
      const line = el('div', `skeleton line ${width}`);
      line.style.height = '12px';
      wrapper.append(line);
    }
    body.append(wrapper);
  }

  /** Renders a transport-level failure (the worker could not be reached at all). */
  function renderFailure(word, record, message) {
    body.replaceChildren();
    const box = el('div', 'detail-message', message);
    box.dataset.kind = 'error';
    body.append(box, buildActions(word, record, { showRetry: true }));
  }

  /** The action row: select, reveal on the page, and retry or refresh. */
  function buildActions(word, record, { showRetry = false, retryLabel = 'Retry' } = {}) {
    const actions = el('div', 'detail-actions');

    const selected = isSelected(word);
    const selectButton = el('button', 'btn btn-sm', selected ? 'Remove from selection' : 'Select this word');
    selectButton.type = 'button';
    selectButton.addEventListener('click', () => {
      toggleSelection(word);
      selectButton.textContent = isSelected(word) ? 'Remove from selection' : 'Select this word';
    });
    actions.append(selectButton);

    if (record) {
      const revealButton = el('button', 'btn btn-sm', 'Show on page');
      revealButton.type = 'button';
      revealButton.addEventListener('click', () => revealOnPage(record));
      actions.append(revealButton);
    }

    if (showRetry) {
      const retryButton = el('button', 'btn btn-sm', retryLabel);
      retryButton.type = 'button';
      retryButton.addEventListener('click', () => open(word, record, { force: true }));
      actions.append(retryButton);
    }

    return actions;
  }

  /** Renders a lookup result, whatever its status. */
  function renderResult(word, record, result, { fromCache }) {
    body.replaceChildren();

    renderSubtitle(record);

    if (result.status !== 'ok' || !result.entry) {
      const missing = result.status === 'missing';
      const box = el(
        'div',
        'detail-message',
        missing
          ? 'No entry found for this word in the configured sources.'
          : result.error || 'The lookup failed.'
      );
      box.dataset.kind = missing ? 'warning' : 'error';
      body.append(box);
      body.append(buildProvidersList(result.providersTried));
      body.append(buildActions(word, record, { showRetry: !missing }));
      return;
    }

    const entry = result.entry;

    // Stats first: this is what the user came from the list for.
    const stats = el('dl', 'detail-stats');
    stats.append(
      statPair('Occurrences', formatCount(record ? record.count : 0)),
      statPair(
        'Capitalized',
        record ? `${formatCount(record.capitalizedCount)} (${Math.round((record.capitalizedRatio || 0) * 100)}%)` : '-'
      )
    );
    body.append(stats);

    if (entry.phonetic) {
      const row = el('div', 'detail-row');
      row.append(el('span', 'detail-phonetic', entry.phonetic));
      row.append(el('span', 'chip', phoneticLabel(entry)));
      if (entry.audioUrl) row.append(buildAudioButton(entry.audioUrl));
      body.append(row);
    }

    if (entry.meanings.length === 0) {
      const box = el('div', 'detail-message', 'This source returned no definition text.');
      box.dataset.kind = 'warning';
      body.append(box);
    }

    for (const meaning of entry.meanings) {
      const section = el('section', 'detail-meaning');
      section.append(el('span', 'detail-pos', meaning.partOfSpeech));
      const list = el('ol', 'detail-definitions');
      for (const definition of meaning.definitions) {
        const item = el('li');
        item.append(document.createTextNode(definition.definition));
        if (definition.example) {
          item.append(el('span', 'detail-example', definition.example));
        }
        list.append(item);
      }
      section.append(list);
      body.append(section);
    }

    const sourceLine = el('p', 'detail-source-line');
    sourceLine.append(document.createTextNode('Definition source: '));
    if (entry.sourceUrl) {
      const link = el('a', null, entry.source);
      link.href = entry.sourceUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      sourceLine.append(link);
    } else {
      sourceLine.append(document.createTextNode(entry.source));
    }
    if (entry.license) {
      sourceLine.append(document.createTextNode(` - licence: ${entry.license}`));
    }
    if (fromCache) {
      sourceLine.append(document.createTextNode(' - served from the local cache'));
    }
    body.append(sourceLine);

    if (!entry.audioUrl) {
      const note = el(
        'p',
        'detail-source-line',
        'This source does not provide an audio recording for this word.'
      );
      body.append(note);
    }

    body.append(buildActions(word, record, { showRetry: true, retryLabel: 'Refresh definition' }));
    if (result.providersTried && result.providersTried.length > 1) {
      body.append(buildProvidersList(result.providersTried));
    }

    if (onEntryLoaded) onEntryLoaded(record, entry);
  }

  function statPair(label, value) {
    const wrapper = el('div', 'detail-stat');
    wrapper.append(el('dt', null, label), el('dd', null, value));
    return wrapper;
  }

  function buildAudioButton(audioUrl) {
    const button = el('button', 'detail-audio');
    button.type = 'button';
    button.setAttribute('aria-label', 'Play the pronunciation');
    button.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
      '<path d="M4 2.5v11l8-5.5-8-5.5z" fill="currentColor"/></svg>';
    button.append(document.createTextNode('Play audio'));
    button.addEventListener('click', () => {
      stopAudio();
      audioElement = new Audio(audioUrl);
      audioElement.play().catch(() => {
        notify('The audio file could not be played.', 'warning');
      });
    });
    return button;
  }

  /** Lists what each provider answered, which is what makes a failed lookup explainable. */
  function buildProvidersList(providersTried) {
    if (!Array.isArray(providersTried) || providersTried.length === 0) return document.createDocumentFragment();

    const wrapper = el('div');
    wrapper.append(el('p', 'detail-source-line', 'Sources consulted, in priority order:'));
    const list = el('ul', 'detail-providers');
    for (const attempt of providersTried) {
      const text = `${attempt.label}: ${OUTCOME_TEXT[attempt.outcome] || attempt.outcome}${
        attempt.message ? ` (${attempt.message})` : ''
      }`;
      list.append(el('li', null, text));
    }
    wrapper.append(list);
    return wrapper;
  }

  /** Asks the scanned tab to select and scroll to the first occurrence of this word. */
  async function revealOnPage(record) {
    const scan = getScan();
    const tabId = scan && scan.sourceTabId;
    if (typeof tabId !== 'number') {
      notify('The scanned tab is no longer known, so the word cannot be located.', 'warning');
      return;
    }

    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: MSG.HIGHLIGHT,
        tokenIndex: record.firstIndex
      });
      if (!response || !response.ok) {
        notify((response && response.error) || 'The word could not be located on the page.', 'warning');
        return;
      }
      try {
        await chrome.tabs.update(tabId, { active: true });
      } catch {
        // Activating the tab is a nicety; the selection is already in place.
      }
    } catch {
      notify(
        `The tab that was scanned is no longer available (${hostnameOf(scan && scan.payload && scan.payload.url)}).`,
        'warning'
      );
    }
  }

  return { open, close, isOpen, refresh, currentWord: () => currentWord };
}
