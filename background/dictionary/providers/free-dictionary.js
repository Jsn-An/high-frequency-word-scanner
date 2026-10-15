/**
 * Provider 1: Free Dictionary API (api.dictionaryapi.dev).
 *
 * Priority: primary source. It is the only free English dictionary endpoint that returns
 * phonetics with audio, examples, synonyms and antonyms in one response, with no key and
 * no signup.
 *
 * Verified response shape (live request for "example"):
 *
 *   [ { word, phonetic,
 *       phonetics: [ { text, audio, sourceUrl } ],
 *       meanings: [ { partOfSpeech,
 *                     definitions: [ { definition, synonyms, antonyms, example? } ],
 *                     synonyms, antonyms } ],
 *       license: { name, url },
 *       sourceUrls: [ ... ] } ]
 *
 * Notes that the normalizer below depends on:
 *   - The response is an array. Homographs produce several entries, all for the same
 *     spelling, so meanings are merged across entries instead of only reading [0].
 *   - `example` is optional on a definition and is often absent.
 *   - Unknown words return HTTP 404. That is a miss, not an error: the orchestrator then
 *     tries the next provider.
 *   - The service is community run, so 5xx responses do occur. They are retried by the
 *     HTTP helper and, if they persist, reported as an error for this provider while the
 *     chain continues with the next one.
 */

import { requestJson } from '../http.js';
import { makeDefinition, makeEntry } from '../shared.js';

export const id = 'free-dictionary';
export const label = 'Free Dictionary API';
export const attribution =
  'Served by the Free Dictionary API, whose content comes from Wiktionary (CC BY-SA 3.0).';

const ENDPOINT = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

/**
 * @param {string} word Lowercased single word.
 * @param {{timeoutMs?: number, attempts?: number}} [budget] Slice of the lookup budget
 *   granted to this provider. See background/dictionary/lookup.js.
 * @returns {Promise<Object|null>} Normalized entry, or null when this source has no entry.
 * @throws {Error} When the request failed for a transient reason after retries.
 */
export async function lookup(word, budget = {}) {
  const result = await requestJson(`${ENDPOINT}${encodeURIComponent(word)}`, {
    headers: { Accept: 'application/json' },
    timeoutMs: budget.timeoutMs,
    attempts: budget.attempts ?? 2,
    minGapMs: 80
  });

  if (result.status === 404) return null;
  if (result.status !== 200) {
    const detail = result.error ? result.error.message : `HTTP ${result.status}`;
    throw new Error(`${label}: ${detail}`);
  }
  if (!Array.isArray(result.body) || result.body.length === 0) return null;

  return normalize(word, result.body);
}

/**
 * Maps the documented response onto the normalized shape.
 *
 * Exported so the self test can exercise it with a fixture instead of the network.
 *
 * @param {string} word
 * @param {Object[]} entries
 */
export function normalize(word, entries) {
  let phonetic = null;
  let audioUrl = null;
  let sourceUrl = '';
  let license = '';
  const meanings = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    if (!phonetic && typeof entry.phonetic === 'string') {
      phonetic = entry.phonetic;
    }

    if (Array.isArray(entry.phonetics)) {
      for (const candidate of entry.phonetics) {
        if (!candidate || typeof candidate !== 'object') continue;
        if (!phonetic && typeof candidate.text === 'string' && candidate.text.trim()) {
          phonetic = candidate.text;
        }
        if (!audioUrl && typeof candidate.audio === 'string' && candidate.audio.trim()) {
          audioUrl = candidate.audio;
        }
      }
    }

    if (!sourceUrl && Array.isArray(entry.sourceUrls) && entry.sourceUrls.length > 0) {
      sourceUrl = String(entry.sourceUrls[0]);
    }
    if (!license && entry.license && typeof entry.license.name === 'string') {
      license = entry.license.name;
    }

    if (!Array.isArray(entry.meanings)) continue;
    for (const meaning of entry.meanings) {
      if (!meaning || typeof meaning !== 'object' || !Array.isArray(meaning.definitions)) continue;
      const definitions = [];
      for (const raw of meaning.definitions) {
        if (!raw || typeof raw !== 'object') continue;
        const definition = makeDefinition(raw.definition, raw.example);
        if (definition) definitions.push(definition);
      }
      if (definitions.length > 0) {
        meanings.push({ partOfSpeech: meaning.partOfSpeech, definitions });
      }
    }
  }

  return makeEntry({
    word,
    phonetic,
    audioUrl,
    source: label,
    meanings,
    sourceUrl: sourceUrl || 'https://dictionaryapi.dev/',
    license: license || 'CC BY-SA 3.0',
    attribution
  });
}
