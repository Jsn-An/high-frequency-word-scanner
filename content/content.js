/**
 * Content script: floating scan button, chunked text extraction, tokenizer and the
 * "reveal on page" helper.
 *
 * Why this file is a classic script and not a module: modules cannot be declared in a
 * content_scripts entry, and loading one through a dynamic import of a
 * web_accessible_resource makes the script depend on the host page's CSP. So the file
 * repeats the handful of shared literals it needs (storage keys, message types, default
 * settings) instead of importing them. Keep them in sync with lib/constants.js.
 *
 * What this file deliberately does NOT do: count, filter, lemmatize or rank words. It
 * only produces the ordered token list, because the analysis toggles live on the results
 * page and must be re-appliable without a rescan.
 */

(() => {
  'use strict';

  // --- Guards -----------------------------------------------------------------

  // The button belongs to the top level document only. iframes are out of scope, which
  // is stated in the README: scanning them would need all_frames and would double count
  // embedded widgets.
  if (window.top !== window) return;

  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;

  const HOST_ID = 'hfws-floating-host';
  if (document.getElementById(HOST_ID)) return; // already injected into this document

  // --- Shared literals (must match lib/constants.js) ---------------------------

  const STORAGE_SCAN_KEY = 'scan.current';
  const STORAGE_SETTINGS_KEY = 'settings';

  const MSG_OPEN_RESULTS = 'scan/openResults';
  const MSG_SCAN_FAILED = 'scan/failed';
  const MSG_HIGHLIGHT = 'page/highlight';
  const MSG_RESCAN = 'page/rescan';

  const DEFAULT_SETTINGS = {
    lemmatize: true,
    stopWords: true,
    minLength: 3,
    excludeCode: true,
    excludeBoilerplate: false,
    sort: 'freq'
  };

  const LIMITS = {
    maxChars: 200000,
    maxNodes: 120000,
    maxTokens: 60000
  };

  /** 4 ms of work per slice keeps the main thread responsive during long scans. */
  const SLICE_BUDGET_MS = 4;

  /** One space is inserted between text nodes, so tokens never merge across nodes. */
  const TEXT_SEPARATOR = ' ';

  // --- Text matching -----------------------------------------------------------

  /**
   * English word pattern. Letters, plus internal apostrophes (straight, curly) and
   * hyphens. A token can never begin or end with a separator because both groups
   * require surrounding letters.
   */
  const WORD_PATTERN = /[A-Za-z]+(?:['\u2018\u2019-][A-Za-z]+)*/g;

  /**
   * Ranges that are never counted as words: URLs, email addresses, and filenames or
   * paths with a known file extension. Digits-only tokens cannot match WORD_PATTERN in
   * the first place, so they need no separate rule.
   *
   * The extension list doubles as the filename detector; matching is case-insensitive
   * and the ranges are subtracted from the word matches.
   */
  const NON_WORD_PATTERN = new RegExp(
    [
      // URLs, with or without a scheme
      '(?:[a-z][a-z0-9+.\\-]*:\\/\\/|www\\.)[^\\s<>"\'`)\\]}]+',
      // Email addresses
      '|[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}',
      // Filenames and paths with a known extension
      '|(?:[A-Za-z0-9_.\\-/]+)\\.(?:html?|xhtml|css|scss|sass|less|jsx?|mjs|cjs|tsx?|' +
        'json5?|xml|ya?ml|toml|ini|cfg|conf|md|markdown|rst|txt|csv|tsv|log|lock|' +
        'png|jpe?g|gif|webp|avif|bmp|ico|svg|pdf|docx?|xlsx?|pptx?|zip|tar|gz|bz2|' +
        'xz|7z|rar|mp3|mp4|wav|ogg|webm|mov|avi|woff2?|ttf|otf|eot|exe|msi|dmg|apk|' +
        'deb|rpm|sh|bash|zsh|fish|py|ipynb|rb|go|rs|java|kt|swift|cc|cpp|hpp|cs|php|' +
        'sql|pl|lua|scala|dart|vue|svelte)\\b'
    ].join(''),
    'gi'
  );

  /** Tags whose text is never readable prose. */
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT',
    'EMBED', 'AUDIO', 'VIDEO', 'MAP', 'AREA', 'HEAD', 'TITLE', 'META', 'LINK',
    'SOURCE', 'TRACK', 'PARAM', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'OPTGROUP'
  ]);

  /** Tags skipped only when the "exclude code blocks" setting is on (the default). */
  const CODE_TAGS = new Set(['CODE', 'PRE', 'SAMP', 'KBD', 'VAR']);

  /** Boilerplate heuristics, used only when the "exclude boilerplate" setting is on. */
  const BOILERPLATE_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE']);
  const BOILERPLATE_ROLES = new Set([
    'navigation', 'banner', 'contentinfo', 'search', 'complementary', 'menu',
    'menubar', 'menuitem', 'dialog', 'alertdialog', 'toolbar', 'tablist'
  ]);
  const BOILERPLATE_PATTERN =
    /(?:^|[\s_-])(?:nav|navbar|navigation|menu|sidebar|side-bar|breadcrumb|breadcrumbs|cookie|consent|gdpr|tracking|privacy-?(?:banner|notice|policy)-?(?:banner|notice)?|banner|advert|ad|ads|adsbygoogle|promo|newsletter|subscribe|social|share|sharing|footer|masthead|copyright|legal|disclaimer|skip-link|toolbar|pagination|pager|comments?|related-posts|recommendations|sponsored|paywall|modal|popup|overlay|toast|snackbar)(?:$|[\s_-])/i;

  // --- Settings ----------------------------------------------------------------

  /** Reads settings from chrome.storage.local with defaults filled in. */
  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get(STORAGE_SETTINGS_KEY);
      return Object.assign({}, DEFAULT_SETTINGS, stored[STORAGE_SETTINGS_KEY] || {});
    } catch {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  /** Persists extraction settings so the next scan and the results page agree. */
  async function saveSettings(settings) {
    try {
      const merged = Object.assign({}, DEFAULT_SETTINGS, settings);
      await chrome.storage.local.set({ [STORAGE_SETTINGS_KEY]: merged });
      return merged;
    } catch {
      return Object.assign({}, DEFAULT_SETTINGS, settings);
    }
  }

  // --- Shadow DOM user interface ------------------------------------------------

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-hfws-ignore', 'true');

  // The host element lives in the page, so it is the only part that page CSS could
  // touch. Everything critical is therefore set as an inline !important declaration,
  // which outranks any author rule in the page, and the host is kept as a zero-sized
  // fixed box so it cannot shift the page layout.
  for (const [property, value] of Object.entries({
    all: 'initial',
    position: 'fixed',
    top: '0',
    left: '0',
    width: '0',
    height: '0',
    margin: '0',
    padding: '0',
    border: '0',
    display: 'block',
    'pointer-events': 'none'
  })) {
    host.style.setProperty(property, value, 'important');
  }

  const shadow = host.attachShadow({ mode: 'open' });

  const shadowStyles = `
    :host { all: initial; }

    * { box-sizing: border-box; }

    .dock {
      --hfws-accent: #3b6ef6;
      --hfws-accent-strong: #2b5ae0;
      --hfws-surface: #ffffff;
      --hfws-on-surface: #101828;
      --hfws-muted: #667085;
      --hfws-border: rgba(16, 24, 40, 0.12);
      --hfws-shadow: 0 12px 28px rgba(16, 24, 40, 0.18), 0 2px 6px rgba(16, 24, 40, 0.08);
      --hfws-danger: #d92d20;
      --hfws-success: #17a673;
      position: fixed;
      left: 20px;
      bottom: 20px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 10px;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
      font-size: 13px;
      line-height: 1.45;
      color: var(--hfws-on-surface);
    }

    @media (prefers-color-scheme: dark) {
      .dock {
        --hfws-accent: #6d8dff;
        --hfws-accent-strong: #8aa2ff;
        --hfws-surface: #1b1d23;
        --hfws-on-surface: #f5f6f8;
        --hfws-muted: #9aa3b2;
        --hfws-border: rgba(255, 255, 255, 0.14);
        --hfws-shadow: 0 12px 28px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.35);
        --hfws-danger: #ff7b72;
        --hfws-success: #3ddc97;
      }
    }

    .scan-button {
      position: relative;
      width: 56px;
      height: 56px;
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      padding: 0;
      border: 1px solid var(--hfws-border);
      border-radius: 50%;
      background: var(--hfws-surface);
      color: var(--hfws-accent);
      box-shadow: var(--hfws-shadow);
      cursor: pointer;
      pointer-events: auto;
      transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1),
                  box-shadow 180ms ease,
                  color 180ms ease,
                  background-color 180ms ease;
      -webkit-tap-highlight-color: transparent;
    }

    .scan-button:hover { transform: translateY(-2px) scale(1.03); }
    .scan-button:active { transform: translateY(0) scale(0.97); }
    .scan-button:focus-visible {
      outline: 2px solid var(--hfws-accent);
      outline-offset: 3px;
    }

    .dock[data-state="scanning"] .scan-button {
      cursor: progress;
      color: var(--hfws-accent-strong);
    }
    .dock[data-state="error"] .scan-button { color: var(--hfws-danger); }

    .ring {
      position: absolute;
      inset: -1px;
      width: 56px;
      height: 56px;
      transform: rotate(-90deg);
      overflow: visible;
      pointer-events: none;
    }
    .ring circle {
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
    }
    .ring .ring-track { stroke: transparent; }
    .ring .ring-value {
      stroke: var(--hfws-accent);
      stroke-dasharray: 163.36;
      stroke-dashoffset: 163.36;
      transition: stroke-dashoffset 200ms linear;
    }
    .dock[data-state="error"] .ring .ring-value { stroke: var(--hfws-danger); }

    .glyph {
      width: 30px;
      height: 30px;
      overflow: visible;
      pointer-events: none;
    }
    .glyph .glyph-ring { stroke: currentColor; fill: none; }
    .glyph .glyph-beam {
      fill: currentColor;
      opacity: 0.18;
      transform: rotate(-40deg);
      transform-box: view-box;
      transform-origin: 12px 12px;
      transition: opacity 200ms ease;
    }
    .glyph .glyph-scanline {
      stroke: currentColor;
      opacity: 0.45;
      transform: translateY(0);
      transition: opacity 200ms ease;
    }
    .glyph .glyph-core { fill: currentColor; }

    .dock[data-state="scanning"] .glyph .glyph-beam {
      opacity: 0.85;
      animation: hfws-sweep 1.35s linear infinite;
    }
    .dock[data-state="scanning"] .glyph .glyph-scanline {
      opacity: 0.9;
      animation: hfws-travel 1.6s ease-in-out infinite;
    }

    @keyframes hfws-sweep {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes hfws-travel {
      0%, 100% { transform: translateY(-8.2px); }
      50% { transform: translateY(8.2px); }
    }
    @media (prefers-reduced-motion: reduce) {
      .dock[data-state="scanning"] .glyph .glyph-beam { animation: none; }
      .dock[data-state="scanning"] .glyph .glyph-scanline { animation: none; }
    }

    .status {
      pointer-events: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 11px;
      border: 1px solid var(--hfws-border);
      border-radius: 999px;
      background: var(--hfws-surface);
      color: var(--hfws-muted);
      box-shadow: var(--hfws-shadow);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .status[hidden] { display: none; }

    .toast {
      pointer-events: none;
      max-width: 320px;
      padding: 9px 12px;
      border: 1px solid var(--hfws-border);
      border-left: 3px solid var(--hfws-accent);
      border-radius: 10px;
      background: var(--hfws-surface);
      color: var(--hfws-on-surface);
      box-shadow: var(--hfws-shadow);
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 220ms ease, transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
    }
    .toast[hidden] { display: none; }
    .toast.visible { opacity: 1; transform: translateY(0); }
    .toast[data-kind="success"] { border-left-color: var(--hfws-success); }
    .toast[data-kind="error"] { border-left-color: var(--hfws-danger); }
    .toast[data-kind="info"] { border-left-color: var(--hfws-muted); }
  `;

  // Static markup only. Every piece of text that reaches the DOM later is written with
  // textContent, never with innerHTML, so page and network data cannot inject markup.
  const dock = document.createElement('div');
  dock.className = 'dock';
  dock.dataset.state = 'idle';

  const styles = document.createElement('style');
  styles.textContent = shadowStyles;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'scan-button';
  button.setAttribute('aria-label', 'Scan this page for English word frequency');
  button.title = 'Scan this page for English word frequency';

  const progressRing = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  progressRing.setAttribute('class', 'ring');
  progressRing.setAttribute('viewBox', '0 0 56 56');
  progressRing.setAttribute('aria-hidden', 'true');
  const ringTrack = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ringTrack.setAttribute('class', 'ring-track');
  ringTrack.setAttribute('cx', '28');
  ringTrack.setAttribute('cy', '28');
  ringTrack.setAttribute('r', '26');
  const ringValue = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ringValue.setAttribute('class', 'ring-value');
  ringValue.setAttribute('cx', '28');
  ringValue.setAttribute('cy', '28');
  ringValue.setAttribute('r', '26');
  progressRing.append(ringTrack, ringValue);

  const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  glyph.setAttribute('class', 'glyph');
  glyph.setAttribute('viewBox', '0 0 24 24');
  glyph.setAttribute('aria-hidden', 'true');
  glyph.setAttribute('focusable', 'false');
  glyph.innerHTML =
    '<circle class="glyph-ring" cx="12" cy="12" r="9.2" stroke-width="1.4" opacity="0.5"/>' +
    '<circle class="glyph-ring" cx="12" cy="12" r="5.4" stroke-width="1.1" opacity="0.3"/>' +
    '<path class="glyph-beam" d="M12 12 L12 2.8 A9.2 9.2 0 0 1 21.2 12 Z"/>' +
    '<line class="glyph-scanline" x1="3.6" y1="12" x2="20.4" y2="12" stroke-width="1.4" stroke-linecap="round"/>' +
    '<circle class="glyph-core" cx="12" cy="12" r="1.25"/>';

  button.append(progressRing, glyph);

  const status = document.createElement('div');
  status.className = 'status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.hidden = true;

  dock.append(status, toast, button);
  shadow.append(styles, dock);

  // --- UI state helpers ----------------------------------------------------------

  const RING_CIRCUMFERENCE = 2 * Math.PI * 26;

  function setState(state) {
    dock.dataset.state = state;
    button.setAttribute('aria-busy', state === 'scanning' ? 'true' : 'false');
  }

  /** Updates the progress ring and the status pill. Pass null to hide the pill. */
  function setProgress(ratio, label) {
    if (ratio === null || ratio === undefined) {
      ringValue.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
      status.hidden = true;
      status.textContent = '';
      return;
    }
    const clamped = Math.min(1, Math.max(0, ratio));
    ringValue.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - clamped));
    status.hidden = false;
    const percent = `${Math.round(clamped * 100)}%`;
    status.textContent = label ? `${label} ${percent}` : percent;
  }

  let toastTimerId = 0;
  let toastHideTimerId = 0;

  /** Shows a transient message above the button. */
  function showToast(message, kind = 'info') {
    toast.textContent = message;
    toast.dataset.kind = kind;
    toast.hidden = false;
    window.clearTimeout(toastTimerId);
    window.clearTimeout(toastHideTimerId);
    // Force a style flush so the transition runs when the toast replaces an earlier one.
    void toast.offsetWidth;
    toast.classList.add('visible');
    toastTimerId = window.setTimeout(() => {
      toast.classList.remove('visible');
      toastHideTimerId = window.setTimeout(() => {
        toast.hidden = true;
      }, 240);
    }, kind === 'error' ? 5200 : 3400);
  }

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (scanInFlight) {
      showToast('A scan is already running.', 'info');
      return;
    }
    runScan({ openResults: true });
  });

  document.documentElement.append(host);

  // --- Extraction -------------------------------------------------------------------

  /** Thrown when a scan is cancelled because the page unloaded or a new scan started. */
  class ScanCancelled extends Error {
    constructor(reason) {
      super(reason);
      this.name = 'ScanCancelled';
    }
  }

  /** Decides whether a token is capitalized mid-sentence, not at a sentence start. */
  function isMidSentenceCapital(piece, index, carryIsSentenceEnd) {
    let cursor = index - 1;
    while (cursor >= 0 && /[\s"'\u2018\u2019\u201c\u201d([{<]/.test(piece[cursor])) cursor -= 1;
    if (cursor < 0) return !carryIsSentenceEnd;
    return !/[.!?\u2026]/.test(piece[cursor]);
  }

  /** True when the tail of the piece ends a sentence (used for the next piece). */
  function endsSentence(piece) {
    for (let index = piece.length - 1; index >= 0; index -= 1) {
      const character = piece[index];
      if (/\s/.test(character)) continue;
      return /[.!?\u2026]/.test(character);
    }
    return false;
  }

  /**
   * Normalizes one matched token: curly apostrophes to straight ones, possessive "'s"
   * removed unless the token is a known contraction of "is" or "has", then lowercased.
   *
   * The distinction matters: "page's" should be counted as "page", but "it's" must not
   * silently become "it". Without a lexicon the two cannot be told apart by rule, so a
   * short list of the contractions that actually occur in English does the job. The
   * same list exists in lib/stopwords.js for the analysis stage.
   */
  const S_CONTRACTION_KEEP = new Set([
    "it's", "that's", "there's", "here's", "he's", "she's", "what's", "let's", "who's",
    "where's", "when's", "why's", "how's", "one's", "everyone's", "everybody's",
    "someone's", "somebody's", "nobody's", "nothing's", "anything's", "something's"
  ]);

  function normalizeToken(raw) {
    let token = raw.replace(/[\u2018\u2019\u02bc]/g, "'");
    if ((token.endsWith("'s") || token.endsWith("'S")) && !S_CONTRACTION_KEEP.has(token.toLowerCase())) {
      token = token.slice(0, -2);
    }
    token = token.replace(/^['-]+/, '').replace(/['-]+$/, '').toLowerCase();
    return token;
  }

  function acceptNodeFor(settings) {
    const skipCode = settings.excludeCode !== false;
    const skipBoilerplate = !!settings.excludeBoilerplate;

    return function acceptNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.nodeValue;
        if (!value || !value.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_REJECT;

      if (shouldRejectElement(node, skipCode, skipBoilerplate)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    };
  }

  function shouldRejectElement(element, skipCode, skipBoilerplate) {
    const tag = element.tagName;
    if (SKIP_TAGS.has(tag)) return true;
    if (skipCode && CODE_TAGS.has(tag)) return true;
    if (element.hasAttribute('data-hfws-ignore')) return true;
    if (element.hidden) return true;
    if (element.getAttribute('aria-hidden') === 'true') return true;
    if (element.hasAttribute('inert')) return true;
    if (skipBoilerplate && isBoilerplate(element)) return true;
    return !isRendered(element);
  }

  /**
   * Visibility test.
   *
   * getComputedStyle is used rather than Element.checkVisibility() on purpose: this
   * walker rejects whole subtrees, so inherited hiding is already handled by the parent
   * check, and checkVisibility() would additionally report text inside
   * `content-visibility: auto` sections as invisible while they are scrolled out of
   * view. Those sections are part of the page and must be counted.
   */
  function isRendered(element) {
    const style = window.getComputedStyle(element);
    if (!style) return true;
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.opacity === '0') return false;
    if (style.contentVisibility === 'hidden') return false;
    return true;
  }

  /** Class and id based boilerplate detection, only used when the setting is enabled. */
  function isBoilerplate(element) {
    if (BOILERPLATE_TAGS.has(element.tagName)) return true;
    const role = element.getAttribute('role');
    if (role && BOILERPLATE_ROLES.has(role.toLowerCase())) return true;
    const className = typeof element.className === 'string' ? element.className : '';
    const identifier = element.id || '';
    if (!className && !identifier) return false;
    return BOILERPLATE_PATTERN.test(`${className} ${identifier}`);
  }

  /** Yields to the event loop between work slices. */
  function yieldToMain() {
    return new Promise((resolve) => {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => resolve(), { timeout: 50 });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  /**
   * Collects tokens from the visible text of the document.
   *
   * Chunked by time budget. Nothing is stored except the tokens themselves: the full
   * page text is never materialized, so a 200,000 character page costs roughly a few
   * hundred kilobytes instead of tens of megabytes.
   *
   * @param {Object} settings
   * @param {{cancelled: boolean}} control Cancellation flag shared with the page.
   * @param {(ratio: number) => void} [onProgress]
   * @param {{target: number, found: null|{node: Text, start: number, end: number}}} [capture]
   * @returns {Promise<Object>} Extraction result.
   */
  async function extract(settings, control, onProgress, capture) {
    const root = document.body;
    if (!root) throw new Error('This page has no body element to scan.');

    const tokens = [];
    const caps = [];
    const offsets = [];
    const truncateReasons = [];

    let nodeCount = 0;
    let textNodeCount = 0;
    let charCount = 0;
    let truncated = false;
    let carryIsSentenceEnd = true;
    let currentTextNode = null;
    let captureDone = false;

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      acceptNodeFor(settings)
    );

    // Local offsets of the token currently being consumed, used by the reveal helper.
    let captureLocalStart = 0;
    let captureLocalEnd = 0;

    const consumeToken = (token, offset, capitalized) => {
      if (capture && !captureDone && tokens.length === capture.target) {
        capture.found = currentTextNode
          ? { node: currentTextNode, start: captureLocalStart, end: captureLocalEnd }
          : null;
        captureDone = true;
      }
      tokens.push(token);
      caps.push(capitalized ? '1' : '0');
      offsets.push(offset);
    };

    const tokenizePiece = (piece, baseOffset) => {
      const excluded = [];
      for (const match of piece.matchAll(NON_WORD_PATTERN)) {
        excluded.push([match.index, match.index + match[0].length]);
      }

      let excludedIndex = 0;
      for (const match of piece.matchAll(WORD_PATTERN)) {
        const start = match.index;
        const end = start + match[0].length;

        while (excludedIndex < excluded.length && excluded[excludedIndex][1] <= start) {
          excludedIndex += 1;
        }
        if (excludedIndex < excluded.length && excluded[excludedIndex][0] < end) continue;

        const token = normalizeToken(match[0]);
        if (!token || !/[a-z]/.test(token)) continue;

        captureLocalStart = start;
        captureLocalEnd = end;
        consumeToken(token, baseOffset + start, isMidSentenceCapital(piece, start, carryIsSentenceEnd));
      }
    };

    let sliceStart = performance.now();
    let finished = false;

    while (!finished) {
      const node = walker.nextNode();

      if (!node) {
        finished = true;
        break;
      }

      nodeCount += 1;

      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.nodeValue;
        if (value && value.trim()) {
          let piece = value;
          const remainingChars = LIMITS.maxChars - charCount;
          if (remainingChars <= 0) {
            truncated = true;
            truncateReasons.push(`the ${LIMITS.maxChars.toLocaleString('en-US')} character limit was reached`);
            finished = true;
            break;
          }
          if (piece.length > remainingChars) {
            piece = piece.slice(0, remainingChars);
            truncated = true;
            truncateReasons.push(`the ${LIMITS.maxChars.toLocaleString('en-US')} character limit was reached`);
            finished = true;
          }

          currentTextNode = node;
          tokenizePiece(piece, charCount);
          charCount += piece.length + TEXT_SEPARATOR.length;
          textNodeCount += 1;
          carryIsSentenceEnd = endsSentence(piece);

          if (tokens.length >= LIMITS.maxTokens) {
            truncated = true;
            truncateReasons.push(`the ${LIMITS.maxTokens.toLocaleString('en-US')} token limit was reached`);
            finished = true;
          }
        }
      }

      if (nodeCount >= LIMITS.maxNodes) {
        truncated = true;
        truncateReasons.push(`the ${LIMITS.maxNodes.toLocaleString('en-US')} node limit was reached`);
        finished = true;
      }

      if (captureDone) {
        finished = true;
      }

      // Yield in time slices so page interaction stays responsive.
      if (!finished && performance.now() - sliceStart > SLICE_BUDGET_MS) {
        if (control.cancelled) throw new ScanCancelled('cancelled');
        if (onProgress) onProgress(Math.min(1, charCount / LIMITS.maxChars));
        await yieldToMain();
        sliceStart = performance.now();
      }
    }

    if (control.cancelled) throw new ScanCancelled('cancelled');

    return {
      tokens,
      caps: caps.join(''),
      offsets,
      truncated,
      truncateReasons: Array.from(new Set(truncateReasons)),
      charCount,
      nodeCount,
      textNodeCount
    };
  }

  // --- Scan orchestration --------------------------------------------------------

  let scanInFlight = false;

  /** Builds the payload stored in chrome.storage.local and shown on the results page. */
  function buildPayload(extraction, settings) {
    let domain = 'unknown-site';
    try {
      domain = window.location.hostname.replace(/^www\./, '') || 'unknown-site';
    } catch {
      domain = 'unknown-site';
    }

    return {
      id: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: document.title || domain,
      url: window.location.href,
      domain,
      scannedAt: Date.now(),
      truncated: extraction.truncated,
      truncateReasons: extraction.truncateReasons,
      extraction: {
        excludeCode: settings.excludeCode !== false,
        excludeBoilerplate: !!settings.excludeBoilerplate
      },
      stats: {
        charCount: extraction.charCount,
        nodeCount: extraction.nodeCount,
        textNodeCount: extraction.textNodeCount,
        tokenCount: extraction.tokens.length
      },
      tokens: extraction.tokens,
      caps: extraction.caps,
      offsets: extraction.offsets
    };
  }

  let activeControl = null;

  /**
   * Runs one scan. Single flight: a click while a scan is running is ignored by the
   * click handler.
   *
   * @param {Object} options
   * @param {boolean} [options.openResults] Ask the service worker to open the results tab.
   * @param {boolean} [options.returnPayload] Resolve with the payload instead of storing it.
   * @param {number} [options.reuseScanId] Keep an existing scan id (used by a rescan).
   */
  async function runScan(options = {}) {
    if (scanInFlight) return null;
    scanInFlight = true;

    const control = { cancelled: false };
    activeControl = control;
    setState('scanning');
    setProgress(0, 'Scanning');

    try {
      const settings = await loadSettings();
      const extraction = await extract(settings, control, (ratio) => setProgress(ratio, 'Scanning'));

      if (extraction.tokens.length === 0) {
        setState('idle');
        setProgress(null);
        showToast('No English words found on this page.', 'error');
        return null;
      }

      const payload = buildPayload(extraction, settings);
      if (options.reuseScanId) payload.id = options.reuseScanId;

      setProgress(1, 'Scanning');

      if (options.returnPayload) {
        setState('idle');
        setProgress(null);
        showToast(
          `Scan complete: ${payload.tokens.length.toLocaleString('en-US')} words counted.`,
          'success'
        );
        return payload;
      }

      await chrome.storage.local.set({ [STORAGE_SCAN_KEY]: payload });

      if (options.openResults) {
        // The service worker records the tab id and opens the results page. It also
        // keeps the payload in storage as the single source of truth for the page.
        await safeSendMessage({ type: MSG_OPEN_RESULTS, scanId: payload.id });
      }

      setState('idle');
      setProgress(null);
      showToast(
        `Scan complete: ${payload.tokens.length.toLocaleString('en-US')} words counted, opening results.`,
        'success'
      );
      return payload;
    } catch (error) {
      const cancelled = error instanceof ScanCancelled;
      if (!cancelled) {
        setState('error');
        window.setTimeout(() => setState('idle'), 1600);
        showToast(`Scan failed: ${describeError(error)}`, 'error');
        safeSendMessage({ type: MSG_SCAN_FAILED, message: describeError(error) });
      }
      setProgress(null);
      return null;
    } finally {
      scanInFlight = false;
      activeControl = null;
    }
  }

  /** Sends a message to the extension, tolerating an invalidated extension context. */
  async function safeSendMessage(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (String(error && error.message).includes('Extension context invalidated')) {
        // The extension was reloaded while this tab stayed open. Nothing to report to:
        // the results page in the new context will simply not appear.
        return null;
      }
      throw error;
    }
  }

  function describeError(error) {
    const message = (error && error.message) || String(error);
    if (message.includes('QUOTA_BYTES') || message.includes('quota')) {
      return 'browser storage quota reached. Clear old scans in the extension options.';
    }
    return message;
  }

  // --- Reveal a word on the page --------------------------------------------------

  /**
   * Re-walks the page until the n-th token of the same scan is reached, then selects it
   * and scrolls it into view. Re-walking instead of keeping node references costs a few
   * milliseconds and survives a page refresh, which node references would not.
   */
  async function revealToken(tokenIndex) {
    const settings = await loadSettings();
    const capture = { target: tokenIndex, found: null };

    const extraction = await extract(settings, { cancelled: false }, null, capture);

    if (!capture.found || !capture.found.node.isConnected) {
      showToast('That word is no longer on the page.', 'error');
      return false;
    }

    const range = document.createRange();
    range.setStart(capture.found.node, capture.found.start);
    range.setEnd(capture.found.node, capture.found.end);

    const container = capture.found.node.parentElement;
    if (container && typeof container.scrollIntoView === 'function') {
      container.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }

    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }

    showToast(`Located "${extraction.tokens[tokenIndex] || 'the word'}" on this page.`, 'success');
    return true;
  }

  // --- Messages from the extension ------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;

    if (message.type === MSG_HIGHLIGHT) {
      revealToken(Number(message.tokenIndex) || 0)
        .then((ok) => sendResponse({ ok }))
        .catch((error) => sendResponse({ ok: false, error: describeError(error) }));
      return true; // async response
    }

    if (message.type === MSG_RESCAN) {
      (async () => {
        const settings = await saveSettings(message.settings || {});
        const payload = await runScan({ returnPayload: true, reuseScanId: message.scanId });
        if (!payload) {
          sendResponse({ ok: false, error: 'The rescan found no words or was cancelled.' });
          return;
        }
        await chrome.storage.local.set({ [STORAGE_SCAN_KEY]: payload });
        sendResponse({ ok: true, scanId: payload.id });
      })().catch((error) => sendResponse({ ok: false, error: describeError(error) }));
      return true; // async response
    }

    return undefined;
  });

  // --- Teardown ---------------------------------------------------------------------

  // Navigating away or closing the tab cancels the running scan, so the walker stops at
  // the next slice boundary instead of throwing into a dead document.
  window.addEventListener('pagehide', () => {
    if (activeControl) activeControl.cancelled = true;
  });
  window.addEventListener('beforeunload', () => {
    if (activeControl) activeControl.cancelled = true;
  });
})();
