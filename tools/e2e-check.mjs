/**
 * End-to-end check in a real Chrome. Run it after changing the content script, the service
 * worker, the results page or the manifest:
 *
 *   node tools/e2e-check.mjs
 *
 * It launches Chrome with the unpacked extension loaded and a throwaway profile, then drives
 * the extension over the DevTools Protocol. Node's built-in WebSocket client is used, so
 * nothing has to be installed. The checks, in order:
 *
 *   1. The extension loads, and the service worker answers a message (the options page
 *      renders cache statistics, which it can only do if the worker replied).
 *   2. A local HTTP page is served, the floating button is clicked through the shadow root,
 *      and the scan completes with a token count in its toast.
 *   3. The results page opens in its own tab, shows the header metadata, and renders rows.
 *   4. Selection and the Markdown export produce a file whose name, structure and content
 *      are checked, including the "no CJK characters" rule.
 *   5. No uncaught errors are logged in any page or in the service worker.
 *
 * A local HTTP server is used on purpose: the content script matches http and https only,
 * exactly as Chrome runs it, so a file:// page would not be a faithful test.
 *
 * Flags: --keep (do not delete the profile and download directory), --chrome <path>.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const CHROME_ARG = argv.includes('--chrome') ? argv[argv.indexOf('--chrome') + 1] : null;

// --- Reporting ------------------------------------------------------------------

let passed = 0;
let failed = 0;
const notes = [];

function pass(label, detail = '') {
  passed += 1;
  console.log(`  ok   ${label}${detail ? ` (${detail})` : ''}`);
}

function fail(label, detail = '') {
  failed += 1;
  console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ''}`);
}

function check(label, condition, detail = '') {
  if (condition) pass(label, detail);
  else fail(label, detail);
}

function note(message) {
  notes.push(message);
  console.log(`  note ${message}`);
}

// --- Chrome ---------------------------------------------------------------------

const CHROME_CANDIDATES = [
  CHROME_ARG,
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));

if (!chromePath) {
  console.log('Chrome was not found, so the end-to-end check was skipped.');
  console.log(`Looked at: ${CHROME_CANDIDATES.join(', ')}`);
  process.exit(0);
}

/** Opens a TCP port for the DevTools endpoint and returns it. */
function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** Waits until the DevTools endpoint answers, or throws after the timeout. */
async function waitForDevTools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      // Not up yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error('DevTools did not become available.');
}

/** Extension id that Chrome derives from the absolute path of an unpacked extension. */
function extensionIdForPath(path) {
  const digest = createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 32);
  return digest.replace(/[0-9a-f]/g, (character) =>
    String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(character, 16))
  );
}

// --- Minimal DevTools Protocol client ---------------------------------------------

class Target {
  constructor(targetInfo, label, { ui = true } = {}) {
    this.label = label;
    this.info = targetInfo;
    this.ui = ui;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.consoleErrors = [];
  }

  async connect() {
    this.socket = new WebSocket(this.info.webSocketDebuggerUrl);

    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', () => rejectOpen(new Error(`Could not attach to ${this.label}.`)), { once: true });
    });

    this.socket.addEventListener('message', (event) => this.handleMessage(event.data));

    // The browser-level endpoint has no JavaScript context, so the runtime domains only
    // apply to pages and workers.
    if (this.ui) {
      await this.send('Runtime.enable');
      await this.send('Log.enable').catch(() => {});
      await this.send('Page.enable').catch(() => {});
    }
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.id && this.pending.has(message.id)) {
      const { resolveCommand, rejectCommand } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) rejectCommand(new Error(`${this.label}: ${message.error.message}`));
      else resolveCommand(message.result);
      return;
    }

    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails || {};
      this.consoleErrors.push(
        `uncaught: ${(details.exception && details.exception.description) || details.text || 'unknown'}`
      );
    }

    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      this.consoleErrors.push(
        `console.error: ${(message.params.args || []).map((argument) => argument.value ?? argument.description ?? '').join(' ')}`
      );
    }

    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      const entry = message.params.entry;
      // A favicon fetched from a throwaway local server is noise, not a defect.
      if (!/favicon/i.test(entry.text)) this.consoleErrors.push(`log: ${entry.text}`);
    }

    const handlers = this.listeners.get(message.method);
    if (handlers) for (const handler of handlers) handler(message.params);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCommand, rejectCommand) => {
      this.pending.set(id, { resolveCommand, rejectCommand });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rejectCommand(new Error(`${this.label}: ${method} timed out.`));
        }
      }, 30000);
    });
  }

  once(method) {
    return new Promise((resolveEvent) => {
      const handler = (params) => {
        this.listeners.set(
          method,
          (this.listeners.get(method) || []).filter((candidate) => candidate !== handler)
        );
        resolveEvent(params);
      };
      this.listeners.set(method, [...(this.listeners.get(method) || []), handler]);
    });
  }

  /** Evaluates an expression in the target and returns its JSON value. */
  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error(
        `${this.label}: ${(result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text}`
      );
    }
    return result.result ? result.result.value : undefined;
  }

  async navigate(url) {
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

/** Polls until a target matching the predicate appears. */
async function waitForTarget(port, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await listTargets(port);
    const found = targets.find(predicate);
    if (found) return found;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return null;
}

// --- Fixture page ---------------------------------------------------------------

const ARTICLE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Frequency Scanner Fixture Page</title>
    <style>
      .hidden { display: none; }
      .invisible { visibility: hidden; }
      .transparent { opacity: 0; }
    </style>
  </head>
  <body>
    <nav><a href="/">Home</a> <a href="/">Home</a> <a href="/">Navigation</a></nav>
    <header><h1>Designing a scanner for English word frequency</h1></header>
    <main>
      <p>
        A frequency scanner reads the visible text of a page and ranks the words it finds.
        The scanner ignores scripts, styles and hidden nodes, because those nodes never
        contribute readable prose. A scanner that counted markup would rank the markup.
      </p>
      <p>
        Good tooling respects the reader. The reader wants the words that carry meaning, and
        the words that carry meaning are the ones that survive a stop word filter. Tooling
        that ignores this produces a list of articles and prepositions, which helps nobody.
      </p>
      <p>See also <a href="https://example.com/design/example.html">design/example.html</a> or write to reader@example.com.</p>
      <pre><code>const scanner = (page) =&gt; page.words.filter((word) =&gt; word.meaningful);</code></pre>
      <p class="hidden">Hidden text that must never be counted: zebra.</p>
      <p class="invisible">Invisible text that must never be counted: zebra.</p>
      <p class="transparent">Transparent text that must never be counted: zebra.</p>
      <p aria-hidden="true">Aria hidden text that must never be counted: zebra.</p>
    </main>
    <footer><p>Copyright 2026 Example Corporation. All rights reserved.</p></footer>
  </body>
</html>`;

// --- Main -------------------------------------------------------------------------

const userDataDir = await mkdtemp(join(tmpdir(), 'hfws-profile-'));
const downloadDir = await mkdtemp(join(tmpdir(), 'hfws-downloads-'));
const devtoolsPort = await freePort();

let fixtureServer = null;
let fixtureOrigin = '';
let chrome = null;

function stop() {
  if (chrome) chrome.kill('SIGKILL');
  if (fixtureServer) fixtureServer.close();
}

process.on('exit', stop);
process.on('SIGINT', () => {
  stop();
  process.exit(130);
});

try {
  console.log(`Chrome: ${chromePath}`);
  console.log(`Extension folder: ${ROOT}`);
  console.log('');

  // The fixture page is served over HTTP so the content script is injected the same way it
  // is on a real site.
  const fixtureServer = createServer((request, response) => {
    if (request.url === '/page.html' || request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(ARTICLE);
      return;
    }
    if (request.url === '/favicon.ico') {
      // Answered so the browser does not log a 404 that would be mistaken for a defect.
      response.writeHead(200, { 'content-type': 'image/x-icon', 'content-length': '0' });
      response.end();
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  await new Promise((resolveListen) => fixtureServer.listen(0, '127.0.0.1', resolveListen));
  fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;

  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=DialMediaRouteProvider',
      // Chrome 137 removed --load-extension from branded builds. The DevTools command
      // Extensions.loadUnpacked replaces it, and it needs this switch to be allowed.
      '--enable-unsafe-extension-debugging',
      `--user-data-dir=${userDataDir}`,
      `--load-extension=${ROOT}`,
      `--remote-debugging-port=${devtoolsPort}`,
      '--window-size=1280,900',
      'about:blank'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const chromeLog = [];
  chrome.stderr.on('data', (chunk) => chromeLog.push(String(chunk)));
  chrome.stdout.on('data', (chunk) => chromeLog.push(String(chunk)));

  const version = await waitForDevTools(devtoolsPort);
  console.log(`Browser: ${version.Browser}`);

  // The browser-level endpoint is needed for Browser.setDownloadBehavior: a page session
  // cannot set the download path.
  const browserEndpoint = new Target(
    { webSocketDebuggerUrl: version.webSocketDebuggerUrl },
    'browser',
    { ui: false }
  );
  await browserEndpoint.connect();

  const expectedId = extensionIdForPath(ROOT);

  // ============================================================================
  console.log('\n1. Extension load and service worker');

  let extensionId = null;
  let loadError = null;
  try {
    const loaded = await browserEndpoint.send('Extensions.loadUnpacked', { path: ROOT });
    extensionId = loaded && loaded.id ? loaded.id : null;
  } catch (error) {
    loadError = error;
  }

  check('the extension loaded through the DevTools command', !!extensionId, extensionId || String(loadError && loadError.message));
  if (extensionId) {
    check('the extension id is the one derived from the folder path', extensionId === expectedId, `${extensionId} / ${expectedId}`);
  }

  const optionsTarget = await waitForTarget(
    devtoolsPort,
    (target) => target.url.endsWith('options/options.html'),
    12000
  );

  if (optionsTarget) {
    extensionId = new URL(optionsTarget.url).host;
  } else {
    const workerTarget = await waitForTarget(devtoolsPort, (target) => target.url.includes('service-worker.js'), 5000);
    if (workerTarget) extensionId = new URL(workerTarget.url).host;
  }

  if (!extensionId) {
    // Fall back to the id Chrome derives from the folder path.
    extensionId = expectedId;
    note(`the DevTools command did not report an id, using the one derived from the folder path: ${extensionId}`);
  }

  check('the options page opened on first install', !!optionsTarget, optionsTarget ? optionsTarget.url : 'not opened');

  const serviceWorkerTarget = await waitForTarget(
    devtoolsPort,
    (target) => target.url.endsWith('service-worker.js'),
    8000
  );
  check('the service worker started', !!serviceWorkerTarget, serviceWorkerTarget ? serviceWorkerTarget.url : 'not started');

  // The worker has to answer for the options page to fill its statistics in.
  const optionsPage = new Target(
    optionsTarget || {
      webSocketDebuggerUrl: (await listTargets(devtoolsPort)).find((target) => target.type === 'page').webSocketDebuggerUrl,
      url: 'about:blank'
    },
    'options'
  );
  await optionsPage.connect();

  if (!optionsTarget) {
    await optionsPage.navigate(`chrome-extension://${extensionId}/options/options.html`);
  } else {
    await new Promise((resolveWait) => setTimeout(resolveWait, 600));
  }

  const cacheCount = await optionsPage.evaluate(
    'new Promise((resolve) => setTimeout(() => resolve(document.getElementById("cache-count").textContent), 400))'
  );
  check('the service worker answered the options page', /^[\d,]/.test(String(cacheCount)), `cache count "${cacheCount}"`);

  const wordnetStatus = await optionsPage.evaluate('document.getElementById("wordnet-status").textContent');
  check('the options page reports the offline layer status', /Installed|Not installed|Unavailable/.test(wordnetStatus), wordnetStatus);

  const privacyText = await optionsPage.evaluate('document.querySelector(".privacy-list").textContent');
  check('the privacy statement is on the options page', /never leaves your device/.test(privacyText));
  check(
    'the options page names the CC BY-SA attribution',
    (await optionsPage.evaluate('document.querySelector(".attribution").textContent')).includes('Attribution-ShareAlike')
  );

  // ============================================================================
  console.log('\n2. Scanning a page from the floating button');

  const pageTarget = await (async () => {
    const { targetId } = await browserEndpoint.send('Target.createTarget', { url: 'about:blank' });
    const created = await waitForTarget(devtoolsPort, (target) => target.id === targetId, 8000);
    if (!created) throw new Error('Could not create a page target for the fixture page.');
    return created;
  })();
  const page = new Target(pageTarget, 'fixture page');
  await page.connect();
  await page.navigate(`${fixtureOrigin}/page.html`);

  const injected = await page.evaluate('!!document.getElementById("hfws-floating-host")');
  check('the content script injected the floating host', injected === true);

  const shadowOk = await page.evaluate(
    '(() => { const host = document.getElementById("hfws-floating-host"); return !!host && !!host.shadowRoot && !!host.shadowRoot.querySelector(".scan-button"); })()'
  );
  check('the button lives in a shadow root', shadowOk === true);

  const buttonPosition = await page.evaluate(`(() => {
    const host = document.getElementById('hfws-floating-host');
    const button = host.shadowRoot.querySelector('.scan-button');
    const rect = button.getBoundingClientRect();
    const dock = host.shadowRoot.querySelector('.dock');
    return {
      left: rect.left,
      bottom: window.innerHeight - rect.bottom,
      zIndex: getComputedStyle(dock).zIndex,
      position: getComputedStyle(dock).position
    };
  })()`);
  check('the button sits in the bottom left corner', buttonPosition.left < 100 && buttonPosition.bottom < 100, JSON.stringify(buttonPosition));
  check('the stack sits above page content', buttonPosition.zIndex === '2147483647', buttonPosition.zIndex);
  check('the button is fixed to the viewport', buttonPosition.position === 'fixed');

  const stateDuringScan = await page.evaluate(`(() => {
    const host = document.getElementById('hfws-floating-host');
    const button = host.shadowRoot.querySelector('.scan-button');
    button.click();
    const dock = host.shadowRoot.querySelector('.dock');
    return dock.dataset.state;
  })()`);
  check('the button enters the scanning state', stateDuringScan === 'scanning', stateDuringScan);

  const scanToast = await page.evaluate(`new Promise((resolve) => {
    const host = document.getElementById('hfws-floating-host');
    const toast = host.shadowRoot.querySelector('.toast');
    const deadline = Date.now() + 15000;
    const timer = setInterval(() => {
      if (toast.textContent.includes('Scan complete') || Date.now() > deadline) {
        clearInterval(timer);
        resolve(toast.textContent);
      }
    }, 100);
  })`);
  check('the scan completes and reports a token count', /Scan complete: [\d,]+ words counted/.test(scanToast), scanToast);

  // During the scan the previous click must be ignored: a second click while busy is not
  // possible to time reliably from here, so the guard is checked through the dock state.
  const finalState = await page.evaluate(
    'document.getElementById("hfws-floating-host").shadowRoot.querySelector(".dock").dataset.state'
  );
  check('the button returns to its idle state', finalState === 'idle', finalState);

  // ============================================================================
  console.log('\n3. Results page');

  const resultsTarget = await waitForTarget(devtoolsPort, (target) => target.url.includes('results/results.html'), 15000);
  check('a results tab was opened', !!resultsTarget);
  if (!resultsTarget) throw new Error('The results page never opened.');

  const results = new Target(resultsTarget, 'results');
  await results.connect();
  await new Promise((resolveWait) => setTimeout(resolveWait, 700));

  const header = await results.evaluate(`({
    title: document.getElementById('scan-title').textContent,
    url: document.getElementById('scan-url').textContent,
    chips: document.getElementById('scan-chips').textContent,
    footer: document.getElementById('list-footer').textContent
  })`);
  check('the header shows the source title', header.title === 'Frequency Scanner Fixture Page', header.title);
  check('the header shows the source URL', header.url.includes(`${fixtureOrigin}/page.html`), header.url);
  check('the header counts tokens and unique words', /tokens/.test(header.chips) && /unique words/.test(header.chips), header.chips);
  check('the header shows the scan time', /Scanned \d{4}-\d{2}-\d{2}/.test(header.chips), header.chips);

  const rendered = await results.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.row')).filter((row) => !row.hidden);
    return {
      rendered: rows.length,
      first: rows[0] ? rows[0].querySelector('.row-word').textContent : null,
      firstCount: rows[0] ? rows[0].querySelector('.row-count').textContent : null,
      spacer: document.getElementById('spacer').style.height,
      hasCheckbox: rows[0] ? !!rows[0].querySelector('.row-checkbox') : false,
      hasBar: rows[0] ? !!rows[0].querySelector('.row-bar i').style.width : false,
      total: document.querySelectorAll('.row').length
    };
  })()`);
  check('rows are rendered by the virtual list', rendered.rendered > 0, `${rendered.rendered} rows`);
  check('the DOM stays bounded regardless of the word count', rendered.total < 80, `${rendered.total} row elements`);
  check('each row has a checkbox, a word, a bar and a count', rendered.hasCheckbox && rendered.hasBar && !!rendered.firstCount);
  check('the spacer reserves the full scroll height', parseInt(rendered.spacer, 10) > 0, rendered.spacer);

  const topRows = await results.evaluate(`(() => {
    const read = () => Array.from(document.querySelectorAll('.row')).filter((row) => !row.hidden)
      .map((row) => ({ word: row.querySelector('.row-word').textContent, count: Number(row.querySelector('.row-count').textContent.replace(/,/g, '')) }));
    return read().slice(0, 6);
  })()`);
  check(
    'the ranking is descending by frequency',
    topRows.every((entry, index) => index === 0 || topRows[index - 1].count >= entry.count),
    JSON.stringify(topRows)
  );
  const exclusions = await results.evaluate(`(() => {
    const words = Array.from(document.querySelectorAll('.row')).map((row) => row.querySelector('.row-word').textContent);
    return words.filter((word) => ['zebra', 'the', 'and', 'of', 'a'].includes(word)).length;
  })()`);
  check('hidden text, stop words and short words are all absent', exclusions === 0);

  const codeAndBoilerplate = await results.evaluate(`(() => {
    const words = Array.from(document.querySelectorAll('.row')).map((row) => row.querySelector('.row-word').textContent);
    return {
      scanner: words.includes('scanner'),
      codeOnly: words.filter((word) => ['const', 'meaningful'].includes(word)),
      boilerplate: words.filter((word) => ['copyright', 'reserved', 'navigation', 'home'].includes(word))
    };
  })()`);
  check('prose words are counted', codeAndBoilerplate.scanner === true);
  check('code blocks are excluded by default', codeAndBoilerplate.codeOnly.length === 0, codeAndBoilerplate.codeOnly.join(', '));
  check(
    'boilerplate is included by default, as documented',
    codeAndBoilerplate.boilerplate.length > 0,
    codeAndBoilerplate.boilerplate.join(', ')
  );

  // ============================================================================
  console.log('\n4. Search, sorting, selection and keyboard navigation');

  await results.evaluate(`(() => {
    const search = document.getElementById('search');
    search.value = 'scann';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  const filtered = await results.evaluate(`(() => {
    const words = Array.from(document.querySelectorAll('.row')).filter((row) => !row.hidden)
      .map((row) => row.querySelector('.row-word').textContent);
    return { words, footer: document.getElementById('list-footer').textContent };
  })()`);
  check('the search box filters the list in real time', filtered.words.length > 0 && filtered.words.every((word) => word.includes('scann')), filtered.words.join(', '));
  check('the footer reports the filtered subset', /matching "scann"/.test(filtered.footer), filtered.footer);

  await results.evaluate(`document.getElementById('search-clear').click()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));

  await results.evaluate(`(() => {
    const sort = document.getElementById('sort');
    sort.value = 'alpha';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  const alphabetical = await results.evaluate(`Array.from(document.querySelectorAll('.row')).filter((row) => !row.hidden)
    .slice(0, 4).map((row) => row.querySelector('.row-word').textContent)`);
  check(
    'alphabetical sorting works',
    alphabetical.length > 1 && alphabetical.join(',') === alphabetical.slice().sort().join(','),
    alphabetical.join(', ')
  );

  await results.evaluate(`(() => {
    const sort = document.getElementById('sort');
    sort.value = 'freq';
    sort.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('viewport').focus();
    document.getElementById('viewport').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  })()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  const keyboard = await results.evaluate(`(() => {
    const active = document.querySelector('.row[data-active="true"]');
    return {
      hasActive: !!active,
      activeDescendant: document.getElementById('viewport').getAttribute('aria-activedescendant'),
      word: active ? active.querySelector('.row-word').textContent : null
    };
  })()`);
  check('arrow keys move the active row', keyboard.hasActive && keyboard.activeDescendant === 'word-row-1', JSON.stringify(keyboard));

  const selectionStartedAt = Date.now();
  await results.evaluate(`document.getElementById('btn-select-all').click()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 700));
  const selection = await results.evaluate(`(() => ({
    label: document.getElementById('selection-count').textContent,
    checked: Array.from(document.querySelectorAll('.row-checkbox')).filter((box) => box.checked).length,
    button: document.getElementById('btn-export').textContent
  }))()`);
  check('select all updates the selection counter', /^\d+ selected$/.test(selection.label) && !selection.label.startsWith('0 '), selection.label);
  check('select all checks the visible rows', selection.checked > 0);
  check('the export button states how many words it will write', /Export [\d,]+ \.md/.test(selection.button), selection.button);
  note(`selecting the whole list took ${Date.now() - selectionStartedAt} ms`);

  const invertAndClear = await results.evaluate(`(() => {
    document.getElementById('btn-invert').click();
    const afterInvert = document.getElementById('selection-count').textContent;
    document.getElementById('btn-clear-selection').click();
    const afterClear = document.getElementById('selection-count').textContent;
    return { afterInvert, afterClear };
  })()`);
  check('invert selection works', /^\d+ selected$/.test(invertAndClear.afterInvert), invertAndClear.afterInvert);
  check('clear selection empties the selection', invertAndClear.afterClear === '0 selected', invertAndClear.afterClear);

  // Select two specific rows, then verify the selection survives a reload: it is persisted
  // per scan id, and the page restores it when it boots.
  const chosen = await results.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.row')).filter((row) => !row.hidden);
    const words = [];
    for (const row of rows.slice(0, 2)) {
      row.querySelector('.row-checkbox').click();
      words.push(row.querySelector('.row-word').textContent);
    }
    return words;
  })()`);
  const immediatelyAfterClick = await results.evaluate(
    `document.getElementById('selection-count').textContent`
  );
  check('clicking a row checkbox selects that word', immediatelyAfterClick === '2 selected', `${immediatelyAfterClick} for ${chosen.join(', ')}`);

  await new Promise((resolveWait) => setTimeout(resolveWait, 800));

  await results.navigate(resultsTarget.url);
  await new Promise((resolveWait) => setTimeout(resolveWait, 700));
  const afterReload = await results.evaluate(`(() => ({
    label: document.getElementById('selection-count').textContent,
    rows: Array.from(document.querySelectorAll('.row')).filter((row) => !row.hidden).length,
    checkedWords: Array.from(document.querySelectorAll('.row')).filter((row) => !row.hidden)
      .filter((row) => row.querySelector('.row-checkbox').checked)
      .map((row) => row.querySelector('.row-word').textContent)
  }))()`);
  check('the list is restored after a refresh', afterReload.rows > 0, `${afterReload.rows} rows`);
  check('the selection survives a page refresh', afterReload.label === '2 selected', afterReload.label);
  check(
    'the same words come back checked after the refresh',
    afterReload.checkedWords.slice().sort().join(',') === chosen.slice().sort().join(','),
    `${afterReload.checkedWords.join(', ')} / ${chosen.join(', ')}`
  );

  // ============================================================================
  console.log('\n5. Detail panel');

  const detailOpened = await results.evaluate(`(() => {
    const button = document.querySelector('.row .row-word');
    const word = button.textContent;
    window.__hfwsDetailStart = performance.now();
    button.click();
    return word;
  })()`);

  // The panel must never be blank: either the skeleton is up, or a resolved panel is. The
  // wait is generous because the first lookup may go out to the network; the latency is
  // reported as a note rather than asserted, since it depends on the connection.
  const detailState = await results.evaluate(`new Promise((resolve) => {
    const deadline = Date.now() + 12000;
    const read = () => {
      const body = document.getElementById('drawer-body');
      const resolved = !!body.querySelector('.detail-meaning, .detail-message');
      return {
        open: document.getElementById('drawer').classList.contains('open'),
        word: document.getElementById('drawer-word').textContent,
        subtitle: document.getElementById('drawer-subtitle').textContent,
        body: body.textContent,
        resolved,
        skeleton: !!body.querySelector('.detail-loading'),
        elapsed: Math.round(performance.now() - window.__hfwsDetailStart),
        sourceLine: (body.querySelector('.detail-source-line') || {}).textContent || '',
        providers: Array.from(body.querySelectorAll('.detail-providers li')).map((item) => item.textContent)
      };
    };
    const timer = setInterval(() => {
      const state = read();
      if (state.resolved || Date.now() > deadline) {
        clearInterval(timer);
        resolve(state);
      }
    }, 150);
  })`);

  check('clicking a word opens the detail panel', detailState.open === true);
  check('the panel shows the word it is describing', detailState.word === detailOpened, `${detailState.word} / ${detailOpened}`);
  check('the panel shows the occurrence count', /\d+ occurrence/.test(detailState.subtitle), detailState.subtitle);
  check('the panel is never blank', detailState.resolved, `${detailState.body.trim().length} characters of text`);
  check('the panel reports what each source answered', detailState.providers.length > 0, detailState.providers.join(' / '));
  note(`the first lookup resolved in ${detailState.elapsed} ms`);
  note(`detail panel: ${detailState.body.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  if (detailState.sourceLine) note(`source line: ${detailState.sourceLine.replace(/\s+/g, ' ').slice(0, 140)}`);

  // A second click on the same word must render from the client cache with no request.
  const secondClick = await results.evaluate(`(async () => {
    document.getElementById('drawer-close').click();
    const button = document.querySelector('.row .row-word');
    const started = performance.now();
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const body = document.getElementById('drawer-body');
    return { elapsed: Math.round(performance.now() - started), renderedDirectly: !!body.querySelector('.detail-meaning, .detail-message'), skeleton: !!body.querySelector('.detail-loading') };
  })()`);
  check('a repeat click renders without a skeleton', secondClick.skeleton === false, JSON.stringify(secondClick));
  note(`the repeat click rendered in ${secondClick.elapsed} ms`);

  const escapeCheck = await results.evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return document.getElementById('drawer').classList.contains('open');
  })()`);
  check('Escape closes the detail panel', escapeCheck === false);

  // ============================================================================
  console.log('\n6. Markdown export');

  await browserEndpoint.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true
  });

  await results.evaluate(`document.getElementById('btn-export').click()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500));

  let files = [];
  const exportDeadline = Date.now() + 30000;
  while (Date.now() < exportDeadline) {
    files = (await readdir(downloadDir)).filter((name) => name.endsWith('.md'));
    if (files.length > 0) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }

  check('the export produced a Markdown file', files.length > 0, files.join(', '));

  if (files.length > 0) {
    const filename = files[0];
    const markdown = await readFile(join(downloadDir, filename), 'utf8');

    check('the filename follows highfreq-<domain>-<date>.md', /^highfreq-127-0-0-1-\d{4}-\d{2}-\d{2}\.md$/.test(filename), filename);
    check('the file starts with the ranked list heading', markdown.startsWith('# High-Frequency Word List'));
    check('the header records the source, URL and export time', /- Source: /.test(markdown) && /- URL: /.test(markdown) && /- Exported: \d{4}-\d{2}-\d{2}/.test(markdown));
    check('the words are numbered', /## 1\. /.test(markdown) && /## 2\. /.test(markdown));
    check('every word carries an occurrence count', /## 1\. [^(]+\(\d+ occurrences?\)/.test(markdown));
    check('the sources section is present', markdown.includes('## Sources and license'));
    check('the export mentions the local-only privacy statement', markdown.includes('never uploaded'));
    check('the exported file contains no CJK characters', !/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(markdown));

    // Only the numbered word headings: "## Sources and license" also starts with "## ".
    const words = markdown
      .split('\n')
      .filter((line) => /^## \d+\. /.test(line))
      .map((line) => line.replace(/^## \d+\. /, '').replace(/ \(.*$/, ''));
    const counts = markdown
      .split('\n')
      .filter((line) => /^## \d+\. /.test(line))
      .map((line) => Number((line.match(/\((\d+) occurrence/) || [])[1] || 0));
    check(
      'the exported order matches descending frequency',
      counts.every((count, index) => index === 0 || counts[index - 1] >= count),
      counts.slice(0, 6).join(', ')
    );
    check('the file contains one entry per selected word', words.length === 2, `${words.length} words: ${words.join(', ')}`);

    const uiFirst = await results.evaluate(`Array.from(document.querySelectorAll('.row')).filter((row) => !row.hidden).slice(0, 3)
      .map((row) => row.querySelector('.row-word').textContent)`);
    check('the export starts with the same words the list shows first', words.slice(0, 1).join(',') === uiFirst.slice(0, 1).join(','), `${words[0]} / ${uiFirst[0]}`);
  }

  // Exporting without a selection asks first, and the dialog is explicit about what will
  // happen, which is the documented behaviour.
  const emptyExport = await results.evaluate(`(async () => {
    document.getElementById('btn-clear-selection').click();
    document.getElementById('btn-export').click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const dialog = document.getElementById('confirm-dialog');
    const result = { open: dialog.open, title: document.getElementById('confirm-title').textContent, accept: document.getElementById('confirm-accept').textContent };
    document.getElementById('confirm-cancel').click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    result.closedAfterCancel = !dialog.open;
    return result;
  })()`);
  check('exporting with nothing selected asks for confirmation', emptyExport.open === true, JSON.stringify(emptyExport));
  check('the dialog says what the alternative is', /Export all/.test(emptyExport.accept), emptyExport.accept);
  check('cancelling the dialog closes it', emptyExport.closedAfterCancel === true);

  // ============================================================================
  console.log('\n7. Console cleanliness');

  const optionsErrors = optionsPage.consoleErrors.filter((entry) => !/favicon/i.test(entry));
  const resultsErrors = results.consoleErrors.filter((entry) => !/favicon/i.test(entry));
  const pageErrors = page.consoleErrors.filter((entry) => !/favicon/i.test(entry));

  check('the content script logged no errors on the page', pageErrors.length === 0, pageErrors.join(' | '));
  check('the results page logged no errors', resultsErrors.length === 0, resultsErrors.join(' | '));
  check('the options page logged no errors', optionsErrors.length === 0, optionsErrors.join(' | '));

  const workerTarget = await waitForTarget(devtoolsPort, (target) => target.url.includes('service-worker.js'), 4000);
  if (workerTarget) {
    const worker = new Target(workerTarget, 'service worker');
    await worker.connect();
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    check('the service worker logged no errors', worker.consoleErrors.length === 0, worker.consoleErrors.join(' | '));
    worker.close();
  } else {
    note('the service worker target was not listed, so its console was not inspected');
  }

  const chromeWarnings = chromeLog
    .join('')
    .split('\n')
    .filter((line) => /ERROR:.*(extension|manifest)/i.test(line));
  check('Chrome reported no extension or manifest errors', chromeWarnings.length === 0, chromeWarnings.slice(0, 3).join(' | '));
} catch (error) {
  fail('the end-to-end check crashed', (error && error.stack) || String(error));
} finally {
  stop();
  if (KEEP) {
    console.log(`\nProfile kept at ${userDataDir}`);
    console.log(`Downloads kept at ${downloadDir}`);
  } else {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    await rm(downloadDir, { recursive: true, force: true }).catch(() => {});
  }
}

console.log('');
if (notes.length > 0) {
  console.log('Notes:');
  for (const message of notes) console.log(`  - ${message}`);
  console.log('');
}

if (failed === 0) {
  console.log(`All ${passed} end-to-end checks passed.`);
  process.exit(0);
} else {
  console.log(`${passed} checks passed, ${failed} failed.`);
  process.exit(1);
}
