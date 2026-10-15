/**
 * Frequency analysis: raw token list -> ranked word records.
 *
 * The content script tokenizes but deliberately does not filter, count or lemmatize.
 * Everything in this module runs on the results page, which means the three analysis
 * toggles can be re-applied instantly without touching the page again.
 */

import { DEFAULT_SETTINGS, LIMITS } from './constants.js';
import { lemmaCandidates } from './lemmatize.js';
import { STOP_WORDS } from './stopwords.js';

/**
 * @typedef {Object} WordRecord
 * @property {string} word            Displayed word, after optional lemmatization.
 * @property {number} count           Number of occurrences that survived the filters.
 * @property {number} capitalizedCount Occurrences that started with an uppercase letter
 *                                     and were not at the start of a sentence.
 * @property {number} capitalizedRatio capitalizedCount / count.
 * @property {number} firstIndex      Index of the first occurrence in the token list.
 * @property {number|null} firstOccurrence  Character offset of the first occurrence in
 *                                     the reconstructed page text.
 * @property {string[]} variants      Up to 8 distinct surface forms seen on the page.
 */

/**
 * @typedef {Object} AnalysisResult
 * @property {WordRecord[]} records   Sorted by frequency descending, then alphabetically.
 * @property {Object} stats
 */

/** Clamps and completes a settings object. Shared with the UI so bounds live in one place. */
export function normalizeSettings(input = {}) {
  const [min, max] = LIMITS.minLengthRange;
  const minLength = Number(input.minLength);
  return {
    lemmatize: input.lemmatize ?? DEFAULT_SETTINGS.lemmatize,
    stopWords: input.stopWords ?? DEFAULT_SETTINGS.stopWords,
    minLength: Number.isFinite(minLength)
      ? Math.min(max, Math.max(min, Math.round(minLength)))
      : DEFAULT_SETTINGS.minLength,
    excludeCode: input.excludeCode ?? DEFAULT_SETTINGS.excludeCode,
    excludeBoilerplate: input.excludeBoilerplate ?? DEFAULT_SETTINGS.excludeBoilerplate,
    sort: input.sort === 'alpha' ? 'alpha' : DEFAULT_SETTINGS.sort
  };
}

/**
 * Picks the base form of a token, preferring a candidate that also occurs somewhere on
 * the scanned page. This is the corpus check that resolves stems such as `includ` vs
 * `include` without bundling a lexicon.
 */
function resolveLemma(surface, corpus) {
  const candidates = lemmaCandidates(surface);
  if (candidates.length <= 1) return candidates[0] || surface;
  for (const candidate of candidates) {
    if (corpus.has(candidate)) return candidate;
  }
  return candidates[0];
}

/** Alphabetical comparison for word records. */
function compareWords(a, b) {
  return a.word.localeCompare(b.word, 'en');
}

/** Frequency descending, then alphabetically for ties. */
export function compareByFrequency(a, b) {
  return b.count - a.count || compareWords(a, b);
}

/** Sorts records in place according to the requested mode and returns them. */
export function sortRecords(records, mode) {
  if (mode === 'alpha') records.sort(compareWords);
  else records.sort(compareByFrequency);
  return records;
}

/**
 * Runs the analysis pipeline over a scan payload.
 *
 * @param {{tokens?: string[], caps?: string, offsets?: number[]}} payload Scan payload
 *   produced by the content script. `caps[i]` is '1' when token i was capitalized
 *   mid-sentence.
 * @param {Object} [settingsInput] Analysis toggles.
 * @returns {AnalysisResult}
 */
export function analyze(payload, settingsInput = {}) {
  const settings = normalizeSettings(settingsInput);
  const tokens = Array.isArray(payload?.tokens) ? payload.tokens : [];
  const caps = typeof payload?.caps === 'string' ? payload.caps : '';
  const offsets = Array.isArray(payload?.offsets) ? payload.offsets : [];

  // Pass one: every distinct surface form on the page, used to resolve ambiguous stems.
  const corpus = new Set(tokens);

  const byBase = new Map();
  let droppedShort = 0;
  let droppedStopWords = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const surface = tokens[index];
    if (typeof surface !== 'string' || !surface) continue;

    if (surface.length < settings.minLength) {
      droppedShort += 1;
      continue;
    }

    const base = settings.lemmatize ? resolveLemma(surface, corpus) : surface;

    if (settings.stopWords && (STOP_WORDS.has(surface) || STOP_WORDS.has(base))) {
      droppedStopWords += 1;
      continue;
    }

    let record = byBase.get(base);
    if (!record) {
      record = {
        word: base,
        count: 0,
        capitalizedCount: 0,
        capitalizedRatio: 0,
        firstIndex: index,
        firstOccurrence: Number.isFinite(offsets[index]) ? offsets[index] : null,
        variants: []
      };
      byBase.set(base, record);
    }

    record.count += 1;
    if (caps[index] === '1') record.capitalizedCount += 1;
    if (record.variants.length < 8 && !record.variants.includes(surface)) {
      record.variants.push(surface);
    }
  }

  const records = [];
  for (const record of byBase.values()) {
    record.capitalizedRatio = record.count > 0 ? record.capitalizedCount / record.count : 0;
    records.push(record);
  }

  sortRecords(records, settings.sort);

  const countedTokens = records.reduce((total, record) => total + record.count, 0);

  return {
    settings,
    records,
    stats: {
      totalTokens: tokens.length,
      countedTokens,
      uniqueWords: records.length,
      distinctSurfaceForms: corpus.size,
      droppedShort,
      droppedStopWords
    }
  };
}

/**
 * Filters records for the search box.
 *
 * Prefix matches are listed before other substring matches, both groups keeping the
 * active sort order. That is the behaviour people expect from a word list: typing
 * "res" should surface "result" before "interest".
 *
 * @param {WordRecord[]} records
 * @param {string} query
 * @returns {WordRecord[]}
 */
export function filterRecords(records, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return records.slice();

  const prefixMatches = [];
  const substringMatches = [];

  for (const record of records) {
    const position = record.word.toLowerCase().indexOf(needle);
    if (position === 0) prefixMatches.push(record);
    else if (position > 0) substringMatches.push(record);
  }

  return prefixMatches.concat(substringMatches);
}
