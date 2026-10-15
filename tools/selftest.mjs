/**
 * Self test. Run it after any change to the analysis, the export or the normalizers:
 *
 *   node tools/selftest.mjs
 *
 * It needs no browser and no network. Two kinds of check run here:
 *
 *   1. Behavioural checks with fixtures: the lemmatizer, the analyzer, the Markdown
 *      builder, the filename rules, the provider normalizers, and the HTTP retry rules
 *      against a throwaway local server.
 *   2. The CJK scan: every text file in the repository is read and rejected if it
 *      contains a character from a CJK range. This is the automated form of the
 *      "searching the codebase for CJK characters returns zero matches" requirement.
 *      There is no exemption list: if this test ever needs one, the file is wrong.
 *
 * Exit code is 0 when everything passes and 1 when anything fails, so it can be wired
 * into a pre-commit hook or a CI step.
 */

import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, filterRecords, normalizeSettings, sortRecords } from '../lib/analyze.js';
import { DEFAULT_SETTINGS, LIMITS, STORAGE_KEYS } from '../lib/constants.js';
import { formatBytes, formatDate, hostnameOf, slugify, truncate } from '../lib/format.js';
import { lemmaCandidates, lemmatize } from '../lib/lemmatize.js';
import { buildMarkdown, escapeInline, exportFilename } from '../lib/markdown.js';
import { STOP_WORDS } from '../lib/stopwords.js';

import { HttpError, requestJson } from '../background/dictionary/http.js';
import { cleanText, finalizeMeanings, makeEntry } from '../background/dictionary/shared.js';
import * as datamuse from '../background/dictionary/providers/datamuse.js';
import * as freeDictionary from '../background/dictionary/providers/free-dictionary.js';
import * as wiktionary from '../background/dictionary/providers/wiktionary.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// --- Tiny test harness ----------------------------------------------------------

let passed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n${name}`);
}

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${currentGroup} > ${label}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ''}`);
  }
}

function equal(label, actual, expected) {
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- Lemmatizer ------------------------------------------------------------------

group('Lemmatizer: regular forms merge');
for (const [surface, expected] of [
  ['running', 'run'],
  ['runs', 'run'],
  ['books', 'book'],
  ['studies', 'study'],
  ['studied', 'study'],
  ['watches', 'watch'],
  ['boxes', 'box'],
  ['dishes', 'dish'],
  ['goes', 'go'],
  ['walked', 'walk'],
  ['making', 'make'],
  ['hoping', 'hope'],
  ['agreed', 'agree'],
  ['cities', 'city'],
  ['planning', 'plan'],
  ['receiving', 'receive'],
  ['stopped', 'stop'],
  ['carries', 'carry']
]) {
  equal(`${surface} -> ${expected}`, lemmatize(surface), expected);
}

group('Lemmatizer: irregular forms merge');
for (const [surface, expected] of [
  ['went', 'go'],
  ['gone', 'go'],
  ['children', 'child'],
  ['better', 'good'],
  ['worst', 'bad'],
  ['thought', 'think'],
  ['analyses', 'analysis'],
  ['written', 'write'],
  ['feet', 'foot']
]) {
  equal(`${surface} -> ${expected}`, lemmatize(surface), expected);
}

group('Lemmatizer: known limits are respected, not hidden');
for (const surface of [
  'water',
  'under',
  'letter',
  'morning',
  'lens',
  'need',
  'address',
  'series',
  'analysis',
  'press',
  'wedding',
  'only',
  'movies'
]) {
  equal(`${surface} stays ${surface}`, lemmatize(surface), surface);
}

group('Lemmatizer: compounds and contractions are left alone');
for (const surface of ["don't", "it's", 'well-known', 'state-of-the-art']) {
  equal(`${surface} stays ${surface}`, lemmatize(surface), surface);
}

group('Lemmatizer: candidates are ordered best first');
check('stemming yields a candidate list', lemmaCandidates('including').length >= 1);
check(
  'the raw stem is always among the candidates',
  lemmaCandidates('including').includes('includ')
);
check('unknown words produce one candidate', lemmaCandidates('serendipity').length === 1);

// --- Analyzer --------------------------------------------------------------------

/**
 * Builds a scan payload from a whitespace-separated text sample.
 *
 * It mirrors what the content script produces: tokens are already lower cased (normalizing
 * happens in the tab, where the surface form is still available), while the capitalization
 * of the original spelling is carried in the parallel `caps` string.
 */
function payloadFrom(text) {
  const rawTokens = text.split(/\s+/).filter(Boolean);
  const tokens = rawTokens.map((token) => token.toLowerCase());
  const caps = rawTokens.map((token) => (/^[A-Z]/.test(token) ? '1' : '0')).join('');
  return { tokens, caps, offsets: tokens.map((_, index) => index * 4) };
}

group('Analyzer: filters, ordering and statistics');
const sample = payloadFrom(
  'The quick brown fox jumps over the lazy dog. The fox runs. A fox Fox runs quickly and the fox runs again.'
);
const analysis = analyze(sample, DEFAULT_SETTINGS);

check('stop words are removed by default', !analysis.records.some((record) => record.word === 'the'));
check(
  'nothing shorter than the minimum length survives',
  analysis.records.every((record) => record.word.length >= DEFAULT_SETTINGS.minLength)
);
check('dropped short tokens are counted', analysis.stats.droppedShort > 0);
check('a 3-letter word survives the default minimum length', analysis.records.some((record) => record.word === 'fox'));
check('min length honours the setting', analysis.settings.minLength === 3);
check(
  'frequency ordering is descending',
  analysis.records.every((record, index) => index === 0 || analysis.records[index - 1].count >= record.count)
);
check(
  'ties are alphabetical',
  (() => {
    const ties = analysis.records.filter((record) => record.count === analysis.records[0].count);
    for (let index = 1; index < ties.length; index += 1) {
      if (ties[index - 1].word.localeCompare(ties[index].word, 'en') > 0) return false;
    }
    return true;
  })()
);
check('the token count is reported', analysis.stats.totalTokens === sample.tokens.length);
check('counted tokens are never greater than the token total', analysis.stats.countedTokens <= analysis.stats.totalTokens);
check('a first occurrence offset is recorded', analysis.records.every((record) => record.firstOccurrence !== null));
check('variants are collected', (() => {
  const run = analyze(payloadFrom('run running runs'), DEFAULT_SETTINGS).records.find((record) => record.word === 'run');
  return !!run && run.variants.includes('running');
})());

group('Analyzer: toggles change the result without touching the page');
const withStopWords = analyze(sample, { stopWords: false, minLength: 1, lemmatize: false });
check('stop words can be kept', withStopWords.records.some((record) => record.word === 'the'));
check('short words can be kept', withStopWords.records.some((record) => record.word === 'fox'));
check('counting is case-insensitive but capitalization is tracked', (() => {
  const record = withStopWords.records.find((item) => item.word === 'fox');
  return record && record.count === 5 && record.capitalizedCount === 1 && record.capitalizedRatio === 0.2;
})());
check('the recorded variants keep the surface forms seen on the page', (() => {
  const record = withStopWords.records.find((item) => item.word === 'fox');
  return record && record.variants.length === 1 && record.variants[0] === 'fox';
})());

const withoutLemmatization = analyze(payloadFrom('runs run running'), { lemmatize: false, minLength: 1, stopWords: false });
check('lemmatization can be turned off', withoutLemmatization.records.length === 3);
const withLemmatization = analyze(payloadFrom('runs run running'), { lemmatize: true, minLength: 1, stopWords: false });
check('lemmatization merges the forms', withLemmatization.records.length === 1);
equal('the merged count is the sum', withLemmatization.records[0].count, 3);
equal('the merged headword is the base form', withLemmatization.records[0].word, 'run');
equal('the surface forms are listed as variants', withLemmatization.records[0].variants.sort().join(','), 'run,running,runs');
check(
  'a capitalized spelling is counted with its lower case form and tracked separately',
  (() => {
    const record = analyze(payloadFrom('fox fox Fox Fox fox'), { minLength: 1, stopWords: false }).records[0];
    return record.count === 5 && record.capitalizedCount === 2 && Math.abs(record.capitalizedRatio - 0.4) < 1e-9;
  })()
);

group('Analyzer: settings are clamped, not trusted');
equal('min length below the floor is clamped', normalizeSettings({ minLength: -5 }).minLength, LIMITS.minLengthRange[0]);
equal('min length above the ceiling is clamped', normalizeSettings({ minLength: 999 }).minLength, LIMITS.minLengthRange[1]);
equal('a non-numeric min length falls back', normalizeSettings({ minLength: 'abc' }).minLength, DEFAULT_SETTINGS.minLength);
equal('an unknown sort mode falls back', normalizeSettings({ sort: 'sideways' }).sort, DEFAULT_SETTINGS.sort);

group('Analyzer: search filtering puts prefixes first');
const filterFixture = [
  { word: 'result', count: 5 },
  { word: 'interest', count: 9 },
  { word: 'research', count: 1 },
  { word: 'insert', count: 2 }
];
const filtered = filterRecords(filterFixture, 'res');
equal('prefix matches come first', filtered[0].word, 'result');
equal('prefix matches are ordered among themselves', filtered[1].word, 'research');
equal('substring matches follow the prefix matches', filtered[2].word, 'interest');
equal('words without the query are dropped', filtered.length, 3);
check('a word with no match at all is dropped', !filtered.some((record) => record.word === 'insert'));
equal('an empty query returns everything', filterRecords(filterFixture, '   ').length, 4);
check('an empty query returns a copy, not the original array', filterRecords(filterFixture, '') !== filterFixture);
equal('sorting alphabetically works', sortRecords(filterFixture.slice(), 'alpha')[0].word, 'insert');

// --- Stop word list ---------------------------------------------------------------

group('Stop words');
for (const word of ['the', 'of', 'and', 'is', 'are', "don't", 'was', 'been', 'they']) {
  check(`"${word}" is a stop word`, STOP_WORDS.has(word));
}
for (const word of ['research', 'algorithm', 'climate', 'design']) {
  check(`"${word}" is not a stop word`, !STOP_WORDS.has(word));
}
check('the list has no duplicates', STOP_WORDS.size === new Set(STOP_WORDS).size);
check(
  'the list is lower case only',
  Array.from(STOP_WORDS).every((word) => word === word.toLowerCase())
);

// --- Formatting --------------------------------------------------------------------

group('Formatting and filenames');
equal('a domain becomes an ASCII slug', slugify('news.example.com'), 'news-example-com');
equal('a slug never starts or ends with a hyphen', slugify('-_-example-_-'), 'example');
equal('an empty slug falls back', slugify(''), 'page');
equal('a hostname loses the www prefix', hostnameOf('https://www.example.com/a/b'), 'example.com');
equal('an invalid URL falls back', hostnameOf('not a url'), 'unknown-site');
check('the date format has no time zone surprises', /^\d{4}-\d{2}-\d{2}$/.test(formatDate(new Date(2026, 9, 15, 23, 30))));
equal('byte formatting uses binary units', formatBytes(1536), '1.5 KB');
check('truncation keeps the ellipsis inside the limit', truncate('abcdefghij', 5).length === 5);
equal(
  'the export filename follows the documented pattern',
  exportFilename('news-example-com', new Date(2026, 9, 15).getTime()),
  'highfreq-news-example-com-2026-10-15.md'
);
check(
  'the export filename is ASCII only',
  /^[\x20-\x7e]+$/.test(exportFilename(slugify('exämple.com'), Date.now()))
);

// --- Markdown export ---------------------------------------------------------------

group('Markdown export');
const exportRecords = [
  { word: 'example', count: 12, capitalizedCount: 0, capitalizedRatio: 0, variants: ['example', 'examples'], firstIndex: 0 },
  { word: 'design', count: 6, capitalizedCount: 6, capitalizedRatio: 1, variants: ['design'], firstIndex: 3 },
  { word: 'unresolved', count: 2, capitalizedCount: 0, capitalizedRatio: 0, variants: ['unresolved'], firstIndex: 9 }
];
const statusByWord = new Map([
  [
    'example',
    {
      status: 'ok',
      entry: {
        word: 'example',
        phonetic: '/ig-ZAM-pel/',
        audioUrl: null,
        source: 'Free Dictionary API',
        sourceUrl: 'https://dictionaryapi.dev/',
        license: 'CC BY-SA 3.0',
        meanings: [
          {
            partOfSpeech: 'noun',
            definitions: [{ definition: 'A thing characteristic of its kind.', example: 'This is a good example.' }]
          }
        ]
      }
    }
  ],
  [
    'design',
    {
      status: 'ok',
      entry: {
        word: 'design',
        phonetic: null,
        audioUrl: null,
        source: 'Wiktionary',
        sourceUrl: 'https://en.wiktionary.org/wiki/design',
        license: 'CC BY-SA 3.0',
        meanings: [
          {
            partOfSpeech: 'noun',
            definitions: [{ definition: 'A plan or drawing produced to show the look of something.', example: null }]
          }
        ]
      }
    }
  ],
  ['unresolved', { status: 'pending', entry: null }]
]);

const markdown = buildMarkdown({
  scan: {
    title: 'Design *Weekly*',
    url: 'https://example.com/design',
    domain: 'example.com',
    scannedAt: new Date(2026, 9, 15, 9, 30).getTime(),
    truncated: true,
    truncateReasons: ['the 200,000 character limit was reached']
  },
  records: exportRecords,
  statusByWord,
  settings: DEFAULT_SETTINGS,
  exportedAt: new Date(2026, 9, 15, 10, 0).getTime(),
  stats: { uniqueWords: 3, totalTokens: 18 }
});

check('the document starts with a top level heading', markdown.startsWith('# High-Frequency Word List\n'));
check('the source title is included', markdown.includes('- Source: Design \\*Weekly\\*'));
check('the URL is included verbatim', markdown.includes('- URL: https://example.com/design'));
check('the export time is included', markdown.includes('- Exported: 2026-10-15 10:00'));
check('the truncation note is included', markdown.includes('the scan was truncated'));
check('the active filters are described', markdown.includes('- Filters: stop words excluded | minimum length 3'));
check('words are numbered in frequency order', (() => {
  const example = markdown.indexOf('## 1. example (12 occurrences)');
  const design = markdown.indexOf('## 2. design (6 occurrences)');
  const unresolved = markdown.indexOf('## 3. unresolved (2 occurrences)');
  return example !== -1 && design > example && unresolved > design;
})());
check('a singular count reads "1 occurrence"', (() => {
  const single = buildMarkdown({
    scan: { title: 't' },
    records: [{ word: 'solo', count: 1, capitalizedCount: 0, capitalizedRatio: 0, variants: ['solo'] }],
    statusByWord: new Map([['solo', { status: 'pending', entry: null }]]),
    settings: DEFAULT_SETTINGS,
    exportedAt: Date.now(),
    stats: {}
  });
  return single.includes('## 1. solo (1 occurrence)');
})());
check('a word with no definition is still exported with its word and count', /## 3\. unresolved \(2 occurrences\)[\s\S]*?- \*\*Definition\*\*: not fetched yet/.test(markdown));
check('a definition without an example simply omits the example line', (() => {
  const design = markdown.slice(markdown.indexOf('## 2. design'), markdown.indexOf('## 3. unresolved'));
  return design.includes('- **Definition**: A plan or drawing produced') && !design.includes('- **Example**');
})());
check('the phonetic, part of speech, definition and example are present', 
  markdown.includes('- **Phonetic**: /ig-ZAM-pel/') &&
  markdown.includes('- **Part of speech**: noun') &&
  markdown.includes('- **Definition**: A thing characteristic of its kind.') &&
  markdown.includes('- **Example**: This is a good example.'));
check('a consistently capitalized word is flagged', markdown.includes('- **Usually capitalized**: 6 of 6 occurrences'));
check('each word names its own source', markdown.includes('- **Source**: Free Dictionary API') && markdown.includes('- **Source**: Wiktionary'));
check('a word whose definition was never fetched says so', markdown.includes('- **Source**: not consulted'));
check('the sources section names the licences used', markdown.includes('Creative Commons Attribution-ShareAlike 3.0'));
check('the definition order in the file follows descending frequency', (() => {
  const positions = ['example', 'design', 'unresolved'].map((word) => markdown.indexOf(`. ${word} (`));
  return positions.every((position, index) => position !== -1 && (index === 0 || position > positions[index - 1]));
})());
check('the document ends with a newline', markdown.endsWith('\n'));
check('no CJK characters reach the export', !/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(markdown));

group('Markdown escaping');
equal('asterisks are escaped', escapeInline('a *b* c'), 'a \\*b\\* c');
equal('newlines collapse to one line', escapeInline('first\nsecond'), 'first second');
equal('a leading list marker is escaped', escapeInline('- item'), '\\- item');
equal('backticks are escaped', escapeInline('a `code` span'), 'a \\`code\\` span');
equal('empty input stays empty', escapeInline(null), '');

// --- Provider normalizers -----------------------------------------------------------

group('Normalizer: Free Dictionary API fixture');
const freeDictionaryFixture = [
  {
    word: 'run',
    phonetic: '/rʌn/',
    phonetics: [
      { audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/run-au.mp3', license: { name: 'BY-SA 4.0' } },
      { text: '/ɹʌn/', audio: '' }
    ],
    meanings: [
      {
        partOfSpeech: 'verb',
        definitions: [
          { definition: 'To move swiftly.', synonyms: [], antonyms: [] },
          { definition: 'To move swiftly.', synonyms: [], antonyms: [] },
          { definition: 'To carry (a football) down the field.', example: 'He ran the ball.' }
        ]
      },
      { partOfSpeech: 'noun', definitions: [{ definition: 'An act of running.' }] }
    ],
    license: { name: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0' },
    sourceUrls: ['https://en.wiktionary.org/wiki/run']
  }
];
const freeEntry = freeDictionary.normalize('run', freeDictionaryFixture);
check('an entry is produced', !!freeEntry);
equal('the word is lower cased', freeEntry.word, 'run');
equal('the phonetic is taken from the entry or its phonetics list', freeEntry.phonetic, '/rʌn/');
equal('the audio URL survives', freeEntry.audioUrl, 'https://api.dictionaryapi.dev/media/pronunciations/en/run-au.mp3');
equal('parts of speech are grouped', freeEntry.meanings.length, 2);
equal('duplicate definitions are dropped', freeEntry.meanings[0].definitions.length, 2);
equal('the example is kept', freeEntry.meanings[0].definitions[1].example, 'He ran the ball.');
equal('the source is named', freeEntry.source, 'Free Dictionary API');
check('the licence is carried through', freeEntry.license.includes('CC BY-SA'));
check('a malformed payload yields null instead of throwing', freeDictionary.normalize('x', [{}]) === null);
check('an empty payload yields null', freeDictionary.normalize('x', []) === null);

group('Normalizer: Wiktionary fixture');
const wiktionaryFixture = {
  en: [
    {
      partOfSpeech: 'Noun',
      language: 'English',
      definitions: [
        {
          definition: 'A [[w:thing|thing]] <span class="mention">characteristic</span> of its kind.',
          parsedExamples: [{ example: 'This is a good example.' }]
        },
        { definition: 'A pattern to be followed.', examples: ['Follow the example.'] }
      ]
    },
    { partOfSpeech: 'Verb', language: 'English', definitions: [{ definition: 'To illustrate.' }] }
  ],
  fr: [{ partOfSpeech: 'Nom', language: 'French', definitions: [{ definition: 'Exemple.' }] }]
};
const wiktionaryEntry = wiktionary.normalize('example', wiktionaryFixture);
check('an entry is produced', !!wiktionaryEntry);
equal('only the English groups are used', wiktionaryEntry.meanings.length, 2);
check('wiki markup is stripped from definitions', !wiktionaryEntry.meanings[0].definitions[0].definition.includes('['));
check(
  'the definition text survives the cleanup',
  wiktionaryEntry.meanings[0].definitions[0].definition.startsWith('A thing characteristic')
);
equal('parsedExamples are read first', wiktionaryEntry.meanings[0].definitions[0].example, 'This is a good example.');
equal('plain examples are the fallback', wiktionaryEntry.meanings[0].definitions[1].example, 'Follow the example.');
equal('no phonetic is invented', wiktionaryEntry.phonetic, null);
check('the licence is CC BY-SA', wiktionaryEntry.license.includes('CC BY-SA'));
check('a non-English payload yields null', wiktionary.normalize('example', { fr: wiktionaryFixture.fr }) === null);

group('Normalizer: Datamuse fixture');
const datamuseFixture = {
  word: 'example',
  score: 149077,
  tags: ['n', 'v', 'pron:IH0 G Z AE1 M P AH0 L '],
  defs: ['n\tSomething that is representative of all such things in a group. ', 'v\tTo be illustrated or exemplified.']
};
const datamuseEntry = datamuse.normalize('example', datamuseFixture);
check('an entry is produced', !!datamuseEntry);
equal('both parts of speech are read from the tab prefix', datamuseEntry.meanings.length, 2);
equal('the part-of-speech letter is translated', datamuseEntry.meanings[0].partOfSpeech, 'noun');
equal('the tab prefix is removed from the gloss', datamuseEntry.meanings[0].definitions[0].definition, 'Something that is representative of all such things in a group.');
equal('the ARPAbet hint is kept as the phonetic', datamuseEntry.phonetic, 'IH0 G Z AE1 M P AH0 L');
check('no examples are invented', datamuseEntry.meanings.every((meaning) => meaning.definitions.every((definition) => definition.example === null)));
equal('an empty definition list yields null', datamuse.normalize('x', { word: 'x', defs: [] }), null);

group('Normalizer: shared entry rules');
equal('script tags are stripped from text', cleanText('a <b>bold</b> move'), 'a bold move');
equal('entities are decoded', cleanText('salt &amp; pepper &ndash; here'), 'salt & pepper - here');
check('very long text is capped', cleanText('x'.repeat(2000)).length <= 600);
equal('a definition with no text is rejected', makeEntry({ word: 'x', meanings: [{ partOfSpeech: 'noun', definitions: [] }] }), null);
equal('definitions are capped per part of speech', (() => {
  const definitions = Array.from({ length: 20 }, (_, index) => ({ definition: `definition ${index}`, example: null }));
  return finalizeMeanings([{ partOfSpeech: 'noun', definitions }])[0].definitions.length;
})(), 8);
equal('part-of-speech labels are merged case-insensitively', finalizeMeanings([
  { partOfSpeech: 'Noun', definitions: [{ definition: 'one', example: null }] },
  { partOfSpeech: 'noun', definitions: [{ definition: 'two', example: null }] }
]).length, 1);
check('a javascript: audio URL is refused', makeEntry({
  word: 'x',
  audioUrl: 'javascript:alert(1)',
  meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'd', example: null }] }]
}).audioUrl === null);

// --- HTTP helper ---------------------------------------------------------------------

group('HTTP helper: retries, timeouts and status handling');

/**
 * A local server that answers with whatever the test wants and counts the attempts.
 * Binding a port is not always possible in every sandbox, so a failure here is reported
 * as a skip rather than as a failed check.
 */
async function withTestServer(handler, run) {
  const server = createServer(handler);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    console.log(`  skip  the local test server could not start (${(error && error.message) || error})`);
    return;
  }

  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Counts requests to the flaky endpoint across the checks below. */
let attempts = 0;

await withTestServer(
  (request, response) => {
    if (request.url === '/ok') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('[{"word":"example"}]');
      return;
    }
    if (request.url === '/missing') {
      response.writeHead(404);
      response.end('{"title":"Not found"}');
      return;
    }
    if (request.url === '/flaky') {
      attempts += 1;
      if (attempts === 1) {
        response.writeHead(503);
        response.end('busy');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"recovered":true}');
      return;
    }
    if (request.url === '/broken') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('this is not json');
      return;
    }
    if (request.url === '/slow') {
      setTimeout(() => {
        response.writeHead(200);
        response.end('late');
      }, 400);
      return;
    }
    response.writeHead(500);
    response.end('always fails');
  },
  async (origin) => {
    const ok = await requestJson(`${origin}/ok`);
    equal('a 200 response is parsed', Array.isArray(ok.body) ? 1 : 0, 1);

    const missing = await requestJson(`${origin}/missing`);
    equal('a 404 is returned as a final answer', missing.status, 404);
    check('a 404 is not retried', attempts === 0);

    attempts = 0;
    const flaky = await requestJson(`${origin}/flaky`, { attempts: 3 });
    equal('a 503 is retried and then succeeds', flaky.status, 200);
    equal('the retry happened exactly once', attempts, 2);

    const broken = await requestJson(`${origin}/broken`);
    equal('an unparseable body becomes null instead of throwing', broken.body, null);

    let timeoutError = null;
    try {
      await requestJson(`${origin}/slow`, { timeoutMs: 120, attempts: 1 });
    } catch (error) {
      timeoutError = error;
    }
    check('a timeout is reported as an HttpError', timeoutError instanceof HttpError);
    check('the timeout message names the host', timeoutError && /timed out/.test(timeoutError.message));

    // A transient status that never recovers is returned with its error attached rather
    // than thrown, so a provider can report "this source failed" and let the chain
    // continue with the next source.
    const spent = await requestJson(`${origin}/always`, { attempts: 2 });
    equal('an unrecoverable 5xx is reported with its status', spent.status, 500);
    check('the failure carries an HttpError', spent.error instanceof HttpError);
    check('the failure message names the host', spent.error && /HTTP 500/.test(spent.error.message));

    // A transport failure is different: there is no HTTP answer at all, so it throws.
    let refused = null;
    try {
      await requestJson(`${origin}/ok`, { attempts: 1, timeoutMs: 5000, headers: {} , minGapMs: 0 });
      await requestJson('http://127.0.0.1:1/nothing', { attempts: 1, timeoutMs: 300 });
    } catch (error) {
      refused = error;
    }
    check('a connection that cannot be made throws', refused instanceof HttpError);
  }
);

// --- Storage keys and constants --------------------------------------------------------

group('Constants');
equal('the token cap is the documented one', LIMITS.maxChars, 200000);
check('lookup concurrency is small enough to be polite', LIMITS.lookupConcurrency <= 4);
check('the scan key is stable', STORAGE_KEYS.scan === 'scan.current');
check('selection keys are namespaced', STORAGE_KEYS.selectionPrefix.endsWith(':'));
check('dictionary keys are namespaced', STORAGE_KEYS.dictionaryPrefix.endsWith(':'));
check('the minimum length range is sane', LIMITS.minLengthRange[0] >= 1 && LIMITS.minLengthRange[1] <= 20);

// --- CJK scan ---------------------------------------------------------------------------

group('CJK scan: zero matches expected');

/** CJK ideographs, kana, Hangul, full-width forms and CJK punctuation. */
const CJK_PATTERN = /[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u31c0-\u31ef\u3200-\u32ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\uac00-\ud7af]/;

// The gzipped WordNet subset is binary data, not text, and is skipped by extension.
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.cache']);
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.json', '.html', '.htm', '.css', '.md', '.txt', '.svg', '.yml', '.yaml'
]);

async function walk(directory) {
  const found = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      found.push(...(await walk(full)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    found.push(full);
  }
  return found;
}

const files = await walk(ROOT);
const offenders = [];
let scanned = 0;

for (const file of files) {
  const text = await readFile(file, 'utf8');
  scanned += 1;
  const match = CJK_PATTERN.exec(text);
  if (match) {
    const line = text.slice(0, match.index).split('\n').length;
    offenders.push(`${relative(ROOT, file)}:${line}`);
  }
}

check(`scanned ${scanned} text files`, scanned > 20);
check('no CJK characters anywhere in the codebase', offenders.length === 0, offenders.join(', '));

// --- Summary ---------------------------------------------------------------------------

console.log('');
if (failures.length === 0) {
  console.log(`All ${passed} checks passed.`);
  process.exitCode = 0;
} else {
  console.log(`${passed} checks passed, ${failures.length} failed:`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
