/**
 * IndexedDB Helper for X Offline Enhancer (ES Module - Canonical Source)
 * Database: XOfflineDB_v1
 * Store: threads
 */

const DB_NAME = 'XOfflineDB_v1';
const DB_VERSION = 2;
const STORE_NAME = 'threads';
const VIDEO_STORE_NAME = 'video_blobs';

let dbInstance = null;

function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('tags', 'tags', { unique: false, multiEntry: true });
      }
      if (!db.objectStoreNames.contains(VIDEO_STORE_NAME)) {
        const vStore = db.createObjectStore(VIDEO_STORE_NAME, { keyPath: 'id' });
        vStore.createIndex('threadId', 'threadId', { unique: false });
      }
    };
    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      dbInstance.onclose = () => { dbInstance = null; };
      dbInstance.onversionchange = () => {
        dbInstance.close();
        dbInstance = null;
      };
      resolve(dbInstance);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

async function withRetry(fn, retries = 1) {
  try {
    return await fn();
  } catch (err) {
    if (retries > 0 && (err.name === 'InvalidStateError' || err.name === 'TransactionInactiveError')) {
      dbInstance = null;
      return withRetry(fn, retries - 1);
    }
    throw err;
  }
}

async function addThread(thread) {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(thread);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
}

async function getThread(id) {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
}

async function getAllThreads() {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('timestamp');
      const results = [];
      const request = index.openCursor(null, 'prev');
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) { resolve(results); return; }
        results.push(cursor.value);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  });
}

async function getAllThreadsMeta(limit = 200) {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('timestamp');
      const results = [];
      const request = index.openCursor(null, 'prev');
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor || results.length >= limit) { resolve(results); return; }
        const { imageCache, ...meta } = cursor.value;
        results.push(meta);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  });
}

async function deleteThread(id) {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

async function deleteAllThreads() {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

async function searchThreads(query) {
  return withRetry(async () => {
    const db = await openDB();
    const q = query.toLowerCase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('timestamp');
      const results = [];
      const request = index.openCursor(null, 'prev');
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) { resolve(results); return; }
        const t = cursor.value;
        const tweetsMatch = t.tweets?.some(tw =>
          tw.text?.toLowerCase().includes(q) ||
          tw.author?.name?.toLowerCase().includes(q) ||
          tw.author?.handle?.toLowerCase().includes(q)
        );
        const tagsMatch = t.tags?.some(tag => tag.toLowerCase().includes(q));
        const urlMatch = t.url?.toLowerCase().includes(q);
        if (tweetsMatch || tagsMatch || urlMatch) {
          const { imageCache, ...meta } = t;
          results.push(meta);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  });
}

async function getSavedIds() {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  });
}

async function getStorageSize() {
  if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage || 0, quota: estimate.quota || 0 };
  }
  return { usage: 0, quota: 0 };
}

/**
 * Remove imageCache from threads older than ttlDays.
 * Keeps the thread itself (text, author, etc.) — only images are purged.
 */
async function purgeExpiredCaches(ttlDays) {
  if (!ttlDays || ttlDays <= 0) return { purged: 0, freedEstimate: 0 };
  const cutoff = Date.now() - (ttlDays * 24 * 60 * 60 * 1000);

  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('timestamp');
      let purged = 0;
      let freedEstimate = 0;

      const range = IDBKeyRange.upperBound(cutoff);
      const request = index.openCursor(range, 'next');
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) { resolve({ purged, freedEstimate }); return; }
        const thread = cursor.value;
        if (thread.imageCache && Object.keys(thread.imageCache).length > 0) {
          freedEstimate += JSON.stringify(thread.imageCache).length;
          thread.imageCache = {};
          cursor.update(thread);
          purged++;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Remove imageCache from oldest threads until storage usage is under limitBytes.
 */
async function purgeUntilUnderLimit(limitBytes) {
  if (!limitBytes || limitBytes <= 0) return { purged: 0, freedEstimate: 0 };

  const { usage } = await getStorageSize();
  if (usage <= limitBytes) return { purged: 0, freedEstimate: 0 };
  const needToFree = usage - limitBytes;

  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('timestamp');
      let purged = 0;
      let freedEstimate = 0;

      const request = index.openCursor(null, 'next');
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor || freedEstimate >= needToFree) {
          resolve({ purged, freedEstimate });
          return;
        }
        const thread = cursor.value;
        if (thread.imageCache && Object.keys(thread.imageCache).length > 0) {
          freedEstimate += JSON.stringify(thread.imageCache).length;
          thread.imageCache = {};
          cursor.update(thread);
          purged++;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Store a video blob for a thread.
 * @param {string} threadId
 * @param {number} index - video index within the thread
 * @param {Blob} blob - video data
 * @param {string} url - original video URL
 */
async function addVideoBlob(threadId, index, blob, url) {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(VIDEO_STORE_NAME, 'readwrite');
      const store = tx.objectStore(VIDEO_STORE_NAME);
      const record = {
        id: `${threadId}:${index}`,
        threadId: String(threadId),
        url,
        blob,
        size: blob.size,
        timestamp: Date.now()
      };
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

async function getVideosByThread(threadId) {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(VIDEO_STORE_NAME, 'readonly');
      const store = tx.objectStore(VIDEO_STORE_NAME);
      const index = store.index('threadId');
      const results = [];
      const request = index.openCursor(IDBKeyRange.only(String(threadId)));
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) { resolve(results); return; }
        results.push(cursor.value);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  });
}

async function deleteVideosByThread(threadId) {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(VIDEO_STORE_NAME, 'readwrite');
      const store = tx.objectStore(VIDEO_STORE_NAME);
      const index = store.index('threadId');
      const request = index.openCursor(IDBKeyRange.only(String(threadId)));
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) { resolve(); return; }
        cursor.delete();
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  });
}

async function deleteAllVideos() {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(VIDEO_STORE_NAME, 'readwrite');
      const store = tx.objectStore(VIDEO_STORE_NAME);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

export {
  openDB, addThread, getThread, getAllThreads, getAllThreadsMeta,
  deleteThread, deleteAllThreads, searchThreads, getSavedIds, getStorageSize,
  purgeExpiredCaches, purgeUntilUnderLimit,
  addVideoBlob, getVideosByThread, deleteVideosByThread, deleteAllVideos
};
