/**
 * Helpers shared by the dictionary providers.
 *
 * Every provider ends up producing the same normalized entry, so the text cleanup, the
 * part-of-speech merge and the size caps live here instead of being repeated four times:
 *
 *   {
 *     word: string,
 *     phonetic: string | null,
 *     audioUrl: string | null,
 *     source: string,
 *     meanings: [ { partOfSpeech: string, definitions: [ { definition: string, example: string | null } ] } ],
 *     // optional extras, used for attribution and for the UI source line:
 *     sourceUrl?: string,
 *     license?: string,
 *     attribution?: string
 *   }
 *
 * The UI never reads a raw API response, only this shape.
 */

/** Maximum part-of-speech groups kept per word. */
export const MAX_MEANINGS = 8;

/** Maximum definitions kept per part of speech. */
export const MAX_DEFINITIONS_PER_MEANING = 8;

/** Maximum length of a normalized definition or example sentence. */
export const MAX_TEXT_LENGTH = 600;

const ENTITIES = Object.freeze({
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ndash;': '-',
  '&mdash;': '-',
  '&hellip;': '...',
  '&rsquo;': "'",
  '&lsquo;': "'",
  '&ldquo;': '"',
  '&rdquo;': '"'
});

/**
 * Turns source text into a single clean line.
 *
 * Markup is stripped rather than escaped because the extension never renders HTML: a
 * definition like `a <a href="...">vessel</a>` would otherwise be displayed with its
 * tags. Wiki link syntax is unwrapped too, because the Wiktionary-derived sources
 * occasionally pass `[[target|label]]` through. Whitespace is collapsed so a definition is
 * always one line in the UI and in the exported Markdown.
 *
 * @param {unknown} value Raw string from a provider.
 * @returns {string} Cleaned text, possibly empty.
 */
export function cleanText(value) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/<[^>]*>/g, ' ');
  // [[target|label]] -> label, [[target]] -> target, then any remaining template.
  text = text.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1');
  text = text.replace(/\[\[([^\]]*)\]\]/g, '$1');
  text = text.replace(/\{\{[^}]*\}\}/g, ' ');
  text = text.replace(/&[a-z#0-9]+;/gi, (match) => ENTITIES[match.toLowerCase()] ?? match);
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_TEXT_LENGTH) {
    text = `${text.slice(0, MAX_TEXT_LENGTH - 3).trimEnd()}...`;
  }
  return text;
}

/** Keeps only http(s) audio URLs. */
export function sanitizeAudioUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/** Normalizes a part-of-speech label to lower case, defaulting to "unknown". */
export function normalizePartOfSpeech(value) {
  const text = cleanText(value).toLowerCase();
  return text || 'unknown';
}

/**
 * Builds a definition object, returning null when there is no usable definition text.
 *
 * @param {unknown} definition
 * @param {unknown} example
 * @returns {{definition: string, example: string|null}|null}
 */
export function makeDefinition(definition, example) {
  const text = cleanText(definition);
  if (!text) return null;
  const exampleText = cleanText(example);
  return { definition: text, example: exampleText || null };
}

/**
 * Merges meaning groups with the same part of speech, removes duplicate definitions and
 * applies the size caps.
 *
 * @param {Array<{partOfSpeech: string, definitions: Array<{definition: string, example: string|null}>}>} meanings
 * @returns {Array<{partOfSpeech: string, definitions: Array<{definition: string, example: string|null}>}>}
 */
export function finalizeMeanings(meanings) {
  const byPartOfSpeech = new Map();

  for (const meaning of meanings) {
    if (!meaning || !Array.isArray(meaning.definitions) || meaning.definitions.length === 0) continue;
    const key = normalizePartOfSpeech(meaning.partOfSpeech);
    if (!byPartOfSpeech.has(key)) {
      byPartOfSpeech.set(key, { partOfSpeech: key, definitions: [], seen: new Set() });
    }
    const group = byPartOfSpeech.get(key);
    for (const definition of meaning.definitions) {
      if (!definition || !definition.definition) continue;
      const fingerprint = definition.definition.toLowerCase();
      if (group.seen.has(fingerprint)) continue;
      group.seen.add(fingerprint);
      if (group.definitions.length >= MAX_DEFINITIONS_PER_MEANING) continue;
      group.definitions.push(definition);
    }
  }

  return Array.from(byPartOfSpeech.values())
    .filter((group) => group.definitions.length > 0)
    .slice(0, MAX_MEANINGS)
    .map((group) => ({ partOfSpeech: group.partOfSpeech, definitions: group.definitions }));
}

/**
 * Assembles the normalized entry. Returns null when there is nothing to show, which the
 * providers treat as "this source has no entry for the word" and the orchestrator then
 * treats as a miss.
 */
export function makeEntry({ word, phonetic, audioUrl, source, meanings, sourceUrl, license, attribution }) {
  const finalized = finalizeMeanings(meanings || []);
  if (finalized.length === 0) return null;

  return {
    word: String(word || '').toLowerCase(),
    phonetic: cleanText(phonetic) || null,
    audioUrl: sanitizeAudioUrl(audioUrl),
    source,
    meanings: finalized,
    sourceUrl: sourceUrl || '',
    license: license || '',
    attribution: attribution || ''
  };
}
