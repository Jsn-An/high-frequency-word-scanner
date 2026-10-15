/**
 * Built-in English stop word list.
 *
 * Provenance: authored inside this repository from the standard inventory of English
 * function words (articles, determiners, pronouns, prepositions, conjunctions,
 * auxiliaries, degree adverbs and common contractions). It is not copied from a
 * third-party package, so there is nothing to attribute and no license to carry.
 *
 * Why this list is bigger than the classic 100-word lists: the filter runs on the
 * surface form *and* on the lemma, so it needs the inflected auxiliaries too
 * (is / was / been / does / doing). Word frequency ranking of a news article or a
 * README improves noticeably with the contractions included.
 *
 * The filter is a toggle in the results page UI and defaults to on.
 */

const STOP_WORD_LIST = [
  // Articles, determiners, quantifiers
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'each', 'every', 'either',
  'neither', 'some', 'any', 'no', 'all', 'both', 'half', 'such', 'another', 'other',
  'others', 'same', 'own', 'much', 'many', 'more', 'most', 'less', 'least', 'few',
  'fewer', 'several', 'enough', 'certain', 'various', 'one', 'ones', 'lots', 'plenty',

  // Personal and reflexive pronouns
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'hers', 'ours',
  'theirs', 'myself', 'yourself', 'himself', 'herself', 'itself', 'ourselves',
  'yourselves', 'themselves', 'who', 'whom', 'whose', 'which', 'what', 'when',
  'where', 'why', 'how', 'whoever', 'whomever', 'whatever', 'whenever', 'wherever',
  'however', 'someone', 'somebody', 'something', 'anyone', 'anybody', 'anything',
  'everyone', 'everybody', 'everything', 'none', 'nobody', 'nothing', 'whoever',

  // Prepositions and particles
  'about', 'above', 'across', 'after', 'against', 'along', 'amid', 'amidst', 'among',
  'amongst', 'around', 'as', 'at', 'before', 'behind', 'below', 'beneath', 'beside',
  'besides', 'between', 'beyond', 'by', 'despite', 'down', 'during', 'except', 'for',
  'from', 'in', 'inside', 'into', 'like', 'near', 'of', 'off', 'on', 'onto', 'out',
  'outside', 'over', 'past', 'per', 'since', 'than', 'through', 'throughout', 'till',
  'to', 'toward', 'towards', 'under', 'underneath', 'until', 'up', 'upon', 'via',
  'with', 'within', 'without', 'versus', 'vs', 'unto', 'atop',

  // Conjunctions, linking and discourse adverbs
  'and', 'but', 'or', 'nor', 'so', 'yet', 'because', 'although', 'though', 'while',
  'whereas', 'if', 'unless', 'whether', 'plus', 'hence', 'therefore', 'thus',
  'moreover', 'furthermore', 'nevertheless', 'nonetheless', 'otherwise', 'instead',
  'meanwhile', 'also', 'then', 'too', 'very', 'just', 'even', 'still', 'already',
  'always', 'never', 'often', 'sometimes', 'usually', 'rarely', 'again', 'ever',
  'only', 'quite', 'rather', 'almost', 'indeed', 'perhaps', 'maybe', 'probably',
  'actually', 'really', 'simply', 'merely', 'anyway', 'anyhow', 'somewhat',
  'somehow', 'somewhere', 'anywhere', 'everywhere', 'nowhere', 'namely', 'eg', 'ie',
  'etc', 'ok', 'okay', 'well', 'oh', 'yes', 'not', 'onto', 'etcetera',

  // Auxiliaries, modals, forms of be / have / do
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'having', 'do', 'does', 'did', 'doing', 'done', 'will', 'would', 'shall', 'should',
  'can', 'could', 'may', 'might', 'must', 'ought', 'need', 'dare', 'let', 'lets',

  // Common contractions
  "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't", "hasn't",
  "haven't", "hadn't", "can't", 'cannot', "couldn't", "won't", "wouldn't",
  "shouldn't", "mustn't", "it's", "that's", "there's", "here's", "he's", "she's",
  "what's", "let's", "i'm", "i've", "i'll", "i'd", "you're", "you've", "you'll",
  "you'd", "we're", "we've", "we'll", "we'd", "they're", "they've", "they'll",
  "they'd", "who's", "ain't", 'gonna', 'wanna', 'gotta', "y'all",

  // Very common but information-poor verbs and nouns
  'said', 'says', 'get', 'gets', 'getting', 'go', 'goes', 'going', 'come', 'comes',
  'coming', 'take', 'takes', 'taking', 'make', 'makes', 'making', 'see', 'sees',
  'seeing', 'know', 'knows', 'knowing', 'think', 'thinks', 'thinking', 'thing',
  'things', 'time', 'times', 'way', 'ways', 'day', 'days', 'year', 'years', 'people',
  'part', 'parts', 'lot', 'lots', 'kind', 'kinds', 'sort', 'sorts', 'back', 'here',
  'there', 'where', 'now', 'today', 'first', 'second', 'next', 'last'
];

/** Set-backed lookup used by the analysis pipeline. */
export const STOP_WORDS = new Set(STOP_WORD_LIST);

/**
 * Words whose trailing "'s" is a contraction of "is" or "has", not a possessive.
 * They are kept intact instead of being folded onto the base word, so "it's" does
 * not silently become "it".
 */
export const S_CONTRACTION_KEEP = new Set([
  "it's", "that's", "there's", "here's", "he's", "she's", "what's", "let's", "who's",
  "where's", "when's", "why's", "how's", "one's", "everyone's", "everybody's",
  "someone's", "somebody's", "nobody's", "nothing's", "anything's", "something's",
  "that'll", "there'll", "it'll", "he'll", "she'll", "they'll", "we'll", "you'll"
]);

/** True when the word is filtered out by the stop word list. */
export function isStopWord(word) {
  return STOP_WORDS.has(word);
}
