/**
 * IndexedDB access for the optional offline WordNet subset.
 *
 * Why IndexedDB and not chrome.storage.local: the default chrome.storage.local quota is
 * about 10 MB and the extension does not request unlimitedStorage (deliberately, since a
 * word-frequency tool has no business asking for it). IndexedDB on the extension origin
 * is not bound by that quota and gives us keyed lookups instead of one giant blob.
 *
 * Both the service worker and the options page import this module, so the seeding code
 * and the lookup code can never drift apart.
 */

import { WORDNET_DB, WORDNET_META_KEY } from './constants.js';

let dbPromise = null;

/** Opens (and on first use creates) the database. */
export function openWordnetDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(WORDNET_DB.name, WORDNET_DB.version);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WORDNET_DB.entriesStore)) {
        const entries = db.createObjectStore(WORDNET_DB.entriesStore, { keyPath: 'word' });
        entries.createIndex('source', 'source', { unique: false });
      }
      if (!db.objectStoreNames.contains(WORDNET_DB.metaStore)) {
        db.createObjectStore(WORDNET_DB.metaStore, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('Could not open the offline WordNet database.'));
    };
  });

  return dbPromise;
}

/** Promisifies one IndexedDB request. */
function toPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Looks up a single entry in the offline subset.
 *
 * @param {string} word Lowercased word.
 * @returns {Promise<Object|null>} The stored normalized entry, or null.
 */
export async function getWordnetEntry(word) {
  const db = await openWordnetDb();
  const transaction = db.transaction(WORDNET_DB.entriesStore, 'readonly');
  const store = transaction.objectStore(WORDNET_DB.entriesStore);
  const result = await toPromise(store.get(word));
  return result || null;
}

/** Number of entries currently installed, or 0 when nothing is installed. */
export async function countWordnetEntries() {
  const db = await openWordnetDb();
  const transaction = db.transaction(WORDNET_DB.entriesStore, 'readonly');
  const store = transaction.objectStore(WORDNET_DB.entriesStore);
  return (await toPromise(store.count())) || 0;
}

/** Reads the metadata record written by the importer. */
export async function getWordnetMeta() {
  const db = await openWordnetDb();
  const transaction = db.transaction(WORDNET_DB.metaStore, 'readonly');
  const store = transaction.objectStore(WORDNET_DB.metaStore);
  return (await toPromise(store.get(WORDNET_META_KEY))) || null;
}

/**
 * Imports entries in batches so a large subset does not hold one huge transaction open
 * and so progress can be reported to the options page.
 *
 * @param {Object[]} entries Normalized entries, each with a `word` field.
 * @param {(imported: number, total: number) => void} [onProgress]
 * @param {number} [batchSize]
 * @returns {Promise<number>} Number of imported entries.
 */
export async function importWordnetEntries(entries, onProgress, batchSize = 500) {
  const db = await openWordnetDb();
  let imported = 0;

  for (let start = 0; start < entries.length; start += batchSize) {
    const batch = entries.slice(start, start + batchSize);
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(WORDNET_DB.entriesStore, 'readwrite');
      const store = transaction.objectStore(WORDNET_DB.entriesStore);
      for (const entry of batch) {
        if (entry && typeof entry.word === 'string') store.put(entry);
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    imported += batch.length;
    if (onProgress) onProgress(imported, entries.length);
    // Yield between batches so the page stays responsive.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return imported;
}

/** Writes the metadata record that describes the installed subset. */
export async function setWordnetMeta(meta) {
  const db = await openWordnetDb();
  const transaction = db.transaction(WORDNET_DB.metaStore, 'readwrite');
  const store = transaction.objectStore(WORDNET_DB.metaStore);
  store.put(Object.assign({ key: WORDNET_META_KEY }, meta));
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/** Removes every installed entry, used by "remove the offline subset" in the options. */
export async function clearWordnetDb() {
  const db = await openWordnetDb();
  const transaction = db.transaction(
    [WORDNET_DB.entriesStore, WORDNET_DB.metaStore],
    'readwrite'
  );
  transaction.objectStore(WORDNET_DB.entriesStore).clear();
  transaction.objectStore(WORDNET_DB.metaStore).clear();
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
