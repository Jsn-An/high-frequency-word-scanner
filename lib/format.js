/**
 * Small formatting helpers shared by the results page, the export and the options page.
 * Everything here is intentionally ASCII-only in its output so exported files and
 * filenames stay portable.
 */

/** Two-digit zero padding. */
function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * Formats a timestamp as `YYYY-MM-DD HH:mm` in local time, which is the format used in
 * the exported Markdown header.
 *
 * @param {number|string|Date} value Epoch milliseconds, ISO string or Date.
 * @returns {string} Local time, or an empty string when the input cannot be parsed.
 */
export function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return '';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Formats a timestamp as `YYYY-MM-DD`, used for the export filename. */
export function formatDate(value) {
  const date = toDate(value);
  if (!date) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Formats a timestamp for the results page header, including seconds. */
export function formatDateTimeLong(value) {
  const date = toDate(value);
  if (!date) return '';
  return `${formatDateTime(date)}:${pad(date.getSeconds())}`;
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** Formats a ratio (0..1) as a whole-number percentage. */
export function formatPercent(ratio) {
  if (!Number.isFinite(ratio)) return '0%';
  return `${Math.round(ratio * 100)}%`;
}

/** Groups thousands with a narrow separator that reads well in both themes. */
export function formatCount(value) {
  return Number(value || 0).toLocaleString('en-US');
}

/**
 * Formats a byte count for display, using binary units and one decimal place.
 * ASCII only, so it is safe in the options page and in logs.
 *
 * @param {number} bytes
 * @returns {string} For example `12.4 KB`.
 */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Turns a domain into a filesystem-safe slug for the export filename.
 * Keeps ASCII letters and digits, collapses everything else into single hyphens.
 *
 * @param {string} value Domain or URL fragment.
 * @returns {string} Slug such as `news-example-com`.
 */
export function slugify(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'page';
}

/** Extracts the hostname of a URL, falling back to a readable placeholder. */
export function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown-site';
  }
}

/** Clamps a number into an inclusive range, returning the fallback for NaN. */
export function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** Truncates a string for display without cutting a surrogate pair in half. */
export function truncate(text, maxLength) {
  const value = String(text || '');
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}\u2026`;
}
