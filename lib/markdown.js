/**
 * Markdown export.
 *
 * The document is plain CommonMark with no extensions, no HTML and no footnotes, which
 * is what makes it render identically in Typora, VS Code preview and on GitHub.
 *
 * Two rules shape the code below:
 *   1. Never interpolate raw dictionary text into the document without collapsing
 *      whitespace and escaping inline Markdown characters. A definition containing a
 *      newline or an asterisk would otherwise break the list it lives in.
 *   2. Always emit the word and its count, even when the definition could not be
 *      fetched. An export with gaps is still useful; a failed export is not.
 */

import { formatCount, formatDate, formatDateTime } from './format.js';

/** Definitions included per word. Keeps long entries readable. */
export const MAX_DEFINITIONS_PER_WORD = 6;

/** Human readable label for a lookup status. */
const STATUS_TEXT = Object.freeze({
  ok: null,
  pending: 'not fetched yet',
  missing: 'no entry found in the configured sources',
  error: 'lookup failed'
});

/**
 * Escapes inline Markdown so dictionary text cannot restructure the document.
 * Whitespace is collapsed too, so a definition is always a single line.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeInline(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text
    .replace(/([\\`*_[\]<>#])/g, '\\$1')
    .replace(/^([-+>])/, '\\$1');
}

/** Escapes a value used as a Markdown heading. */
function escapeHeading(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\`*_[\]<>#])/g, '\\$1');
}

/** Builds the one-line summary of the active analysis toggles. */
export function describeSettings(settings = {}) {
  const parts = [
    settings.stopWords ? 'stop words excluded' : 'stop words kept',
    `minimum length ${settings.minLength}`,
    settings.lemmatize ? 'lemmatization on' : 'lemmatization off',
    settings.excludeCode ? 'code blocks excluded' : 'code blocks included',
    settings.excludeBoilerplate ? 'boilerplate excluded' : 'boilerplate included'
  ];
  return parts.join(' | ');
}

/** Ordering for the export: frequency descending, then alphabetically. */
function orderForExport(records) {
  return records.slice().sort((a, b) => b.count - a.count || a.word.localeCompare(b.word, 'en'));
}

/**
 * Collects the definition source names that were actually used, with their license
 * links, so the attribution line only mentions what is in the file.
 */
function collectSources(records, statusByWord) {
  const sources = new Map();
  for (const record of records) {
    const result = statusByWord.get(record.word);
    const entry = result?.entry;
    if (!entry) continue;
    const key = entry.source || 'Unknown source';
    if (!sources.has(key)) {
      sources.set(key, { name: key, url: entry.sourceUrl || '', license: entry.license || '' });
    }
  }
  return sources;
}

/**
 * Builds the Markdown document.
 *
 * @param {Object} input
 * @param {Object} input.scan       Scan payload metadata (title, url, scannedAt, truncated).
 * @param {Object[]} input.records  Word records to export, in any order.
 * @param {Map<string, {entry: Object|null, status: string}>} input.statusByWord
 *   Lookup result per exported word. Missing entries are exported with word and count.
 * @param {Object} input.settings   Analysis settings used for the export.
 * @param {number} input.exportedAt Epoch milliseconds.
 * @param {Object} [input.stats]    Page level statistics: uniqueWords, totalTokens.
 * @returns {string} Markdown document.
 */
export function buildMarkdown({ scan, records, statusByWord, settings, exportedAt, stats = {} }) {
  const ordered = orderForExport(records);
  const lines = [];

  lines.push('# High-Frequency Word List');
  lines.push('');
  lines.push(`- Source: ${escapeInline(scan?.title) || 'Untitled page'}`);
  lines.push(`- URL: ${String(scan?.url || '')}`);
  lines.push(`- Exported: ${formatDateTime(exportedAt)}`);
  lines.push(`- Words exported: ${formatCount(ordered.length)}`);
  lines.push(
    `- Words on the page: ${formatCount(stats.uniqueWords ?? 0)} unique of ` +
      `${formatCount(stats.totalTokens ?? 0)} tokens scanned`
  );
  lines.push(
    `- Scan taken: ${formatDateTime(scan?.scannedAt)} from ${escapeInline(scan?.domain) || 'unknown site'}`
  );
  lines.push(`- Filters: ${describeSettings(settings)}`);
  if (scan?.truncated) {
    lines.push(`- Note: the scan was truncated (${escapeInline((scan.truncateReasons || []).join('; '))})`);
  }
  lines.push('');

  ordered.forEach((record, index) => {
    const result = statusByWord.get(record.word);
    const entry = result?.entry || null;
    const occurrences = record.count === 1 ? '1 occurrence' : `${record.count} occurrences`;

    lines.push('---');
    lines.push('');
    lines.push(`## ${index + 1}. ${escapeHeading(record.word)} (${occurrences})`);
    lines.push('');

    if (entry) {
      if (entry.phonetic) {
        lines.push(`- **Phonetic**: ${escapeInline(entry.phonetic)}`);
      }
      if (record.capitalizedRatio >= 0.8 && record.count >= 5) {
        lines.push(
          `- **Usually capitalized**: ${record.capitalizedCount} of ${record.count} occurrences`
        );
      }
      if (record.variants.length > 1) {
        lines.push(`- **Forms on this page**: ${escapeInline(record.variants.join(', '))}`);
      }

      let written = 0;
      let omitted = 0;
      for (const meaning of entry.meanings || []) {
        for (const definition of meaning.definitions || []) {
          if (written >= MAX_DEFINITIONS_PER_WORD) {
            omitted += 1;
            continue;
          }
          written += 1;
          lines.push(`- **Part of speech**: ${escapeInline(meaning.partOfSpeech) || 'unknown'}`);
          lines.push(`- **Definition**: ${escapeInline(definition.definition)}`);
          if (definition.example) {
            lines.push(`- **Example**: ${escapeInline(definition.example)}`);
          }
        }
      }

      if (written === 0) {
        lines.push('- **Definition**: no usable definition returned by the source');
      } else if (omitted > 0) {
        lines.push(`- **Note**: ${omitted} further definition(s) omitted; see the detail panel`);
      }

      lines.push(`- **Source**: ${escapeInline(entry.source)}`);
    } else {
      lines.push(`- **Definition**: ${STATUS_TEXT[result?.status || 'pending'] || STATUS_TEXT.pending}`);
      lines.push('- **Source**: not consulted');
    }

    lines.push('');
  });

  lines.push('---');
  lines.push('');
  lines.push('## Sources and license');
  lines.push('');

  const sources = collectSources(ordered, statusByWord);
  if (sources.size === 0) {
    lines.push('- No definition source was consulted for this export.');
  } else {
    for (const source of sources.values()) {
      const license = source.license ? ` (${escapeInline(source.license)})` : '';
      const url = source.url ? ` - ${source.url}` : '';
      lines.push(`- ${escapeInline(source.name)}${license}${url}`);
    }
  }
  lines.push('');
  lines.push(
    '- Wiktionary text is available under the Creative Commons Attribution-ShareAlike 3.0 Unported licence and is used here with attribution. See https://en.wiktionary.org/wiki/Wiktionary:Copyrights'
  );
  lines.push(
    '- WordNet 3.0 is distributed by Princeton University under a permissive licence that allows redistribution.'
  );
  lines.push('');
  lines.push(
    'Generated locally by the High-Frequency Word Scanner extension. Page text was never uploaded; ' +
      'the only outbound requests were dictionary lookups for the words exported above.'
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * Builds the download filename: `highfreq-<domain>-<YYYY-MM-DD>.md`, ASCII only.
 *
 * @param {string} domainSlug Already slugified domain.
 * @param {number} exportedAt Epoch milliseconds.
 */
export function exportFilename(domainSlug, exportedAt) {
  return `highfreq-${domainSlug || 'page'}-${formatDate(exportedAt) || 'export'}.md`;
}
