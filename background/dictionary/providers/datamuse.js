/**
 * Provider 3: Datamuse (api.datamuse.com).
 *
 * Priority: gap filler, not a primary definition source. Datamuse is a word-finding
 * engine backed by WordNet, so it returns glosses and a pronunciation hint but never
 * example sentences, which is exactly why it sits behind the two real dictionaries.
 *
 * Verified response shape (live request for "example" with md=dpr):
 *
 *   [ { word: "example", score: 149077,
 *       tags: [ "n", "v", "pron:IH0 G Z AE1 M P AH0 L " ],
 *       defs: [ "n\tSomething that is representative of all such things in a group. ",
 *               "v\tTo be illustrated or exemplified (by). " ] } ]
 *
 * Notes that the normalizer depends on:
 *   - `defs` entries start with a part-of-speech letter followed by a tab character.
 *     WordNet uses n (noun), v (verb), a and s (adjective and adjective satellite) and
 *     r (adverb); Datamuse also documents u for unknown.
 *   - The pronunciation hint arrives as a `pron:` entry inside `tags`, in ARPAbet with
 *     stress digits (CMUdict style), not in IPA. It is put in the `phonetic` field only
 *     when the field would otherwise be empty, and the detail panel labels it as the
 *     ARPAbet hint it is, so nobody mistakes it for IPA.
 *   - `sp=` with `max=1` is a spelling match, not an exact-word guarantee, so the reply is
 *     checked against the requested spelling before it is used.
 */

import { requestJson } from '../http.js';
import { cleanText, makeDefinition, makeEntry } from '../shared.js';

export const id = 'datamuse';
export const label = 'Datamuse (WordNet glosses)';
export const attribution =
  'Datamuse glosses come from WordNet 3.0, distributed by Princeton University under a permissive licence.';

const ENDPOINT = 'https://api.datamuse.com/words';

/** WordNet part-of-speech letters, as used in the `defs` field. */
const PART_OF_SPEECH = Object.freeze({
  n: 'noun',
  v: 'verb',
  a: 'adjective',
  s: 'adjective',
  r: 'adverb',
  u: 'unknown'
});

/**
 * @param {string} word Lowercased single word.
 * @param {{timeoutMs?: number, attempts?: number}} [budget] Slice of the lookup budget
 *   granted to this provider. See background/dictionary/lookup.js.
 * @returns {Promise<Object|null>} Normalized entry, or null when this source has no entry.
 * @throws {Error} When the request failed for a transient reason after retries.
 */
export async function lookup(word, budget = {}) {
  const url = `${ENDPOINT}?sp=${encodeURIComponent(word)}&md=dpr&max=1`;
  const result = await requestJson(url, {
    headers: { Accept: 'application/json' },
    timeoutMs: budget.timeoutMs,
    attempts: budget.attempts ?? 2,
    minGapMs: 80
  });

  if (result.status !== 200) {
    const detail = result.error ? result.error.message : `HTTP ${result.status}`;
    throw new Error(`${label}: ${detail}`);
  }
  if (!Array.isArray(result.body) || result.body.length === 0) return null;

  const match = result.body.find(
    (candidate) => candidate && String(candidate.word || '').toLowerCase() === word
  );
  if (!match) return null;

  return normalize(word, match);
}

/**
 * Maps the documented response onto the normalized shape.
 *
 * Exported so the self test can exercise it with a fixture instead of the network.
 *
 * @param {string} word
 * @param {Object} match One entry of the Datamuse reply.
 */
export function normalize(word, match) {
  const meanings = [];
  const definitionsByPartOfSpeech = new Map();

  for (const raw of Array.isArray(match.defs) ? match.defs : []) {
    if (typeof raw !== 'string') continue;
    const separator = raw.indexOf('\t');
    if (separator <= 0) continue;
    const key = raw.slice(0, separator).trim().toLowerCase();
    const partOfSpeech = PART_OF_SPEECH[key] || 'unknown';
    if (!definitionsByPartOfSpeech.has(partOfSpeech)) {
      definitionsByPartOfSpeech.set(partOfSpeech, []);
    }
    const definition = makeDefinition(raw.slice(separator + 1), null);
    if (definition) definitionsByPartOfSpeech.get(partOfSpeech).push(definition);
  }

  for (const [partOfSpeech, definitions] of definitionsByPartOfSpeech) {
    if (definitions.length > 0) meanings.push({ partOfSpeech, definitions });
  }

  let pronunciationHint = null;
  for (const tag of Array.isArray(match.tags) ? match.tags : []) {
    if (typeof tag !== 'string') continue;
    if (tag.toLowerCase().startsWith('pron:')) {
      pronunciationHint = cleanText(tag.slice(5));
      break;
    }
  }

  return makeEntry({
    word,
    phonetic: pronunciationHint,
    audioUrl: null,
    source: label,
    meanings,
    sourceUrl: `https://www.datamuse.com/api/`,
    license: 'WordNet 3.0 licence (permissive)',
    attribution
  });
}
