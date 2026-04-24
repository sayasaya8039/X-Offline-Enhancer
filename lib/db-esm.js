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

function normalizeAuthor(authorLike, fallbackTweet) {
  if (authorLike && typeof authorLike === 'object' && !Array.isArray(authorLike)) {
    return {
      name: String(authorLike.name ?? fallbackTweet?.author?.name ?? ''),
      handle: String(authorLike.handle ?? authorLike.authorHandle ?? fallbackTweet?.author?.handle ?? ''),
      avatarUrl: String(authorLike.avatarUrl ?? fallbackTweet?.author?.avatarUrl ?? '')
    };
  }
  return {
    name: String(fallbackTweet?.author?.name ?? ''),
    handle: String(authorLike ?? fallbackTweet?.author?.handle ?? ''),
    avatarUrl: String(fallbackTweet?.author?.avatarUrl ?? '')
  };
}

function hasRichSummary(summary) {
  return Boolean(
    summary
    && typeof summary === 'object'
    && summary.primaryAuthor
    && typeof summary.primaryAuthor === 'object'
  );
}

function computeSummary(thread) {
  const tweets = Array.isArray(thread?.tweets) ? thread.tweets : [];
  const primary = tweets.find(Boolean) || null;
  return {
    primaryAuthor: normalizeAuthor(primary?.author, primary),
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
  const normalizedSummary = hasRichSummary(rec.summary)
    ? {
        ...rec.summary,
        primaryAuthor: normalizeAuthor(rec.summary.primaryAuthor, Array.isArray(rec.tweets) ? rec.tweets.find(Boolean) : null)
      }
    : computeSummary(rec);
  return {
    id: rec.id,
    timestamp: rec.timestamp,
    savedAt: rec.savedAt ?? rec.timestamp,
    updatedAt: rec.updatedAt ?? rec.timestamp,
    tags: rec.tags,
    url: rec.url,
    integrity: rec.integrity,
    summary: normalizedSummary
  };
}

function normalizeVideoRecordIndex(record) {
  const directIndex = Number(record?.index);
  if (Number.isFinite(directIndex)) return directIndex;

  const legacyMatch = String(record?.id || '').match(/:(\d+)$/);
  if (!legacyMatch) return null;

  const parsedIndex = Number(legacyMatch[1]);
  return Number.isFinite(parsedIndex) ? parsedIndex : null;
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

        // Collect per-record migration failures so a single bad row does not
        // abort the whole upgrade. Errors are reported via chrome.storage.local
        // when tx.oncomplete fires so the service worker can surface them.
        const migrationErrors = [];

        // Migrate existing threads: compute summary + searchTokens if missing
        try {
          const cursorReq = threadStore.openCursor();
          cursorReq.onerror = (e) => {
            migrationErrors.push({
              store: 'threads',
              error: String(e.target?.error ?? e)
            });
          };
          cursorReq.onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) return;
            try {
              const rec = cursor.value;
              let dirty = false;
              if (!rec.summary) { rec.summary = computeSummary(rec); dirty = true; }
              if (!Array.isArray(rec.searchTokens) || rec.searchTokens.length === 0) {
                rec.searchTokens = computeSearchTokens(rec);
                dirty = true;
              }
              if (rec.imageCache) { delete rec.imageCache; dirty = true; }
              if (dirty) {
                const updateReq = cursor.update(rec);
                updateReq.onerror = (ue) => {
                  migrationErrors.push({
                    store: 'threads',
                    key: rec?.id,
                    error: String(ue.target?.error)
                  });
                };
              }
            } catch (err) {
              migrationErrors.push({
                store: 'threads',
                key: cursor.primaryKey,
                error: String(err)
              });
            }
            cursor.continue();
          };
        } catch (err) {
          migrationErrors.push({ store: 'threads', error: String(err) });
        }

        // Migrate existing video blobs: backfill createdAt from timestamp
        try {
          const vCur = videoStore.openCursor();
          vCur.onerror = (e) => {
            migrationErrors.push({
              store: 'video_blobs',
              error: String(e.target?.error ?? e)
            });
          };
          vCur.onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) return;
            try {
              const rec = cursor.value;
              if (typeof rec.createdAt !== 'number') {
                rec.createdAt = typeof rec.timestamp === 'number' ? rec.timestamp : Date.now();
                const updateReq = cursor.update(rec);
                updateReq.onerror = (ue) => {
                  migrationErrors.push({
                    store: 'video_blobs',
                    key: rec?.id,
                    error: String(ue.target?.error)
                  });
                };
              }
            } catch (err) {
              migrationErrors.push({
                store: 'video_blobs',
                key: cursor.primaryKey,
                error: String(err)
              });
            }
            cursor.continue();
          };
        } catch (err) {
          migrationErrors.push({ store: 'video_blobs', error: String(err) });
        }

        // Migrate existing image blobs: ensure createdAt
        try {
          const iCur = imageStore.openCursor();
          iCur.onerror = (e) => {
            migrationErrors.push({
              store: 'image_blobs',
              error: String(e.target?.error ?? e)
            });
          };
          iCur.onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) return;
            try {
              const rec = cursor.value;
              if (typeof rec.createdAt !== 'number') {
                rec.createdAt = Date.now();
                const updateReq = cursor.update(rec);
                updateReq.onerror = (ue) => {
                  migrationErrors.push({
                    store: 'image_blobs',
                    key: rec?.key,
                    error: String(ue.target?.error)
                  });
                };
              }
            } catch (err) {
              migrationErrors.push({
                store: 'image_blobs',
                key: cursor.primaryKey,
                error: String(err)
              });
            }
            cursor.continue();
          };
        } catch (err) {
          migrationErrors.push({ store: 'image_blobs', error: String(err) });
        }

        tx.oncomplete = () => {
          if (migrationErrors.length === 0) return;
          try {
            if (typeof chrome !== 'undefined' && chrome?.storage?.local?.set) {
              chrome.storage.local.set({
                __xoe_migration_v4_partial: true,
                __xoe_migration_v4_errors: migrationErrors.slice(0, 100),
                __xoe_migration_v4_completed_at: Date.now()
              });
            }
            console.warn('[XOE] v4 migration completed with errors:', migrationErrors.length);
          } catch (_) { /* chrome.storage unavailable */ }
        };
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
      const tx = db.transaction([STORE_NAME, IMAGE_STORE_NAME], 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      tx.objectStore(STORE_NAME).clear();
      tx.objectStore(IMAGE_STORE_NAME).clear();
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
        index,
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
        results.push({
          ...cursor.value,
          index: normalizeVideoRecordIndex(cursor.value)
        });
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
async function addImages(threadId, items, options = {}) {
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
      const precondition = typeof options.precondition === 'function'
        ? options.precondition
        : null;
      if (precondition && precondition() === false) {
        return;
      }
      if (options.replaceExisting === true) {
        const range = IDBKeyRange.bound(`${tid}:`, `${tid}:\uffff`);
        store.delete(range);
      }
      for (const it of items) {
        if (!it || it.blob == null) continue;
        if (precondition && precondition() === false) {
          return;
        }
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

// ---------- Backup / Restore (export-import) ----------

const EXPORT_SCHEMA_VERSION = 1;
const IMPORT_VALIDATION_LIMITS = Object.freeze({
  maxThreads: 10000,
  maxImages: 20000,
  maxVideos: 5000,
  maxImageBase64Chars: 16 * 1024 * 1024,
  maxVideoBase64Chars: 128 * 1024 * 1024,
  maxTotalBase64Chars: 256 * 1024 * 1024
});
const IMPORT_INVALID_MESSAGE = 'Invalid import data';
const IMPORT_LIMIT_MESSAGE = 'Import data exceeds supported limits';
const ALLOWED_IMPORT_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);
const ALLOWED_IMPORT_VIDEO_MIME_TYPES = new Set(['video/mp4']);
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000; // 32KB ずつで fromCharCode stack overflow を回避
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBlob(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}

function failInvalidImport() {
  throw new Error(IMPORT_INVALID_MESSAGE);
}

function failImportLimit() {
  throw new Error(IMPORT_LIMIT_MESSAGE);
}

function requireImportArray(value) {
  if (!Array.isArray(value)) failInvalidImport();
  return value;
}

function assertImportCountWithinLimit(count, max) {
  if (count > max) failImportLimit();
}

function normalizeImportMimeType(value, allowedTypes) {
  if (typeof value !== 'string') failInvalidImport();
  const mimeType = value.trim().toLowerCase();
  if (!allowedTypes.has(mimeType)) failInvalidImport();
  return mimeType;
}

function normalizeImportIndex(value) {
  const index = Number(value);
  if (!Number.isSafeInteger(index)) failInvalidImport();
  return index;
}

function validateBase64ImportData(value, maxChars, total) {
  if (typeof value !== 'string') failInvalidImport();
  if (value.length === 0 || value.length > maxChars) failImportLimit();
  total.count += value.length;
  if (total.count > IMPORT_VALIDATION_LIMITS.maxTotalBase64Chars) failImportLimit();
  if (value.length % 4 !== 0 || !BASE64_RE.test(value)) failInvalidImport();
  return value;
}

function normalizeImportThreadId(value) {
  if (typeof value !== 'string' || value.trim() === '') failInvalidImport();
  return value;
}

function normalizedHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

function isAllowedYoutubeExternalUrl(parsed, host) {
  if (host === 'youtu.be') return /^\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname);
  if (host === 'youtube-nocookie.com') {
    return /^\/embed\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname);
  }
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    return (parsed.pathname === '/watch' && parsed.searchParams.has('v'))
      || /^\/(?:shorts|embed)\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname);
  }
  return false;
}

function isAllowedXExternalVideoUrl(parsed, host) {
  if (host !== 'x.com' && host !== 'twitter.com') return false;
  return /\/status\/\d+\/video\/\d+\/?$/.test(parsed.pathname);
}

function sanitizeExternalVideoUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
    const host = normalizedHost(parsed.hostname);
    if (isAllowedYoutubeExternalUrl(parsed, host) || isAllowedXExternalVideoUrl(parsed, host)) {
      return parsed.href;
    }
  } catch {}
  return null;
}

function sanitizeStoredVideoUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || normalizedHost(parsed.hostname) !== 'video.twimg.com') {
      return '';
    }
    return /\.mp4(?:[?#]|$)/.test(parsed.href) ? parsed.href : '';
  } catch {}
  return '';
}

function copyWithSanitizedExternalVideoUrl(record) {
  const copy = { ...record };
  if (Object.prototype.hasOwnProperty.call(record, 'externalVideoUrl')) {
    copy.externalVideoUrl = sanitizeExternalVideoUrl(record.externalVideoUrl);
  }
  return copy;
}

function validateThreadForImport(thread) {
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) failInvalidImport();
  if (typeof thread.id !== 'string' || thread.id.trim() === '') failInvalidImport();
  if (thread.tweets != null && !Array.isArray(thread.tweets)) failInvalidImport();

  const clean = copyWithSanitizedExternalVideoUrl(thread);
  if (Array.isArray(thread.tweets)) {
    clean.tweets = thread.tweets.map((tweet) => {
      if (!tweet || typeof tweet !== 'object' || Array.isArray(tweet)) failInvalidImport();
      return copyWithSanitizedExternalVideoUrl(tweet);
    });
  }
  return clean;
}

function validateImageForImport(img, total) {
  if (!img || typeof img !== 'object' || Array.isArray(img)) failInvalidImport();
  return {
    threadId: normalizeImportThreadId(img.threadId),
    index: normalizeImportIndex(img.index),
    mimeType: normalizeImportMimeType(img.mimeType, ALLOWED_IMPORT_IMAGE_MIME_TYPES),
    data: validateBase64ImportData(
      img.data,
      IMPORT_VALIDATION_LIMITS.maxImageBase64Chars,
      total
    )
  };
}

function validateVideoForImport(video, total) {
  if (!video || typeof video !== 'object' || Array.isArray(video)) failInvalidImport();
  return {
    threadId: normalizeImportThreadId(video.threadId),
    index: normalizeImportIndex(video.index),
    url: sanitizeStoredVideoUrl(video.url),
    mimeType: normalizeImportMimeType(video.mimeType, ALLOWED_IMPORT_VIDEO_MIME_TYPES),
    data: validateBase64ImportData(
      video.data,
      IMPORT_VALIDATION_LIMITS.maxVideoBase64Chars,
      total
    )
  };
}

function validateImportDump(dump) {
  const threads = requireImportArray(dump.threads);
  const images = requireImportArray(dump.images);
  const videos = requireImportArray(dump.videos);
  assertImportCountWithinLimit(threads.length, IMPORT_VALIDATION_LIMITS.maxThreads);
  assertImportCountWithinLimit(images.length, IMPORT_VALIDATION_LIMITS.maxImages);
  assertImportCountWithinLimit(videos.length, IMPORT_VALIDATION_LIMITS.maxVideos);

  const totalBase64Chars = { count: 0 };
  return {
    threads: threads.map(validateThreadForImport),
    images: images.map((img) => validateImageForImport(img, totalBase64Chars)),
    videos: videos.map((video) => validateVideoForImport(video, totalBase64Chars))
  };
}

function getAllFromStore(storeName) {
  return withRetry(async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  });
}

/**
 * 全スレッド・画像 blob・動画 blob をダンプした単一オブジェクトを返す。
 * blob は base64 (data 部のみ) で埋め込み、mime type は別フィールドに保持。
 *
 * 呼び出し側で JSON.stringify してファイル保存する想定。
 */
async function exportAll({ onProgress } = {}) {
  const [threads, imageRecs, videoRecs] = await Promise.all([
    getAllFromStore(STORE_NAME),
    getAllFromStore(IMAGE_STORE_NAME),
    getAllFromStore(VIDEO_STORE_NAME)
  ]);

  const total = imageRecs.length + videoRecs.length;
  let done = 0;
  const report = (stage) => {
    done++;
    if (onProgress && total > 0) onProgress({ stage, done, total });
  };

  const images = [];
  for (const r of imageRecs) {
    if (!r?.blob) { report('image'); continue; }
    try {
      const b64 = await blobToBase64(r.blob);
      images.push({
        threadId: String(r.threadId),
        index: r.index,
        mimeType: r.mimeType || r.blob.type || 'image/jpeg',
        size: r.size || r.blob.size || 0,
        data: b64
      });
    } catch {}
    report('image');
  }

  const videos = [];
  for (const r of videoRecs) {
    if (!r?.blob) { report('video'); continue; }
    try {
      const b64 = await blobToBase64(r.blob);
      videos.push({
        threadId: String(r.threadId),
        index: r.index,
        url: r.url || '',
        mimeType: r.blob.type || 'video/mp4',
        size: r.size || r.blob.size || 0,
        data: b64
      });
    } catch {}
    report('video');
  }

  return {
    xoeExportVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      threads: threads.length,
      images: images.length,
      videos: videos.length
    },
    threads,
    images,
    videos
  };
}

/**
 * exportAll() が返したオブジェクト (または同形の JSON) を受け取り、
 * IndexedDB に復元する。既存レコードは上書き (put)。
 * 返り値は { threads, images, videos } の書き込み件数。
 */
async function importAll(dump, { onProgress } = {}) {
  if (!dump || typeof dump !== 'object' || Array.isArray(dump)) throw new Error(IMPORT_INVALID_MESSAGE);
  if (dump.xoeExportVersion !== EXPORT_SCHEMA_VERSION) {
    throw new Error('unsupported export version: ' + dump.xoeExportVersion);
  }

  const { threads, images, videos } = validateImportDump(dump);
  const total = threads.length + images.length + videos.length;
  let done = 0;
  const report = (stage) => {
    done++;
    if (onProgress && total > 0) onProgress({ stage, done, total });
  };

  let threadCount = 0;
  for (const t of threads) {
    if (!t || typeof t.id !== 'string') { report('thread'); continue; }
    try {
      await addThread(t);
      threadCount++;
    } catch {}
    report('thread');
  }

  // 画像をスレッド毎にまとめて addImages に渡す
  const imagesByThread = new Map();
  for (const img of images) {
    if (!img?.data || !img.threadId) continue;
    const list = imagesByThread.get(img.threadId) || [];
    list.push({
      index: img.index,
      blob: base64ToBlob(img.data, img.mimeType),
      mimeType: img.mimeType
    });
    imagesByThread.set(img.threadId, list);
  }
  let imageCount = 0;
  for (const [tid, items] of imagesByThread) {
    try {
      const n = await addImages(tid, items);
      imageCount += n || 0;
    } catch {}
    for (let i = 0; i < items.length; i++) report('image');
  }

  let videoCount = 0;
  for (const v of videos) {
    if (!v?.data || !v.threadId) { report('video'); continue; }
    try {
      const blob = base64ToBlob(v.data, v.mimeType);
      await addVideoBlob(v.threadId, v.index, blob, v.url || '');
      videoCount++;
    } catch {}
    report('video');
  }

  return { threads: threadCount, images: imageCount, videos: videoCount };
}

export {
  openDB, addThread, addThreads, getThread, getAllThreadsMeta,
  deleteThread, deleteAllThreads, searchThreads, getSavedIds, getStorageSize,
  purgeExpiredCaches, purgeUntilUnderLimit, purgeBlobsOverflow,
  addVideoBlob, getVideosByThread, deleteVideosByThread, deleteAllVideos,
  addImage, addImages, getImagesForThread, deleteImagesForThread,
  exportAll, importAll
};
