/**
 * Builds the optional offline WordNet subset that provider 4 reads.
 *
 * This is a development script. It is not part of the extension, it is not referenced by
 * manifest.json, and the extension works without it. Run it only if you want the offline
 * layer:
 *
 *   node tools/build-wordnet-subset.mjs
 *
 * What it does, step by step:
 *   1. Downloads the official WordNet 3.0 database tarball from Princeton
 *      (https://wordnetcode.princeton.edu/3.0/WNdb-3.0.tar.gz, about 10.5 MB, unchanged
 *      since 2007) into the system temporary directory and caches it there.
 *   2. Reads the four synset data files out of the tarball. Tar parsing and gunzip use
 *      Node's built-in zlib only, so no dependency has to be installed.
 *   3. Parses the fixed-width synset records into lemmas plus gloss, splits each gloss
 *      into a definition and its quoted example sentences, folds the senses of one word
 *      into a single entry with one group per part of speech, and applies the same size
 *      caps the online providers use (see background/dictionary/shared.js).
 *   4. Keeps single-word lemmas only. WordNet stores multi-word entries with underscores
 *      ("hot_dog"); they are 25 percent of the database and the extension only ever
 *      looks up single tokens, so dropping them is a large saving for no loss.
 *   5. Writes the result to data/wordnet-subset.ndjson.gz as newline-delimited JSON:
 *      the first line is a metadata record, every following line is one normalized
 *      entry, exactly in the shape the dictionary providers produce. The options page
 *      streams that file, decompresses it with DecompressionStream and imports it into
 *      IndexedDB in batches, so nothing is ever held in memory in full.
 *
 * The file is gzipped because it is data, not code: it is decompressed at import time by
 * the browser, never evaluated. Nothing about it is loaded remotely at runtime.
 *
 * WordNet 3.0 is distributed by Princeton University under the WordNet License, a
 * permissive licence that allows redistribution, including in a modified form, provided
 * the copyright notice and the licence text are retained. The full text is written to
 * data/wordnet-LICENSE.txt by this script, and the options page shows the attribution.
 *
 * Usage:
 *   node tools/build-wordnet-subset.mjs [--out <file>] [--min-length <n>] [--multiword]
 *                                       [--max-definitions <n>] [--no-cache]
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const SOURCE_URL = 'https://wordnetcode.princeton.edu/3.0/WNdb-3.0.tar.gz';

/** Constants mirrored from lib/constants.js and background/dictionary/shared.js. */const MAX_DEFINITIONS_PER_POS = 6;
const MAX_TEXT_LENGTH = 600;
const SOURCE_LABEL = 'WordNet 3.0 (local subset)';
const LICENCE = 'WordNet 3.0 licence (permissive)';

/**
 * The verbatim WordNet 3.0 licence, reproduced from the SPDX licence registry
 * (https://spdx.org/licenses/WordNet.html) and the Open Source Initiative
 * (https://opensource.org/license/wordnet), which agree word for word.
 *
 * It is embedded rather than read from the archive because WNdb-3.0.tar.gz ships only the
 * database files and no licence file, and the licence requires the notice to appear on all
 * copies of the database. If the archive does contain one, that copy is preferred.
 */
const LICENCE_TEXT = `WordNet Release 3.0

This software and database is being provided to you, the LICENSEE, by Princeton
University under the following license. By obtaining, using and/or copying this software
and database, you agree that you have read, understood, and will comply with these terms
and conditions.:

Permission to use, copy, modify and distribute this software and database and its
documentation for any purpose and without fee or royalty is hereby granted, provided that
you agree to comply with the following copyright notice and statements, including the
disclaimer, and that the same appear on ALL copies of the software, database and
documentation, including modifications that you make for internal use or for distribution.

WordNet 3.0 Copyright 2006 by Princeton University. All rights reserved.

THIS SOFTWARE AND DATABASE IS PROVIDED "AS IS" AND PRINCETON UNIVERSITY MAKES NO
REPRESENTATIONS OR WARRANTIES, EXPRESS OR IMPLIED. BY WAY OF EXAMPLE, BUT NOT LIMITATION,
PRINCETON UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF THE LICENSED SOFTWARE, DATABASE OR
DOCUMENTATION WILL NOT INFRINGE ANY THIRD PARTY PATENTS, COPYRIGHTS, TRADEMARKS OR OTHER
RIGHTS.

The name of Princeton University or Princeton may not be used in advertising or publicity
pertaining to distribution of the software and/or database. Title to copyright in this
software, database and any associated documentation shall at all times remain with
Princeton University and LICENSEE agrees to preserve same.
`;

/** WordNet part-of-speech codes in the data files, mapped to readable labels. */
const POS_LABELS = Object.freeze({
  n: 'noun',
  v: 'verb',
  a: 'adjective',
  s: 'adjective',
  r: 'adverb'
});

/**
 * Lemmas that are kept: one word, no spaces, no digits. WordNet has a small number of
 * hyphenated and apostrophised entries ("x-ray", "o'clock") and those are worth keeping.
 */
const SINGLE_WORD_PATTERN = /^[A-Za-z][A-Za-z'’-]*$/;

// --- Command line ------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    out: join(ROOT, 'data', 'wordnet-subset.ndjson.gz'),
    minLength: 2,
    includeMultiword: false,
    maxDefinitions: MAX_DEFINITIONS_PER_POS,
    useCache: true,
    tarball: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--out':
        options.out = resolve(argv[index += 1]);
        break;
      case '--tar':
        options.tarball = resolve(argv[index += 1]);
        break;
      case '--min-length':
        options.minLength = Number(argv[index += 1]);
        break;
      case '--max-definitions':
        options.maxDefinitions = Number(argv[index += 1]);
        break;
      case '--multiword':
        options.includeMultiword = true;
        break;
      case '--no-cache':
        options.useCache = false;
        break;
      case '--help':
        console.log(
          'Usage: node tools/build-wordnet-subset.mjs [--out <file>] [--min-length <n>] ' +
            '[--max-definitions <n>] [--multiword] [--no-cache] [--tar <file>]'
        );
        process.exit(0);
        break;
      default:
        console.warn(`Ignoring unknown argument: ${argument}`);
    }
  }

  return options;
}

// --- Download and untar ------------------------------------------------------

/** Name of the cached tarball inside the temporary directory. */
const TARBALL_NAME = 'WNdb-3.0.tar.gz';

async function downloadTarball(useCache, explicitPath) {
  if (explicitPath) {
    const buffer = await readFile(explicitPath);
    console.log(`Using the tarball at ${explicitPath} (${formatBytes(buffer.length)}).`);
    return buffer;
  }

  const target = join(tmpdir(), TARBALL_NAME);

  if (useCache) {
    try {
      const info = await stat(target);
      if (info.size > 1000000) {
        console.log(`Using the cached WordNet tarball at ${target} (${formatBytes(info.size)}).`);
        return readFile(target);
      }
    } catch {
      // Not cached yet.
    }
  }

  console.log(`Downloading ${SOURCE_URL} ...`);
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`The download failed with HTTP ${response.status}.`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(target, buffer);
  console.log(`Downloaded ${formatBytes(buffer.length)} to ${target}.`);
  return buffer;
}

/**
 * Reads the members of a tar archive.
 *
 * Only the little that WordNet's archive needs is implemented: the ustar header layout,
 * regular files, and the "prefix" field for long paths. Sizes are octal, which is what
 * every tar writer used in 2007 emitted.
 *
 * @param {Buffer} tar Uncompressed tar bytes.
 * @returns {Map<string, Buffer>} Member name -> content.
 */
function readTar(tar) {
  const members = new Map();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker

    const readString = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/, '')
        .trim();

    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const size = Number.parseInt(readString(124, 12) || '0', 8) || 0;
    const typeFlag = header.subarray(156, 157).toString('utf8');

    const start = offset + 512;
    const end = start + size;

    if (typeFlag === '0' || typeFlag === '' || typeFlag === '\0') {
      const content = tar.subarray(start, end);
      const fullName = prefix ? `${prefix}/${name}` : name;
      members.set(fullName, content);

      // The official Princeton archive stores every file under a "dict/" directory, while
      // older repackagings put them at the archive root. Keying on the base name as well
      // means the lookups below work with either layout and with a nested prefix.
      const basename = fullName.slice(fullName.lastIndexOf('/') + 1);
      if (basename !== fullName && !members.has(basename)) members.set(basename, content);
    } else if (typeFlag === 'L') {
      // GNU long name: the next header carries the real name. Not used by WordNet's
      // archive, so it is only skipped rather than supported.
      offset = start + Math.ceil(size / 512) * 512;
      continue;
    }

    offset = start + Math.ceil(size / 512) * 512;
  }

  return members;
}

// --- Gloss and sense parsing --------------------------------------------------

/** Strips wiki-style markup and collapses whitespace, mirroring cleanText() in shared.js. */
function cleanText(value) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/<[^>]*>/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (text.length > MAX_TEXT_LENGTH) {
    text = `${text.slice(0, MAX_TEXT_LENGTH - 3).trimEnd()}...`;
  }
  return text;
}

/**
 * Splits a WordNet gloss into its definition and its example sentences.
 *
 * Gloss format in the data files: `definition; "example one"; "example two"`. The first
 * quoted segment always belongs to the definition, so the split happens on the first
 * `; "` (or `;"`) and the remaining quoted segments become examples.
 *
 * @param {string} gloss
 * @returns {{definition: string, examples: string[]}}
 */
function splitGloss(gloss) {
  const trimmed = gloss.trim();
  const marker = trimmed.search(/;\s*"/);
  const definitionPart = marker === -1 ? trimmed : trimmed.slice(0, marker);
  const examplePart = marker === -1 ? '' : trimmed.slice(marker);

  const examples = [];
  for (const match of examplePart.matchAll(/"([^"]*)"/g)) {
    const example = cleanText(match[1]);
    if (example) examples.push(example);
  }

  return { definition: cleanText(definitionPart), examples };
}

/**
 * Parses one data file (data.noun, data.verb, data.adj, data.adv).
 *
 * Layout of a synset line:
 *   offset(8) lex_filenum(2) ss_type(1) w_cnt(2 hex) [lemma lex_id]* p_cnt(3) [pointer]* | gloss
 *
 * @param {string} text File content.
 * @param {Map<string, {word: string, byPos: Map<string, Array>}>} index Output index.
 * @param {Object} options
 * @returns {{synsets: number, definitions: number}}
 */
function parseDataFile(text, index, options) {
  let synsets = 0;
  let definitions = 0;

  for (const line of text.split('\n')) {
    if (!line || line.startsWith('  ')) continue; // the header block is indented

    const barIndex = line.indexOf('| ');
    if (barIndex === -1) continue;

    const header = line.slice(0, barIndex);
    const gloss = line.slice(barIndex + 2);

    const ssType = header.slice(12, 13);
    const partOfSpeech = POS_LABELS[ssType];
    if (!partOfSpeech) continue;

    const wordCount = Number.parseInt(header.slice(14, 16), 16);
    if (!Number.isFinite(wordCount) || wordCount <= 0) continue;

    // After the two-hex-digit word count and its space, lemmas follow as
    // `lemma lex_id lemma lex_id ...`, each token separated by a single space and each
    // lex_id one hexadecimal digit. Words never contain a space (multi-word entries use
    // underscores), so token scanning on spaces is exact here.
    const lemmas = [];
    let cursor = 17;
    for (let index2 = 0; index2 < wordCount && cursor < header.length; index2 += 1) {
      const lemmaEnd = header.indexOf(' ', cursor);
      if (lemmaEnd === -1) break;
      const lemma = header.slice(cursor, lemmaEnd);
      cursor = lemmaEnd + 1;

      const lexIdEnd = header.indexOf(' ', cursor);
      if (lexIdEnd === -1) break;
      cursor = lexIdEnd + 1;

      if (lemma) lemmas.push(lemma);
    }

    const { definition, examples } = splitGloss(gloss);
    if (!definition) continue;

    synsets += 1;

    for (let lemma of lemmas) {
      // Adjective satellites carry an "(a)" / "(p)" marker in the data file.
      lemma = lemma.replace(/\([aps]\)$/, '');
      lemma = lemma.trim();

      if (!lemma) continue;
      if (lemma.includes('_')) {
        if (!options.includeMultiword) continue;
      } else if (!SINGLE_WORD_PATTERN.test(lemma)) {
        continue;
      }

      const word = options.includeMultiword ? lemma.toLowerCase().replace(/_/g, ' ') : lemma.toLowerCase();
      if (word.length < options.minLength) continue;

      let record = index.get(word);
      if (!record) {
        record = { word, byPos: new Map() };
        index.set(word, record);
      }

      let group = record.byPos.get(partOfSpeech);
      if (!group) {
        group = [];
        record.byPos.set(partOfSpeech, group);
      }
      if (group.length >= options.maxDefinitions) continue;

      const fingerprint = definition.toLowerCase();
      if (group.some((entry) => entry.definition.toLowerCase() === fingerprint)) continue;

      group.push({ definition, example: examples[0] || null });
      definitions += 1;
    }
  }

  return { synsets, definitions };
}

// --- Output -------------------------------------------------------------------

/** Turns the index into the normalized entry objects the extension stores. */
function toEntries(index) {
  const entries = [];
  for (const record of index.values()) {
    const meanings = [];
    for (const [partOfSpeech, definitions] of record.byPos) {
      if (definitions.length > 0) meanings.push({ partOfSpeech, definitions });
    }
    if (meanings.length === 0) continue;

    entries.push({
      word: record.word,
      phonetic: null,
      audioUrl: null,
      source: SOURCE_LABEL,
      meanings,
      sourceUrl: 'https://wordnet.princeton.edu/',
      license: LICENCE
    });
  }

  // Alphabetical order keeps the file diffable across runs.
  entries.sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
  return entries;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// --- Main ---------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const tarball = await downloadTarball(options.useCache, options.tarball);
  console.log('Decompressing the archive ...');
  const members = readTar(gunzipSync(tarball));

  const dataFiles = ['data.noun', 'data.verb', 'data.adj', 'data.adv'];
  for (const name of dataFiles) {
    if (!members.has(name)) throw new Error(`The archive is missing ${name}.`);
  }

  const index = new Map();
  let synsets = 0;
  let definitions = 0;

  for (const name of dataFiles) {
    const text = members.get(name).toString('utf8');
    const parsed = parseDataFile(text, index, options);
    synsets += parsed.synsets;
    definitions += parsed.definitions;
    console.log(
      `Parsed ${name}: ${parsed.synsets.toLocaleString('en-US')} synsets, ` +
        `${parsed.definitions.toLocaleString('en-US')} definitions kept.`
    );
  }

  const entries = toEntries(index);
  console.log(`Kept ${entries.length.toLocaleString('en-US')} single-word entries.`);

  const meta = {
    format: 'hfws-wordnet-subset/1',
    entries: entries.length,
    builtAt: new Date().toISOString(),
    sourceUrl: SOURCE_URL,
    source: SOURCE_LABEL,
    license: LICENCE,
    licenseUrl: 'https://spdx.org/licenses/WordNet.html',
    maxDefinitionsPerPartOfSpeech: options.maxDefinitions,
    minWordLength: options.minLength,
    includesMultiwordEntries: options.includeMultiword,
    note: 'Generated by tools/build-wordnet-subset.mjs from the Princeton WordNet 3.0 database.'
  };

  const lines = [JSON.stringify(meta)];
  for (const entry of entries) lines.push(JSON.stringify(entry));
  const payload = `${lines.join('\n')}\n`;
  const plainBytes = Buffer.byteLength(payload);
  const compressed = gzipSync(payload, { level: 9 });

  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, compressed);

  // The WordNet licence requires the notice to travel with the data. The official archive
  // carries no licence file, so the embedded copy is normally what gets written.
  const archivedLicense = members.get('LICENSE') || members.get('license') || members.get('LICENCE');
  const licenseText = archivedLicense ? archivedLicense.toString('utf8') : LICENCE_TEXT;
  const licensePath = join(dirname(options.out), 'wordnet-LICENSE.txt');
  await writeFile(licensePath, licenseText);

  const sha256 = createHash('sha256').update(compressed).digest('hex');

  console.log('');
  console.log(`Wrote ${options.out}`);
  console.log(`  entries                ${entries.length.toLocaleString('en-US')}`);
  console.log(`  synsets parsed         ${synsets.toLocaleString('en-US')}`);
  console.log(`  definitions kept       ${definitions.toLocaleString('en-US')}`);
  console.log(`  uncompressed           ${formatBytes(plainBytes)}`);
  console.log(`  gzipped on disk        ${formatBytes(compressed.length)}`);
  console.log(`  sha256                 ${sha256}`);
  if (licenseText) console.log(`  licence text           ${licensePath}`);
  console.log('');
  console.log('Open the extension options page and press "Import the offline subset" to load it.');
}

main().catch((error) => {
  console.error(`Build failed: ${(error && error.message) || error}`);
  process.exitCode = 1;
});
