/**
 * Provider 2: Wiktionary REST API (en.wiktionary.org).
 *
 * Priority: fallback. It covers a large number of inflected and technical words that the
 * primary source may not have, and it is the reason the extension attributes content
 * under CC BY-SA 3.0 in the UI and in exported files.
 *
 * Response shape of GET /api/rest_v1/page/definition/<word> as documented by Wikimedia
 * (the live endpoint could not be sampled from the development environment, because
 * Wikimedia refuses requests that are not from a browser, so the normalizer accepts every
 * field variant that the documented shape allows and ignores everything it does not
 * recognize):
 *
 *   {
 *     "en": [
 *       { partOfSpeech: "Noun",
 *         language: "English",
 *         definitions: [
 *           { definition: "...",
 *             parsedExamples: [ { example: "...", ref: "..." } ],
 *             examples: [ "..." ],          // older replies only
 *             language: "English" } ] } ],
 *     "fr": [ ... ]                          // other languages, ignored
 *   }
 *
 * Defensive decisions:
 *   - Only the `en` key is read, and only groups whose `language` is English. A page for
 *     a word that exists in English returns other languages too.
 *   - Every string is passed through cleanText(), which strips wiki markup that arrives
 *     as HTML (links and language spans).
 *   - Examples are read from `parsedExamples[].example` first and from `examples[]`,
 *     which is a plain array of strings, second.
 *   - A 404 means "no page for this spelling", which is a miss.
 *   - Wikimedia asks for an identifying client. `User-Agent` cannot be set from fetch()
 *     in a worker, so the documented `Api-User-Agent` header is sent instead. See the
 *     README for the full explanation and for the declarativeNetRequest alternative.
 */

import { WIKIMEDIA_API_USER_AGENT } from '../../../lib/constants.js';
import { requestJson } from '../http.js';
import { cleanText, makeDefinition, makeEntry } from '../shared.js';

export const id = 'wiktionary';
export const label = 'Wiktionary';
export const attribution =
  'Wiktionary content is available under CC BY-SA 3.0. Attribution: Wiktionary contributors.';

const ENDPOINT = 'https://en.wiktionary.org/api/rest_v1/page/definition/';

/**
 * @param {string} word Lowercased single word.
 * @param {{timeoutMs?: number, attempts?: number}} [budget] Slice of the lookup budget
 *   granted to this provider. See background/dictionary/lookup.js.
 * @returns {Promise<Object|null>} Normalized entry, or null when this source has no entry.
 * @throws {Error} When the request failed for a transient reason after retries.
 */
export async function lookup(word, budget = {}) {
  const result = await requestJson(`${ENDPOINT}${encodeURIComponent(word)}`, {
    // Wikimedia asks for a descriptive client identifier. Spacing requests avoids the
    // per-IP rate limit that applies to anonymous traffic.
    headers: {
      Accept: 'application/json',
      'Api-User-Agent': WIKIMEDIA_API_USER_AGENT
    },
    timeoutMs: budget.timeoutMs,
    attempts: budget.attempts ?? 2,
    minGapMs: 220
  });

  if (result.status === 404) return null;
  if (result.status !== 200) {
    const detail = result.error ? result.error.message : `HTTP ${result.status}`;
    throw new Error(`${label}: ${detail}`);
  }
  if (!result.body || typeof result.body !== 'object') return null;

  return normalize(word, result.body);
}

/** Picks the first non-empty example from the documented variants. */
function readExample(definition) {
  if (!definition || typeof definition !== 'object') return null;

  if (Array.isArray(definition.parsedExamples)) {
    for (const candidate of definition.parsedExamples) {
      const text =
        typeof candidate === 'string'
          ? candidate
          : candidate && typeof candidate.example === 'string'
            ? candidate.example
            : '';
      const cleaned = cleanText(text);
      if (cleaned) return cleaned;
    }
  }

  if (Array.isArray(definition.examples)) {
    for (const candidate of definition.examples) {
      const cleaned = cleanText(candidate);
      if (cleaned) return cleaned;
    }
  }

  return null;
}

/**
 * Maps the documented response onto the normalized shape.
 *
 * Exported so the self test can exercise it with a fixture instead of the network.
 *
 * @param {string} word
 * @param {Object} body
 */
export function normalize(word, body) {
  const groups = Array.isArray(body.en) ? body.en : [];
  const meanings = [];

  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;

    // Skip groups that explicitly describe another language.
    if (typeof group.language === 'string' && group.language.toLowerCase() !== 'english') {
      continue;
    }

    if (!Array.isArray(group.definitions)) continue;
    const definitions = [];
    for (const raw of group.definitions) {
      if (!raw || typeof raw !== 'object') continue;
      const definition = makeDefinition(raw.definition, readExample(raw));
      if (definition) definitions.push(definition);
    }
    if (definitions.length > 0) {
      meanings.push({ partOfSpeech: group.partOfSpeech, definitions });
    }
  }

  return makeEntry({
    word,
    // The definition endpoint does not return IPA or audio. Leaving these null is
    // correct: the detail panel states which source a field came from.
    phonetic: null,
    audioUrl: null,
    source: label,
    meanings,
    sourceUrl: `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`,
    license: 'CC BY-SA 3.0',
    attribution
  });
}
