/**
 * IndexedDB Helper for X Offline Enhancer (ES Module - Canonical Source)
 * Database: XOfflineDB_v1
 * Stores: threads, image_blobs, video_blobs
 */

const DB_NAME = 'XOfflineDB_v1';
const DB_VERSION = 4;
const STORE_NAME = 'threads';
const VIDEO_STORE_NAME = 'video_blobs';
const IMAGE_STORE_NAME = 'image_blobs';

let dbInstance = null;

// ---------- summary / search token helpers ----------

function tokenize(raw) {
  if (!raw) return [];
  const lower = String(raw).toLowerCase();
  const out = new Set();
  for (const tok of lower.split(/[\s\p{P}\p{S}]+/u)) {
    if (tok && tok.length > 0) out.add(tok);
  }
  return Array.from(out);
}

function pickPrimaryAuthor(tweet) {
  if (!tweet) return '';
  return tweet.authorHandle ?? tweet.author?.handle ?? '';
}

function computeSummary(thread) {
  const tweets = Array.isArray(thread?.tweets) ? thread.tweets : [];
  const primary = tweets[0] || null;
  return {
    primaryAuthor: pickPrimaryAuthor(primary),
    primaryText: String(primary?.text ?? '').slice(0, 280),
    imageCount: tweets.reduce((a, t) => a + (Array.isArray(t?.images) ? t.images.length : 0), 0),
    videoCount: tweets.reduce((a, t) => {
      if (Array.isArray(t?.videos)) return a + t.videos.length;
      return a + (t?.hasVideo ? 1 : 0);
    }, 0)
  };
}

function computeSearchTokens(thread) {
  const tweets = Array.isArray(thread?.tweets) ? thread.tweets : [];
  const primary = tweets[0] || null;
  const tags = Array.isArray(thread?.tags) ? thread.tags : [];
  const raw = [
    pickPrimaryAuthor(primary),
    String(primary?.text ?? ''),
    tags.join(' ')
  ].join(' ');
  return tokenize(raw);
}

function enrichThreadForStorage(thread) {
  if (!thread) return thread;
  const { imageCache, ...clean } = thread;
  clean.summary = computeSummary(clean);
  clean.searchTokens = computeSearchTokens(clean);
  return clean;
}

function projectMeta(rec) {
  if (!rec) return rec;
  return {
    id: rec.id,
    savedAt: rec.savedAt ?? rec.timestamp,
    updatedAt: rec.updatedAt ?? rec.timestamp,
    tags: rec.tags,
    url: rec.url,
    integrity: rec.integrity,
    summary: rec.summary ?? computeSummary(rec)
  };
}

// ---------- openDB + migration ----------

function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const tx = event.target.transaction;
      const oldVersion = event.oldVersion || 0;

      // Stores
      let threadStore;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        threadStore = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        threadStore.createIndex('timestamp', 'timestamp', { unique: false });
        threadStore.createIndex('tags', 'tags', { unique: false, multiEntry: true });
      } else {
        threadStore = tx.objectStore(STORE_NAME);
      }

      let videoStore;
      if (!db.objectStoreNames.contains(VIDEO_STORE_NAME)) {
        videoStore = db.createObjectStore(VIDEO_STORE_NAME, { keyPath: 'id' });
        videoStore.createIndex('threadId', 'threadId', { unique: false });
      } else {
        videoStore = tx.objectStore(VIDEO_STORE_NAME);
      }

      let imageStore;
      if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) {
        imageStore = db.createObjectStore(IMAGE_STORE_NAME, { keyPath: 'key' });
        imageStore.createIndex('threadId', 'threadId', { unique: false });
      } else {
        imageStore = tx.objectStore(IMAGE_STORE_NAME);
      }

      // v4: createdAt indexes on blob stores + searchTokens on threads
      if (oldVersion < 4) {
        if (!imageStore.indexNames.contains('createdAt')) {
          imageStore.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!videoStore.indexNames.contains('createdAt')) {
          videoStore.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (!threadStore.indexNames.contains('searchTokens')) {
          threadStore.createIndex('searchTokens', 'searchTokens', { unique: false, multiEntry: true });
        }

        // Migrate existing threads: compute summary + searchTokens if missing
        try {
          const cursorReq = threadStore.openCursor();
          cursorReq.onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) return;
            const rec = cursor.value;
            let dirty = false;
            if (!rec.summary) { rec.summary = computeSummary(rec); dirty = true; }
            if (!Array.isArray(rec.searchTokens) || rec.searchTokens.length === 0) {
              rec.searchTokens = computeSearchTokens(rec);
              dirty = true;
            }
            if (rec.imageCache) { delete rec.imageCache; dirty = true; }
            if (dirty) cursor.update(rec);
            cursor.continue();
          };
        } catch (_) { /* best effort */ }

        // Migrate existing video blobs: backfill createdAt from timestamp
        try {
          const vCur = videoStore.openCursor();
          vCur.onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) return;
            const rec = cursor.value;
            if (typeof rec.createdAt !== 'number') {
              rec.createdAt = typeof rec.timestamp === 'number' ? rec.timestamp : Date.now();
              cursor.update(rec);
            }
            cursor.continue();
          };
        } catch (_) { /* best effort */ }

        // Migrate existing image blobs: ensure createdAt
        try {
          const iCur = imageStore.openCursor();
          iCur.onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) return;
            const rec = cursor.value;
            if (typeof rec.createdAt !== 'number') {
              rec.createdAt = Date.now();
              cursor.update(rec);
            }
            cursor.continue();
          };
        } catch (_) { /* best effort */ }
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

// ---------- threads ----------

async function addThread(thread) {
  const clean = enrichThreadForStorage(thread);
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(clean);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Batch insert/update N threads in a single readwrite transaction.
 * imageCache is stripped per thread; summary + searchTokens are computed.
 * @param {Array<object>} threads
 */
async function addThreads(threads) {
  if (!Array.isArray(threads) || threads.length === 0) return 0;
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      let count = 0;
      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      for (const t of threads) {
        if (!t) continue;
        store.put(enrichThreadForStorage(t));
        count++;
      }
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

async function getAllThreadsMeta(limit = 200) {
  const cap = Math.max(1, Math.min(Number(limit) || 200, 2000));
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
        if (!cursor || results.length >= cap) { resolve(results); return; }
        results.push(projectMeta(cursor.value));
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  });
}

async function deleteThread(id) {
  await deleteImagesForThread(id).catch(() => {});
  await deleteVideosByThread(id).catch(() => {});
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

/**
 * Search threads by tag (exact, case-insensitive) then fall back to searchTokens prefix.
 * Returns projected meta records; max `limit` entries.
 */
async function searchThreads(query, { limit = 200 } = {}) {
  const q = String(query ?? '').toLowerCase().trim();
  const cap = Math.max(1, Math.min(Number(limit) || 200, 2000));
  if (!q) return [];

  return withRetry(async () => {
    const db = await openDB();

    // Step 1: tag index (multiEntry) — exact match against lowered query.
    const byTag = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const idx = store.index('tags');
      const out = [];
      const seen = new Set();
      const req = idx.openCursor(IDBKeyRange.only(q));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor || out.length >= cap) { resolve(out); return; }
        const rec = cursor.value;
        if (rec && !seen.has(rec.id)) {
          seen.add(rec.id);
          out.push(projectMeta(rec));
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });

    if (byTag.length > 0) return byTag;

    // Step 2: searchTokens prefix cursor.
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const idx = store.index('searchTokens');
      const out = [];
      const seen = new Set();
      const range = IDBKeyRange.bound(q, q + '\uffff', false, false);
      const req = idx.openCursor(range);
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor || out.length >= cap) { resolve(out); return; }
        const rec = cursor.value;
        if (rec && !seen.has(rec.id)) {
          seen.add(rec.id);
          out.push(projectMeta(rec));
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
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

// ---------- blob purge ----------

/**
 * Legacy helper: strip the deprecated inline imageCache from thread records
 * older than ttlDays. Kept for callers that still expect this signature.
 */
async function purgeLegacyImageCache(ttlDays) {
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
          delete thread.imageCache;
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
 * Delete blobs (image + video) older than maxAgeDays and/or shrink total size
 * below maxBytes by dropping oldest-first.
 * @param {{ maxBytes?: number, maxAgeDays?: number }} opts
 */
async function purgeBlobsOverflow(opts = {}) {
  const { maxBytes = 0, maxAgeDays = 0 } = opts;
  const result = { imagesDeleted: 0, videosDeleted: 0, bytesFreed: 0 };

  // Stage A — age-based deletion per store.
  if (maxAgeDays > 0) {
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    for (const storeName of [IMAGE_STORE_NAME, VIDEO_STORE_NAME]) {
      await withRetry(async () => {
        const db = await openDB();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          const idx = store.index('createdAt');
          const range = IDBKeyRange.upperBound(cutoff, false);
          const req = idx.openCursor(range);
          req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) { resolve(); return; }
            const rec = cursor.value;
            result.bytesFreed += rec?.size || 0;
            if (storeName === IMAGE_STORE_NAME) result.imagesDeleted++;
            else result.videosDeleted++;
            cursor.delete();
            cursor.continue();
          };
          req.onerror = () => reject(req.error);
          tx.onerror = () => reject(tx.error);
        });
      });
    }
  }

  // Stage B — size-based trimming across both stores, oldest first.
  if (maxBytes > 0) {
    const totals = await withRetry(async () => {
      const db = await openDB();
      let total = 0;
      for (const storeName of [IMAGE_STORE_NAME, VIDEO_STORE_NAME]) {
        total += await new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          let sum = 0;
          const req = store.openCursor();
          req.onsuccess = (e) => {
            const c = e.target.result;
            if (!c) { resolve(sum); return; }
            sum += c.value?.size || 0;
            c.continue();
          };
          req.onerror = () => reject(req.error);
        });
      }
      return total;
    });

    let need = totals - maxBytes;
    if (need > 0) {
      const candidates = await withRetry(async () => {
        const db = await openDB();
        const rows = [];
        for (const storeName of [IMAGE_STORE_NAME, VIDEO_STORE_NAME]) {
          await new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const idx = store.index('createdAt');
            const req = idx.openCursor(null, 'next');
            req.onsuccess = (e) => {
              const c = e.target.result;
              if (!c) { resolve(); return; }
              const v = c.value;
              rows.push({
                storeName,
                primaryKey: c.primaryKey,
                size: v?.size || 0,
                createdAt: v?.createdAt || 0
              });
              c.continue();
            };
            req.onerror = () => reject(req.error);
          });
        }
        rows.sort((a, b) => a.createdAt - b.createdAt);
        return rows;
      });

      const toDelete = { [IMAGE_STORE_NAME]: [], [VIDEO_STORE_NAME]: [] };
      for (const row of candidates) {
        if (need <= 0) break;
        toDelete[row.storeName].push(row.primaryKey);
        need -= row.size;
        result.bytesFreed += row.size;
        if (row.storeName === IMAGE_STORE_NAME) result.imagesDeleted++;
        else result.videosDeleted++;
      }

      await withRetry(async () => {
        const db = await openDB();
        for (const storeName of [IMAGE_STORE_NAME, VIDEO_STORE_NAME]) {
          const keys = toDelete[storeName];
          if (!keys.length) continue;
          await new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
            for (const k of keys) store.delete(k);
          });
        }
      });
    }
  }

  return result;
}

/**
 * Legacy wrapper — remove old blobs (image + video) older than ttlDays and
 * also strip the deprecated inline imageCache for threads past the cutoff.
 */
async function purgeExpiredCaches(ttlDays) {
  if (!ttlDays || ttlDays <= 0) return { purged: 0, freedEstimate: 0 };
  const blobRes = await purgeBlobsOverflow({ maxAgeDays: ttlDays });
  const legacyRes = await purgeLegacyImageCache(ttlDays);
  return {
    purged: blobRes.imagesDeleted + blobRes.videosDeleted + legacyRes.purged,
    freedEstimate: blobRes.bytesFreed + legacyRes.freedEstimate
  };
}

/**
 * Legacy wrapper — trim blob stores until total blob size is under limitBytes.
 * The argument refers to the blob budget, not to navigator.storage estimate.
 */
async function purgeUntilUnderLimit(limitBytes) {
  if (!limitBytes || limitBytes <= 0) return { purged: 0, freedEstimate: 0 };
  const res = await purgeBlobsOverflow({ maxBytes: limitBytes });
  return {
    purged: res.imagesDeleted + res.videosDeleted,
    freedEstimate: res.bytesFreed
  };
}

// ---------- videos ----------

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
      const now = Date.now();
      const record = {
        id: `${threadId}:${index}`,
        threadId: String(threadId),
        url,
        blob,
        size: blob && blob.size ? blob.size : 0,
        createdAt: now,
        timestamp: now
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
  const tid = String(threadId);
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(VIDEO_STORE_NAME, 'readwrite');
      const store = tx.objectStore(VIDEO_STORE_NAME);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      // video_blobs key format is `${threadId}:${index}` — use a primary-key range.
      const range = IDBKeyRange.bound(`${tid}:`, `${tid}:\uffff`);
      store.delete(range);
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

// ---------- images ----------

/**
 * Store a single image blob for a thread.
 */
async function addImage(threadId, index, blob, mimeType) {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IMAGE_STORE_NAME);
      const record = {
        key: `${threadId}:${index}`,
        threadId: String(threadId),
        index,
        blob,
        mimeType,
        size: blob && blob.size ? blob.size : 0,
        createdAt: Date.now()
      };
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Batch store multiple image blobs for one thread in a single readwrite transaction.
 */
async function addImages(threadId, items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IMAGE_STORE_NAME);
      let count = 0;
      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      const tid = String(threadId);
      const now = Date.now();
      for (const it of items) {
        if (!it || it.blob == null) continue;
        store.put({
          key: `${tid}:${it.index}`,
          threadId: tid,
          index: it.index,
          blob: it.blob,
          mimeType: it.mimeType,
          size: it.blob.size || 0,
          createdAt: now
        });
        count++;
      }
    });
  });
}

/**
 * Fetch all image records for a thread, sorted by index ascending.
 */
async function getImagesForThread(threadId) {
  const tid = String(threadId);
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGE_STORE_NAME, 'readonly');
      const store = tx.objectStore(IMAGE_STORE_NAME);
      // image_blobs key format is `${threadId}:${index}` — use a primary-key range.
      const range = IDBKeyRange.bound(`${tid}:`, `${tid}:\uffff`);
      const req = store.getAll(range);
      req.onsuccess = () => {
        const rows = Array.isArray(req.result) ? req.result : [];
        rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        resolve(rows.map((v) => ({ index: v.index, blob: v.blob, mimeType: v.mimeType })));
      };
      req.onerror = () => reject(req.error);
    });
  });
}

/**
 * Delete all image blobs for a thread in a single readwrite transaction.
 */
async function deleteImagesForThread(threadId) {
  const tid = String(threadId);
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IMAGE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IMAGE_STORE_NAME);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      const range = IDBKeyRange.bound(`${tid}:`, `${tid}:\uffff`);
      store.delete(range);
    });
  });
}

export {
  openDB, addThread, addThreads, getThread, getAllThreadsMeta,
  deleteThread, deleteAllThreads, searchThreads, getSavedIds, getStorageSize,
  purgeExpiredCaches, purgeUntilUnderLimit, purgeBlobsOverflow,
  addVideoBlob, getVideosByThread, deleteVideosByThread, deleteAllVideos,
  addImage, addImages, getImagesForThread, deleteImagesForThread
};
