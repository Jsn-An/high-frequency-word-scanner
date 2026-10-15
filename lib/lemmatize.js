/**
 * Rule-based lemmatizer.
 *
 * Design: suffix rules plus an irregular-form map, not a bundled lemma table. A table
 * accurate enough to be useful is several megabytes, which conflicts with the "no
 * build step, small unpacked folder" constraint. The rules cover the regular
 * inflections that dominate real prose (-s, -es, -ies, -ing, -ed) and the irregular map
 * covers the high-frequency irregular verbs, plurals and comparatives.
 *
 * The analysis pipeline calls `lemmaCandidates()` and then prefers the first candidate
 * that also occurs somewhere on the scanned page. That corpus check resolves the
 * genuinely ambiguous stems (including/included -> includ or include) without shipping
 * a lexicon.
 *
 * Known limits, stated honestly in the README and in the results page tooltip:
 *   - Unseen irregulars are not merged (slew does not become slay).
 *   - Comparative and superlative endings are deliberately NOT stripped: stripping
 *     -er turns water into wat, under into und and letter into lett, so the error rate
 *     is worse than the benefit. Genuine cases (better, best, worse) are in the
 *     irregular map instead.
 *   - Adverb -ly is not stripped, for the same reason (only must not become on).
 *   - A stem that never appears as a standalone word on the page can be shown as a
 *     stem rather than as a dictionary headword (a page that only ever says
 *     "changing" can yield "chang").
 *   - Hyphenated compounds, contractions and the possessive-free apostrophe forms are
 *     left untouched.
 */

/**
 * Surface form -> base form, for irregular verbs, irregular plurals and irregular
 * comparatives. Only frequent pairs are listed; adding entries is safe.
 */
const IRREGULAR = new Map(Object.entries({
  // be / have / do
  been: 'be', being: 'be', am: 'be', is: 'be', are: 'be', was: 'be', were: 'be',
  has: 'have', had: 'have', having: 'have',
  does: 'do', did: 'do', done: 'do', doing: 'do',

  // High-frequency irregular verbs
  went: 'go', gone: 'go', goes: 'go',
  said: 'say', says: 'say',
  saw: 'see', seen: 'see',
  came: 'come',
  got: 'get', gotten: 'get',
  gave: 'give', given: 'give',
  took: 'take', taken: 'take',
  made: 'make',
  knew: 'know', known: 'know',
  thought: 'think',
  found: 'find',
  told: 'tell',
  became: 'become',
  left: 'leave',
  felt: 'feel',
  brought: 'bring',
  began: 'begin', begun: 'begin',
  kept: 'keep',
  held: 'hold',
  wrote: 'write', written: 'write',
  stood: 'stand',
  heard: 'hear',
  meant: 'mean', means: 'mean',
  met: 'meet',
  ran: 'run',
  paid: 'pay',
  sat: 'sit',
  spoke: 'speak', spoken: 'speak',
  led: 'lead',
  grew: 'grow', grown: 'grow',
  lost: 'lose',
  fell: 'fall', fallen: 'fall',
  sent: 'send',
  built: 'build',
  understood: 'understand',
  drew: 'draw', drawn: 'draw',
  broke: 'break', broken: 'break',
  spent: 'spend',
  rose: 'rise', risen: 'rise',
  drove: 'drive', driven: 'drive',
  bought: 'buy',
  wore: 'wear', worn: 'wear',
  chose: 'choose', chosen: 'choose',
  sought: 'seek',
  threw: 'throw', thrown: 'throw',
  caught: 'catch',
  dealt: 'deal',
  won: 'win',
  forgot: 'forget', forgotten: 'forget',
  ate: 'eat', eaten: 'eat',
  taught: 'teach',
  slept: 'sleep',
  fought: 'fight',
  flew: 'fly', flown: 'fly', flies: 'fly',
  swam: 'swim', swum: 'swim',
  sang: 'sing', sung: 'sing',
  drank: 'drink', drunk: 'drink',
  struck: 'strike',
  hung: 'hang',
  shook: 'shake', shaken: 'shake',
  stole: 'steal', stolen: 'steal',
  hid: 'hide', hidden: 'hide',
  bit: 'bite', bitten: 'bite',
  blew: 'blow', blown: 'blow',
  froze: 'freeze', frozen: 'freeze',
  rode: 'ride', ridden: 'ride',
  shone: 'shine',
  sank: 'sink', sunk: 'sink',
  swore: 'swear', sworn: 'swear',
  tore: 'tear', torn: 'tear',
  woke: 'wake', woken: 'wake',
  wept: 'weep',
  arose: 'arise', arisen: 'arise',
  shot: 'shoot',
  lent: 'lend',
  bent: 'bend',
  proved: 'prove', proven: 'prove',
  learnt: 'learn',
  spelt: 'spell',
  burnt: 'burn',
  dreamt: 'dream',
  flung: 'fling',
  sprang: 'spring', sprung: 'spring',

  // Irregular plurals
  children: 'child', men: 'man', women: 'woman', feet: 'foot', teeth: 'tooth',
  geese: 'goose', mice: 'mouse', oxen: 'ox', criteria: 'criterion',
  phenomena: 'phenomenon', analyses: 'analysis', indices: 'index',
  matrices: 'matrix', vertices: 'vertex',
  buses: 'bus', gases: 'gas', classes: 'class', passes: 'pass',
  glasses: 'glass', masses: 'mass', presses: 'press',

  // Irregular comparatives and superlatives
  better: 'good', best: 'good', worse: 'bad', worst: 'bad',
  further: 'far', furthest: 'far', farther: 'far', farthest: 'far'
}));

/**
 * Base forms that happen to end in something that looks like an inflection. Without
 * this guard the rules produce lens -> len, morning -> morne, need -> ne and similar
 * damage. Only base forms belong here: listing an inflected form would block its merge.
 */
const KEEP_AS_IS = new Set([
  // Words ending in -s that are not plurals
  'lens', 'bus', 'gas', 'glass', 'class', 'pass', 'mass', 'grass', 'brass', 'press',
  'address', 'business', 'witness', 'process', 'access', 'success', 'boss', 'loss',
  'less', 'unless', 'across', 'cross', 'dress', 'purpose', 'else', 'yes', 'plus',
  'minus', 'focus', 'bonus', 'campus', 'virus', 'status', 'news', 'series',
  'species', 'analysis', 'basis', 'crisis', 'thesis', 'axis', 'always', 'perhaps',
  'otherwise', 'sometimes', 'this', 'his', 'its', 'was', 'has', 'as',

  // Words ending in -ing that are not verbs
  'morning', 'evening', 'during', 'thing', 'something', 'nothing', 'anything',
  'everything', 'spring', 'string', 'ring', 'wing', 'king', 'sing', 'sting',
  'swing', 'bring', 'cling', 'fling', 'long', 'belong', 'among', 'young',
  'wedding', 'ceiling', 'darling', 'pudding', 'housing', 'nothing',

  // Words ending in -ed that are not past tense
  'need', 'feed', 'seed', 'speed', 'weed', 'breed', 'greed', 'indeed', 'red', 'bed',
  'shed', 'wed', 'hundred', 'sacred', 'embed', 'proceed', 'exceed', 'succeed',

  // Words ending in -ies that are not plurals
  'movies', 'cookies', 'calories', 'ties', 'pies', 'lies', 'dies', 'fries',
  'selfies', 'zombies', 'brownies', 'smoothies', 'goodies', 'hippies', 'genies'
]);

const MIN_BASE_LENGTH = 3;
const VOWELS = 'aeiou';

/** True when the character is a vowel in the Porter sense ('y' after a consonant). */
function isVowelAt(word, index) {
  const character = word[index];
  if (VOWELS.includes(character)) return true;
  if (character === 'y') {
    if (index === 0) return false;
    return !'aeiouy'.includes(word[index - 1]);
  }
  return false;
}

/** Porter's measure: the number of vowel-consonant sequences in the stem. */
function measure(word) {
  let count = 0;
  for (let index = 0; index < word.length - 1; index += 1) {
    if (isVowelAt(word, index) && !isVowelAt(word, index + 1)) count += 1;
  }
  return count;
}

/** True when the stem ends with consonant-vowel-consonant (make, hope, write). */
function endsWithCvc(stem) {
  const length = stem.length;
  if (length < 3) return false;
  const first = stem[length - 3];
  const middle = stem[length - 2];
  const last = stem[length - 1];
  if (VOWELS.includes(middle) && !VOWELS.includes(first) && !VOWELS.includes(last)) {
    return !'wxy'.includes(last);
  }
  return false;
}

/**
 * Candidate base forms for a stem produced by stripping -ing or -ed, best guess first.
 *
 * Order of confidence:
 *   1. undo a doubled final consonant (running -> runn -> run)
 *   2. restore a silent e after v, u or c, endings that cannot stand at the end of an
 *      English verb (receiv -> receive, argu -> argue, produc -> produce)
 *   3. restore a silent e for the known endings at, bl, iz (conflat, troubl, siz)
 *   4. restore a silent e for one-syllable consonant-vowel-consonant stems
 *      (mak -> make, hop -> hope, writ -> write)
 *   5. the raw stem, which is correct surprisingly often (walk, visit, offer)
 */
function stemCandidates(stem) {
  const candidates = [];
  const push = (candidate) => {
    if (candidate && candidate.length >= MIN_BASE_LENGTH && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  if (/([bdfglmnprt])\1$/.test(stem)) push(stem.slice(0, -1));
  if (/[vuc]$/.test(stem)) push(`${stem}e`);
  if (/(?:at|bl|iz)$/.test(stem)) push(`${stem}e`);
  if (measure(stem) === 1 && endsWithCvc(stem)) push(`${stem}e`);
  push(stem);

  return candidates.length ? candidates : [stem];
}

/**
 * All plausible base forms of a word, best guess first. The first entry is what
 * `lemmatize()` returns. The caller may prefer a later entry when it also occurs in
 * the scanned text.
 *
 * @param {string} input Lowercased token.
 * @returns {string[]} Candidate base forms, always at least one entry.
 */
export function lemmaCandidates(input) {
  if (typeof input !== 'string' || !input) return [];

  const word = input.trim().toLowerCase();
  if (word.length < MIN_BASE_LENGTH) return [word];

  // Hyphenated compounds and contractions are left alone: a rule applied to the whole
  // token would mangle it, and applying rules to the last segment would need a lexicon
  // to know which segment is the head.
  if (word.includes('-') || word.includes("'")) return [word];

  const irregular = IRREGULAR.get(word);
  if (irregular) return [irregular];
  if (KEEP_AS_IS.has(word)) return [word];

  // studies -> study, batteries -> battery
  if (word.length > 4 && word.endsWith('ies')) return [`${word.slice(0, -3)}y`];

  // addresses -> address, watches -> watch, boxes -> box, dishes -> dish
  if (word.length > 4 && /(?:sses|shes|ches|xes|zes)$/.test(word)) {
    return [word.slice(0, -2)];
  }

  // goes -> go, echoes -> echo, tomatoes -> tomato
  if (word.length > 4 && word.endsWith('oes')) return [word.slice(0, -2)];

  // books -> book. The guard keeps class, status, analysis, famous and atlas intact.
  if (word.length > 3 && word.endsWith('s') && !/(?:ss|us|is|ous|as|os)$/.test(word)) {
    return [word.slice(0, -1)];
  }

  // agreed -> agree, freed -> free (need, seed, speed and friends are protected)
  if (word.length > 4 && word.endsWith('eed')) return [word.slice(0, -1)];

  // studied -> study, tried -> try
  if (word.length > 4 && word.endsWith('ied')) return [`${word.slice(0, -3)}y`];

  if (word.length > 4 && word.endsWith('ing')) return stemCandidates(word.slice(0, -3));
  if (word.length > 3 && word.endsWith('ed')) return stemCandidates(word.slice(0, -2));

  return [word];
}

/**
 * The single best base form for a word.
 *
 * @param {string} input Lowercased token.
 * @returns {string} The base form, or the input when no rule applies.
 */
export function lemmatize(input) {
  const candidates = lemmaCandidates(input);
  return candidates.length ? candidates[0] : input;
}

/** Exposed for the self test so the guard tables stay in one place. */
export const LEMMATIZER_TABLES = Object.freeze({ IRREGULAR, KEEP_AS_IS });
