# High-Frequency Word Scanner

A Chrome extension (Manifest V3, no build step) that scans the visible English text on the
page you are reading, ranks the words by how often they appear, looks up definitions from
free English dictionaries, and exports the words you pick as a Markdown file.

Everything runs locally in your browser. Nothing about the page you are reading is uploaded
anywhere.

---

## Contents

1. [Requirements](#requirements)
2. [Install](#install)
3. [Use it](#use-it)
4. [What counts as a word](#what-counts-as-a-word)
5. [Filters and lemmatization](#filters-and-lemmatization)
6. [The results page](#the-results-page)
7. [Dictionary sources](#dictionary-sources)
8. [Optional offline mode](#optional-offline-mode-wordnet-3-0-subset)
9. [How a lookup behaves when things go wrong](#how-a-lookup-behaves-when-things-go-wrong)
10. [Markdown export](#markdown-export)
11. [Privacy](#privacy)
12. [Permissions](#permissions)
13. [File listing](#file-listing)
14. [Edge cases and scope](#edge-cases-and-scope)
15. [Development and verification](#development-and-verification)

---

## Requirements

- Chrome 111 or newer (the manifest declares `minimum_chrome_version: "111"`).
- Node.js only if you want to run the test suites or build the optional offline dictionary.
  The extension itself has no runtime dependencies and no build step.

## Install

1. Download or clone this folder.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. The extension is now active on every `http` and `https` page.

There is no toolbar popup and no sign-in. Settings, cache statistics and the optional
offline dictionary live on the options page, reachable from the extension card in
`chrome://extensions` (**Details → Extension options**) or by right-clicking the extension
icon and choosing **Options**.

### The `data/` folder is optional

`data/` holds the optional offline WordNet subset. It is not required: the extension works
without it using the three online sources. If you do not want a 4 MB folder in your checkout,
delete `data/` and the extension still loads and works. See
[Optional offline mode](#optional-offline-mode-wordnet-3-0-subset).

## Use it

1. Open any English article, blog post or documentation page.
2. Click the **radar button in the bottom-left corner**. The icon sweeps while the page is
   being read, and a toast reports the result.
3. The results page opens in its own tab.
4. Click a word to read its definition. Tick the checkbox (or press `Enter` and use
   **Select this word**) to add words to your selection.
5. Press **Export N .md**.

Clicking the button again while a scan is already running is ignored, so a double click
cannot start two scans.

## What counts as a word

Text is extracted by walking text nodes under `document.body` with a `TreeWalker`. Skipped:

- `script`, `style`, `noscript`, `template`, `svg`, `canvas`, `iframe`, `object`, `embed`,
  `audio`, `video`, `map`, `area`, `head`, `title`, `meta`, `link`, `source`, `track`,
  `param`, and the form controls `input`, `textarea`, `select`, `option`, `optgroup`
- anything not rendered: `display: none`, `visibility: hidden` or `collapse`, `opacity: 0`,
  `content-visibility: hidden`
- the `hidden` and `inert` attributes, and `aria-hidden="true"` subtrees
- `code`, `pre`, `samp`, `kbd` and `var`, controlled by the **Exclude code blocks** option
  (default: on). Source code is full of identifiers such as `getElementById`, `undefined` and
  `props`, which are not vocabulary a reader is trying to learn, and they would dominate the
  tail of the ranking without ever appearing in a dictionary.

Tokenizing rules, all in `content/content.js`:

| Input | Behaviour | Why |
| --- | --- | --- |
| `Example` / `example` | Counted as `example`. The record also tracks how often the word was capitalized (excluding sentence starts), shown in the detail panel. | Case-insensitive counting is what a frequency list means; the capitalization ratio is kept because a proper noun behaves differently from a common one. |
| `don't`, `it's` | Kept as one word, apostrophe included. Straight and curly apostrophes are treated the same. | Splitting contractions produces `don` and `t`, which are not words and would pollute the list. |
| `well-known` | Kept as **one** word. | A hyphenated compound is a single lexical item with its own dictionary entry. Splitting it would also make the two halves count against unrelated words. |
| `2`, `42`, `3.14` | Never matched. | Digits are not vocabulary. |
| `https://example.com/x`, `me@example.com`, `report.pdf`, `main.js` | Each match is removed *before* word matching, so neither the URL nor its parts are counted. | These are addresses, not words, and would otherwise contribute meaningless high-frequency tokens such as `com` and `www`. |

Very large pages are capped rather than allowed to freeze the tab: at most
**200,000 characters**, **120,000 nodes** and **60,000 stored tokens**. The scan runs in
slices of about 4 ms, yielding between slices with `requestIdleCallback`, so the page stays
responsive and the button reports progress. When a cap is hit the button says so, and the
results page repeats the reason in a banner ("the page was truncated").

## Filters and lemmatization

All three filters run on the **results page**, not during the scan, so you can change them
and see the ranking update instantly without reading the page again.

| Control | Default | Notes |
| --- | --- | --- |
| Stop word filter | on | 363 common English function words, in `lib/stopwords.js`. |
| Minimum word length | 3 | Range 1–20. |
| Lemmatization | on | Merges `running → run`, `books → book`, `studies → study`. |

### How lemmatization works, and where it fails

`lib/lemmatize.js` is a **rule-based** lemmatizer: suffix rules for the regular inflections
(`-s`, `-es`, `-ies`, `-ing`, `-ed`) plus a hand-written map of irregular forms (`went → go`,
`better → good`, `children → child`). There is no bundled lemma table, because a table
accurate enough to be useful is several megabytes, and this extension deliberately has no
build step and a small unpacked footprint.

The genuinely ambiguous stems are resolved by a **corpus check** instead of a lexicon: for a
token such as `including`, the lemmatizer proposes several candidates (`includ`, `include`)
and `lib/analyze.js` picks the first one that also appears on the page as a standalone word.
That is why `included` and `includes` land on `include` rather than on a bare stem.

Known limits, stated plainly:

- Words that appear **only** in an inflected form can be shown as a stem rather than a
  dictionary headword. A page that only ever says "changing" can yield "chang".
- Unseen irregular forms are not merged (`slew` does not become `slay`).
- Comparative and superlative endings are deliberately **not** stripped: cutting `-er` turns
  `water` into `wat`, `under` into `und` and `letter` into `lett`, which is worse than the
  benefit. Genuine cases (`better`, `best`, `worse`) are in the irregular map instead.
- Adverb `-ly` is not stripped, for the same reason (`only` must not become `on`).
- Contractions and hyphenated compounds are left as they are.

Turn lemmatization off to see the raw surface forms.

## The results page

**Header.** Source page title, the source URL (clickable), scan time, total word tokens, and
the number of unique words. If the scan was truncated, the reason is shown here.

**List.** One row per word, showing the word, a count badge, a small frequency bar, and a
checkbox. Clicking the word itself (not the checkbox) opens the detail panel.

**Controls.** Real-time search (prefix or substring), a sort toggle (frequency descending, or
alphabetical), and bulk actions: *Select all*, *Select current filtered results*, *Invert
selection*, *Clear selection*.

**Rendering strategy: windowed virtualization**, not pagination. With several thousand unique
words, pagination forces you to page through the ranking to find anything, and it fights with
the search box, which can shrink the list from 4,000 rows to 3 without warning. Virtualization
keeps the DOM at roughly 40 row elements no matter how many words there are, uses a fixed
44 px row height so the scroll arithmetic is exact, and makes keyboard navigation a plain
index. Measured on this machine, analyzing 200,000 tokens into 3,962 unique words takes about
**112 ms**, and re-filtering those 3,962 records takes about **0.4 ms**, so typing in the
search box stays smooth.

**Keyboard.** `Tab` reaches the search box; `ArrowDown`/`ArrowUp` move the active row (from
the search box or from the list); `Enter` opens the detail panel for the active row; `Esc`
closes the panel.

**Detail panel.** A **right-side sliding drawer** rather than inline expansion. Definitions
are long and variable in height, so expanding inline would push the rest of the page around
and lose your scroll position in the list; a drawer keeps the ranking stable while you read,
and it has room for phonetics, audio, grouped definitions and the per-source report.

**Selection persists.** Ticking words writes them to `chrome.storage.local` under
`selection:<scanId>`, so a refresh, or reopening the results tab, restores exactly what was
checked. A new scan starts a new selection.

## Dictionary sources

Each source is a module in `background/dictionary/providers/` exposing the same interface,
`lookup(word, budget) → normalizedEntry | null`. They are tried in priority order and the
first hit wins. The user interface only ever sees the normalized shape, never a raw API
response:

```
{
  word: string,
  phonetic: string | null,
  audioUrl: string | null,
  source: string,
  meanings: [
    { partOfSpeech: string, definitions: [ { definition: string, example: string | null } ] }
  ]
}
```

| # | Source | Endpoint | Auth | Role |
| --- | --- | --- | --- | --- |
| 1 | Free Dictionary API | `https://api.dictionaryapi.dev/api/v2/entries/en/<word>` | none | Primary. Returns phonetics with audio, examples, synonyms and antonyms in one response. Answers 404 for unknown words, which counts as a miss, not a failure. |
| 2 | Wiktionary REST API | `https://en.wiktionary.org/api/rest_v1/page/definition/<word>` | none | Fallback. Field names differ substantially from source 1, so it has its own normalizer. |
| 3 | Datamuse | `https://api.datamuse.com/words?sp=<word>&md=dpr&max=1` | none | Gap filler. `md=d` supplies WordNet glosses, `md=p` parts of speech, `md=r` an ARPAbet pronunciation hint. It never returns example sentences, so its phonetics are labelled as a hint in the UI. |
| 4 | WordNet 3.0 subset | local IndexedDB | none | Optional offline layer. See below. |

All requests are issued from the **service worker**, never from the content script, and the
three hostnames are declared in `host_permissions`, so no CORS preflight is involved and no
cross-origin error can reach the page. Failed responses are normalised tolerantly: a missing
field becomes `null`, an empty definition list makes the provider report a miss, and a
malformed body cannot throw out of the provider chain.

**Concurrency and politeness.** Requests to one host are serialized and spaced (Wikimedia
rate-limits anonymous traffic aggressively). Each provider is retried only when there is
budget left and no fallback remains to try. The extension identifies itself to Wikimedia with
a descriptive `Api-User-Agent` header, because browsers forbid setting `User-Agent` from
`fetch()`; Wikimedia's documented browser-client guidance is to use `Api-User-Agent` instead.

**Caching.** A word is fetched once. Results are cached in memory for the lifetime of the
service worker *and* in `chrome.storage.local`, so the cache survives a browser restart.
The storage cache is capped at 800 words (evicting the oldest 200) because
`chrome.storage.local` has a ~10 MB quota and this extension does not request
`unlimitedStorage`. Lifetimes differ by outcome: a hit is kept for 30 days, a definite "no
source has this word" for 3 days, and a failure for only 10 minutes so a transient network
problem is retried soon. In the browser check, a repeat click on an already-fetched word
renders from cache in about **63 ms**.

### Attribution

- **Wiktionary** content is available under the **Creative Commons Attribution-ShareAlike
  3.0 Unported licence**. The detail panel names Wiktionary as the source, and a link to the
  source page is kept on the entry.
- **Free Dictionary API** is a community-run service whose content comes from Wiktionary, and
  it is credited by name in the detail panel and in the export.
- **Datamuse** returns WordNet glosses; those are labelled as WordNet 3.0.
- **WordNet 3.0** is distributed by Princeton University under its permissive licence, which
  allows redistribution when the notice travels with the data. That notice is stored in
  `data/wordnet-LICENSE.txt`.

The detail panel always shows which source answered, so you can judge reliability, and the
downloaded Markdown ends with a **Sources and license** section that reproduces the same
attribution.

## Optional offline mode: WordNet 3.0 subset

This layer lets the extension answer with no network at all. It is optional and off until you
build and import it.

**Where the data comes from.** Nothing is scraped or re-hosted. `tools/build-wordnet-subset.mjs`
downloads the official Princeton WordNet 3.0 database tarball
(`https://wordnetcode.princeton.edu/3.0/WNdb-3.0.tar.gz`, about 10 MB, unchanged since 2007),
parses it, and writes a trimmed subset.

**How to build it.**

```bash
node tools/build-wordnet-subset.mjs
```

The script downloads and caches the tarball (in your system temporary directory), reads the
four synset data files out of it using Node's built-in `zlib` only — no dependency to install
— and writes:

| File | Size (this build) | Contents |
| --- | --- | --- |
| `data/wordnet-subset.ndjson.gz` | 4.18 MB | Newline-delimited JSON: line 1 is metadata, every following line is one normalised entry in exactly the shape the online providers produce. 31.59 MB uncompressed. |
| `data/wordnet-LICENSE.txt` | 1.5 KB | The verbatim WordNet 3.0 licence notice. |

This build produced **82,688 entries** from **117,659 synsets** and **133,713 definitions**
(the synset total matches WordNet 3.0's published size). Multi-word lemmas such as
`hot_dog` are dropped — they are about a quarter of the database, the extension only ever
looks up single tokens, and dropping them is a large saving for no loss. Definitions are
capped at 6 per part of speech, matching the online providers.

**How it is queried.** The file is data, not code: the options page
(**Import the offline subset**) streams it, decompresses it with `DecompressionStream` and
imports it into **IndexedDB** in batches, so the whole 31 MB is never held in memory at once.
IndexedDB rather than `chrome.storage.local` because the latter has that ~10 MB quota, while
an IndexedDB database on the extension origin does not, and a keyed lookup is one index hit
instead of parsing a multi-megabyte blob. When the subset is not installed this provider
reports itself as skipped, costing one `count()` call per service worker lifetime.

**Regenerating it.** The script is idempotent; run it again any time. `--out <file>`,
`--min-length <n>`, `--multiword`, `--max-definitions <n>` and `--no-cache` are available,
and `--tar <file>` points it at a tarball you already have.

## How a lookup behaves when things go wrong

One lookup may spend at most **7,000 ms** in the provider chain, in total, across every source
and retry. Without that ceiling a single unresponsive host multiplies out to over a minute
(four providers × two attempts × the 6 s request timeout) with the panel stuck on its
skeleton, which is the failure mode this budget exists to prevent.

The budget is divided rather than raced: each provider is given a slice of what is left, and
one minimum slice is held back for every provider still to be tried, so a slow primary cannot
starve the fallbacks. Unused time is simply returned.

| Situation | What you see |
| --- | --- |
| Word is in a source | Definitions within the normal latency of that source. |
| Unknown word (404 everywhere) | "No entry found for this word in the configured sources", plus the per-source report. |
| Rate limited / 5xx | Retried once when no fallback remains, otherwise the next source is tried immediately. |
| Timeout or no network | The panel lists what each source answered ("timed out after 4900 ms"), with a **Retry** button. It is never blank. |
| Malformed or partial response | The fields that did parse are shown; missing ones are omitted rather than displayed as `null`. |
| Budget exhausted | A clear message naming the 7,000 ms budget, the sources tried, and a **Retry** button. |

Every one of those outcomes is cached, so a repeat click is instant rather than another wait.
A failure is cached for only 10 minutes so that retrying is worthwhile.

## Markdown export

**Export N .md** writes the selected words, ordered by frequency descending. With nothing
selected, a dialog offers **Export all N** and says so explicitly rather than guessing.
Words whose definitions are not loaded yet are still exported with their word and count; the
button shows a progress state while the remaining definitions are fetched, and gives up on a
word after 7 seconds so a dead network cannot stall the file forever.

Implementation: a `Blob` plus `URL.createObjectURL` and an `<a download>` element, not
`chrome.downloads`. This keeps the `downloads` permission out of the manifest entirely, and
it means the export path needs no extra permission prompt. The object URL is released a
minute later, because revoking it immediately can cancel the download in some Chrome
versions.

**Filename:** `highfreq-<domain>-<YYYY-MM-DD>.md`, ASCII only, with the domain sanitized to a
safe slug (`127.0.0.1` becomes `127-0-0-1`).

**Format.** Plain CommonMark with no extensions, no inline HTML and no footnotes, which is
what makes it render identically in Typora, VS Code preview and on GitHub. Dictionary text is
whitespace-collapsed and inline Markdown characters are escaped, so a definition containing
an asterisk or a newline cannot break the list it lives in.

```markdown
# High-Frequency Word List

- Source: Example article
- URL: https://example.com/article
- Exported: 2026-10-15 16:42
- Word count: 2

## 1. example (12 occurrences)

- **Phonetic**: /ɪɡˈzɑːmpl/
- **Part of speech**: noun
- **Definition**: a thing characteristic of its kind
- **Example**: This is a good example of modern design.
```

## Privacy

- **Page content is never collected or uploaded.** Text is tokenized inside the tab and the
  resulting token list is written to `chrome.storage.local` on your machine. There is no
  analytics, no telemetry, and no server operated by this project.
- **All counting happens locally.**
- **The only outbound requests are dictionary lookups**, issued from the service worker, and
  only for words you actually open or export. Reading a page and looking at the ranking sends
  nothing at all.
- Lookups are unauthenticated: no account, no key, no cookie (requests use
  `credentials: 'omit'`). Your IP address is visible to whichever dictionary host answers,
  as it would be in a normal browser request, and a lookup transmits one word — not the page.
- The same statement is shown in the exported file and on the options page.

## Permissions

Only what is needed, and each one for a stated reason:

| Permission | Why |
| --- | --- |
| `storage` | The scan result, your selection, your settings, and the lookup cache. Local only; no `sync`. |
| `host_permissions` for `api.dictionaryapi.dev`, `en.wiktionary.org`, `api.datamuse.com` | Lets the service worker fetch definitions without CORS restrictions. |
| `content_scripts.matches` for `http://*/*` and `https://*/*` | This is what puts the scan button on the page. Without it the button could only appear after a manual click on the toolbar. |

Deliberately **not** requested:

- `tabs` — the title and URL come from the content script, and `chrome.tabs.create` needs no
  permission.
- `downloads` — the export uses a Blob and an anchor element instead.
- `scripting` — the content script is declared declaratively.
- `webRequest` — all dictionary traffic goes through the service worker.
- `unlimitedStorage` — the scan payload is around 0.5 MB and the WordNet subset lives in
  IndexedDB, not in `chrome.storage.local`.

## File listing

```
manifest.json                       61   MV3 manifest; every permission is commented in place.

content/content.js                 956   Floating button in a Shadow DOM, chunked TreeWalker
                                          extraction, tokenizer, "reveal on page".

background/service-worker.js       164   Message routing, opening the results tab.
background/dictionary/lookup.js    365   Provider chain, budget, caching, deduplication.
background/dictionary/http.js      191   Timeouts, retries with backoff, per-host spacing.
background/dictionary/shared.js    154   Entry/definition constructors, shared text cleanup.
background/dictionary/providers/free-dictionary.js  130   Source 1 normalizer.
background/dictionary/providers/wiktionary.js       151   Source 2 normalizer.
background/dictionary/providers/datamuse.js         125   Source 3 normalizer.
background/dictionary/providers/wordnet-offline.js   92   Source 4, reads IndexedDB.

lib/constants.js                   142   Storage keys, message types, limits, defaults.
lib/analyze.js                     187   Token list -> ranked records; the three filters.
lib/lemmatize.js                   294   Suffix rules plus the irregular-form map.
lib/stopwords.js                    93   The 363-word English stop list.
lib/markdown.js                    217   Markdown builder and filename rules.
lib/format.js                      117   Number, date and slug formatting.
lib/wordnet-store.js               148   IndexedDB access for the offline subset.

results/results.html               173   Results page markup.
results/results.js                1015   Header, virtualization, search, sort, selection, export.
results/results.css                510   Results page styles, light and dark.
results/detail.js                  389   Detail drawer: entry, audio, per-source report.
results/detail.css                 268   Drawer styles.
results/lookup-client.js            73   Shared lookup client with an in-memory cache.

options/options.html               366   Settings, cache stats, offline import, attribution.
options/options.js                 542   Options logic and the NDJSON streaming import.
options/options.css                517   Options styles.

styles/base.css                    334   Shared design tokens, buttons, light/dark mode.

tools/build-wordnet-subset.mjs     499   Builds the optional offline subset.
tools/selftest.mjs                 685   182 checks, no browser and no network needed.
tools/e2e-check.mjs                910   70 checks in a real Chrome over the DevTools Protocol.

data/                                    Optional; created by the build script.
```

About 9,900 lines across JavaScript, HTML, CSS and JSON.

## Edge cases and scope

1. **No English words found.** The results page shows an empty state explaining what was
   searched and suggesting what to try (a different page, or turning off the stop word
   filter and lowering the minimum length).
2. **Very long pages.** Chunked scanning, the 200,000-character / 120,000-node / 60,000-token
   caps, progress on the button, and an explicit truncation notice. The main thread is never
   blocked for more than a few milliseconds at a time.
3. **Boilerplate.** Pages heavy in navigation, cookie banners and copyright footers do skew a
   ranking. An optional **Exclude boilerplate** setting is provided and is **off by default**,
   because every heuristic here misfires somewhere. When enabled it skips `<nav>`, `<header>`,
   `<footer>`, `<aside>`, landmark roles (`navigation`, `banner`, `contentinfo`, `menu`, …),
   and elements whose class or id matches a documented list of patterns (`cookie`, `consent`,
   `sidebar`, `breadcrumb`, `advert`, `newsletter`, `comments`, `paywall`, …). A more robust
   approach would be text-density scoring (a block that is mostly links between other blocks
   is navigation), and that is the natural next step if the simple heuristic proves
   insufficient.
4. **Leaving the page or closing the tab mid-scan.** The extraction loop checks whether its
   document is still alive between slices and stops quietly; a scan that cannot finish reports
   the failure through the service worker and no uncaught error reaches the console. The
   results page also handles the source tab being gone: **Rescan** and **Show on page** explain
   that the tab is no longer available instead of failing silently.
5. **The same word in different forms.** Merged by lemmatization, which can be switched off.
6. **Rate limits, timeouts and 404s.** Cached, retried, and bounded — see
   [How a lookup behaves when things go wrong](#how-a-lookup-behaves-when-things-go-wrong).
7. **iframes and SPA route changes.** Out of scope, and deliberately so. Only the top-level
   document is scanned (`window.top !== window` bails out immediately), because scanning
   iframes would require `all_frames` and would double count embedded widgets, comment
   systems and ad frames. DOM mutations are **not** observed: the scan is a one-shot snapshot
   taken when you click. On a single-page app that swaps its content afterwards, click the
   button again, or use **Rescan** on the results page.

## Development and verification

There is no build step and no dependency to install. The extension runs as-is.

### Self test — 182 checks, no browser, no network

```bash
node tools/selftest.mjs
```

Covers the lemmatizer, the analyzer and its three filters, the Markdown builder, the filename
rules, all four provider normalizers, and the HTTP retry, timeout and 404 rules against a
throwaway local server. Exit code 0 on success, 1 on failure, so it drops into a pre-commit
hook or CI.

### Browser check — 70 checks in a real Chrome

```bash
node tools/e2e-check.mjs
```

Launches Chrome with a throwaway profile and the unpacked extension, then drives it over the
DevTools Protocol (Node's built-in WebSocket client, nothing to install). It serves a local
page, clicks the floating button through its shadow root, waits for the scan, opens the
results page, exercises search, sorting, selection, keyboard navigation and a refresh, opens
the detail panel, and checks the exported file's name, structure, ordering and content. It
also asserts that no page and no service worker logged an error, and that Chrome reported no
manifest problems. `--keep` preserves the profile and downloads, `--chrome <path>` picks a
different binary.

### The CJK check

The product is English only, and this is enforced rather than intended: the self test reads
every text file in the repository and fails if any of them contains a character from the CJK
ranges. There is no exemption list — if the test ever needed one, the file would be wrong.

```bash
node tools/selftest.mjs        # includes the scan, and names any offending file and line
```

The equivalent one-liner, which must print nothing and exit with status 1:

```bash
grep -rIP '[\x{2E80}-\x{9FFF}\x{F900}-\x{FAFF}\x{FF00}-\x{FFEF}]' . --exclude-dir=.cache
```

Current status: **zero matches across the whole project**, including the README, the exported
Markdown and the built WordNet subset. (The pattern covers CJK ideographs, kana, Hangul,
full-width forms and CJK punctuation; the self test uses the same set.)

### Notes on performance measurement

The numbers quoted above (112 ms to analyze 200,000 tokens, 0.4 ms to re-filter 3,962 words,
63 ms for a cached repeat lookup) were measured on the development machine that built this,
and will vary with your hardware and network.

First-lookup latency depends entirely on the dictionary hosts. On a warm connection the
primary source answers in a few hundred milliseconds. While developing this, one test
environment routed every request to `api.dictionaryapi.dev` through a proxy that took about
20 seconds per request; the 7,000 ms budget then cut in, the fallbacks were tried, and the
panel showed a clear "timed out … with a Retry button" message instead of hanging. That is
the intended behaviour, but it does mean the "definitions appear within a second" expectation
holds for the network, not for the extension alone.
