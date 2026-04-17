/**
 * Service Worker for X Offline Enhancer
 * Manifest V3 background script (ES module)
 */

import {
  addThread, getThread, deleteThread, deleteAllThreads,
  searchThreads, getSavedIds, getStorageSize,
  purgeExpiredCaches, purgeUntilUnderLimit, purgeBlobsOverflow,
  addImages,
  addVideoBlob, deleteVideosByThread, deleteAllVideos
} from './lib/db-esm.js';
import { validateThreadForStorage } from './lib/thread-model.mjs';
import { logSW } from './lib/utils-esm.js';

console.log('[XOE-SW] Service worker loaded');

// ─── Referer ヘッダ注入 (video.twimg.com) ────────────────────
// 拡張の service worker から直接 fetch すると Referer が空のため、
// X CDN が anti-hotlink で小さなスタブ(904 bytes 等)を返す。
// DNR で extension origin → twitter.com Referer に書き換える。
async function ensureVideoRefererRule() {
  try {
    // 既存ルールを常に削除して最新定義で置換する (旧バージョンの誤ったルールを一掃)
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1001],
      addRules: [{
        id: 1001,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: 'https://twitter.com/' }
          ]
        },
        condition: {
          urlFilter: '||video.twimg.com/',
          // tabIds: [-1] = タブ非経由 (= 拡張 service worker 発) のみ。
          // X ページ自身の動画リクエスト (タブ発) には影響しない。
          tabIds: [-1],
          resourceTypes: ['xmlhttprequest', 'media', 'other']
        }
      }]
    });
    console.log('[XOE-SW] video.twimg.com Referer rule installed');
  } catch (err) {
    console.warn('[XOE-SW] DNR rule setup failed:', err?.message || err);
  }
}
ensureVideoRefererRule();
chrome.runtime.onStartup?.addListener?.(ensureVideoRefererRule);
chrome.runtime.onInstalled?.addListener?.(ensureVideoRefererRule);

// ─── Helpers ────────────────────────────────────────────────

function isXUrl(url) {
  return url && (url.startsWith('https://twitter.com') || url.startsWith('https://x.com') || url.startsWith('https://pro.x.com'));
}

const DEFAULT_CACHE_SETTINGS = {
  cacheLimitMB: 200,
  cacheTTLDays: 30
};

async function getCacheSettings() {
  const result = await chrome.storage.local.get('cacheSettings');
  return { ...DEFAULT_CACHE_SETTINGS, ...result.cacheSettings };
}

// ─── Cache Cleanup ──────────────────────────────────────────

async function runCacheCleanup() {
  console.log('[XOE-SW] Running cache cleanup...');
  const settings = await getCacheSettings();
  let totalPurged = 0;

  if (settings.cacheTTLDays > 0) {
    const r = await purgeExpiredCaches(settings.cacheTTLDays);
    totalPurged += r.purged;
    if (r.purged > 0) console.log('[XOE-SW] Purged expired image caches for:', r.purged, 'thread records');
  }

  if (settings.cacheLimitMB > 0) {
    const limitBytes = settings.cacheLimitMB * 1024 * 1024;
    const r = await purgeUntilUnderLimit(limitBytes);
    totalPurged += r.purged;
    if (r.purged > 0) console.log('[XOE-SW] Purged over-limit image caches for:', r.purged, 'thread records');
  }

  if (totalPurged > 0) {
    broadcastToExtension({ type: 'CACHE_CLEANED', purged: totalPurged });
  }
  console.log('[XOE-SW] Cleanup done. Total purged:', totalPurged);
  return totalPurged;
}

// Debounced cleanup: collapse rapid SAVE_THREAD bursts into one run per minute.
// chrome.alarms.create overwrites any existing alarm with the same name, which
// gives us debounce semantics without a live setTimeout that the SW termination
// would cancel.
function scheduleCleanup() {
  chrome.alarms.create('cache-cleanup-debounce', { delayInMinutes: 1 });
}

async function runDebouncedCleanup() {
  const settings = await getCacheSettings();
  try {
    const r = await purgeBlobsOverflow({
      maxBytes: Math.max(0, settings.cacheLimitMB) * 1024 * 1024,
      maxAgeDays: settings.cacheTTLDays
    });
    const purged = r && typeof r.purged === 'number' ? r.purged : 0;
    if (purged > 0) {
      broadcastToExtension({ type: 'CACHE_CLEANED', purged });
    }
  } catch (err) {
    console.warn('[XOE-SW] Debounced cleanup error:', err.message);
  }
}

// ─── Side Panel Setup ───────────────────────────────────────

if (chrome.sidePanel) {
  chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .then(() => console.log('[XOE-SW] openPanelOnActionClick set'))
    .catch((err) => console.error('[XOE-SW] setPanelBehavior failed:', err));
} else {
  console.error('[XOE-SW] chrome.sidePanel API not available');
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only react to URL/status transitions — skip noisy events like title/favicon/audible.
  if (!changeInfo.url && !changeInfo.status) return;
  if (!chrome.sidePanel) return;
  // Only configure the side panel for X/Twitter tabs.
  if (!isXUrl(tab?.url)) return;
  try {
    chrome.sidePanel.setOptions({
      tabId,
      path: 'sidepanel.html',
      enabled: true
    });
  } catch {}
});

// ─── Install & Alarms ───────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[XOE-SW] Extension installed/updated');

  // Enable side panel for existing X tabs
  if (chrome.sidePanel) {
    try {
      const tabs = await chrome.tabs.query({ url: ['https://twitter.com/*', 'https://x.com/*', 'https://pro.x.com/*'] });
      for (const tab of tabs) {
        chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true });
      }
      console.log('[XOE-SW] Enabled side panel for', tabs.length, 'existing X tabs');
    } catch {}
  }

  // Set up periodic cache cleanup alarm (every 6 hours)
  chrome.alarms.create('cache-cleanup', { periodInMinutes: 360 });
  console.log('[XOE-SW] Cache cleanup alarm created (every 6h)');

  // Run initial cleanup
  runCacheCleanup().catch((err) => console.error('[XOE-SW] Initial cleanup error:', err));
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith('pdf-gc:')) {
    const storageKey = alarm.name.slice('pdf-gc:'.length);
    try {
      await chrome.storage.session.remove(storageKey);
      console.log('[XOE-SW] PDF GC removed stale entry:', storageKey);
    } catch (e) {
      console.warn('[XOE-SW] PDF GC remove failed', e);
    }
    return;
  }
  if (alarm.name === 'cache-cleanup') {
    runCacheCleanup().catch((err) => console.error('[XOE-SW] Alarm cleanup error:', err));
  } else if (alarm.name === 'cache-cleanup-debounce') {
    runDebouncedCleanup().catch((err) => console.warn('[XOE-SW] Debounced alarm error:', err.message));
  } else if (alarm.name === 'offscreen-idle-close') {
    await closeOffscreenDocument();
  }
});

// ─── Offscreen Document Management ─────────────────────────

let offscreenCreating = null;

async function ensureOffscreenDocument() {
  // New PDF generation extends the offscreen lifetime — cancel any pending idle-close.
  try { await chrome.alarms.clear('offscreen-idle-close'); } catch {}

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) return;

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  try {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'PDF generation requires DOM rendering for html2canvas'
    });
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

async function closeOffscreenDocument() {
  try { await chrome.offscreen.closeDocument(); } catch {}
}

// Schedule idle close 5 minutes after last PDF completion. Any new
// ensureOffscreenDocument() call clears this alarm so the doc is kept alive
// through back-to-back exports without recreating the DOM each time.
function scheduleOffscreenIdleClose() {
  chrome.alarms.create('offscreen-idle-close', { delayInMinutes: 5 });
}

// ─── Message Routing ────────────────────────────────────────

const ALLOWED_ORIGINS = ['https://twitter.com', 'https://x.com', 'https://pro.x.com'];
const BROADCAST_TYPES = new Set([
  'THREAD_SAVED', 'THREAD_DELETED', 'THREADS_DELETED', 'ALL_THREADS_DELETED',
  'PDF_READY', 'CACHE_CLEANED', 'VIDEOS_SAVED'
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;
  if (BROADCAST_TYPES.has(message.type)) return;
  if (message.type === 'GENERATE_PDF') return;

  console.log('[XOE-SW] Received:', message.type);

  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error('[XOE-SW] Error:', message.type, err.message);
      sendResponse({ error: err.message });
    });
  return true;
});

async function handleMessage(message, sender) {
  if (sender.tab) {
    const tabUrl = sender.tab.url || '';
    if (!ALLOWED_ORIGINS.some(o => tabUrl.startsWith(o))) {
      throw new Error('Unauthorized origin');
    }
  }

  switch (message.type) {

    case 'SAVE_THREAD': {
      const thread = message.data;
      if (!thread || typeof thread.id !== 'string' || !/^\d+$/.test(thread.id)) {
        throw new Error('Invalid thread id');
      }
      if (!Array.isArray(thread.tweets)) {
        throw new Error('Invalid tweets data');
      }
      const validation = validateThreadForStorage(thread);
      if (!validation.ok) {
        throw new Error(validation.error);
      }
      delete thread.htmlContent;
      // Legacy base64 payload — storage layer strips imageCache but be explicit.
      delete thread.imageCache;
      thread.integrity = validation.integrity;
      thread.timestamp = thread.timestamp || Date.now();

      const pendingImageUrls = Array.isArray(thread.imageUrls) ? thread.imageUrls : [];
      let imagesSaved = 0;

      await addThread(thread);
      if (pendingImageUrls.length > 0) {
        imagesSaved = await fetchAndStoreImages(thread.id, pendingImageUrls);
        if (imagesSaved > 0) {
          broadcastToExtension({ type: 'THREAD_IMAGES_READY', threadId: thread.id, saved: imagesSaved });
        }
      }
      console.log('[XOE-SW] Thread saved:', thread.id, 'tweets:', thread.tweets.length,
                  'imageUrls:', pendingImageUrls.length, 'imagesSaved:', imagesSaved);

      if (sender.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'SAVE_COMPLETE', id: thread.id
        }).catch(() => {});
      }
      broadcastToExtension({ type: 'THREAD_SAVED', threadId: thread.id, imagesSaved });

      // Debounced cleanup: collapse rapid saves into one run per minute.
      scheduleCleanup();

      return {
        success: true,
        id: thread.id,
        imagesSaved,
        imageFetch: pendingImageUrls.length > 0 ? 'done' : 'none'
      };
    }

    case 'DELETE_THREAD': {
      if (!message.threadId || typeof message.threadId !== 'string') {
        throw new Error('Missing or invalid threadId');
      }
      await deleteThread(message.threadId);
      await deleteVideosByThread(message.threadId).catch(() => {});
      broadcastToExtension({ type: 'THREAD_DELETED', threadId: message.threadId });
      return { success: true };
    }

    case 'DELETE_ALL_THREADS': {
      if (sender.tab) throw new Error('DELETE_ALL not allowed from content script');
      await deleteAllThreads();
      await deleteAllVideos().catch(() => {});
      broadcastToExtension({ type: 'ALL_THREADS_DELETED' });
      return { success: true };
    }

    case 'GET_THREAD': {
      if (!message.threadId) throw new Error('Missing threadId');
      const thread = await getThread(message.threadId);
      return { success: true, thread };
    }

    case 'SEARCH_THREADS': {
      if (!message.query || typeof message.query !== 'string') {
        throw new Error('Missing or invalid search query');
      }
      const results = await searchThreads(message.query);
      return { success: true, threads: results };
    }

    case 'CHECK_SAVED': {
      if (!message.id) return { saved: false };
      const found = await getThread(message.id);
      return { saved: !!found };
    }

    case 'GET_SAVED_IDS': {
      const ids = await getSavedIds();
      return { success: true, ids };
    }

    case 'GET_STORAGE_SIZE': {
      const size = await getStorageSize();
      return { success: true, ...size };
    }

    case 'RUN_CLEANUP': {
      if (sender.tab) throw new Error('RUN_CLEANUP not allowed from content script');
      const purged = await runCacheCleanup();
      return { success: true, purged };
    }

    case 'FETCH_VIDEOS': {
      if (sender.tab) {
        const tabUrl = sender.tab.url || '';
        if (!ALLOWED_ORIGINS.some(o => tabUrl.startsWith(o))) {
          throw new Error('Unauthorized origin');
        }
      }
      const { threadId, videoUrls } = message;
      if (!threadId || !Array.isArray(videoUrls)) {
        throw new Error('Invalid FETCH_VIDEOS params');
      }
      const senderTabId = sender?.tab?.id ?? null;
      const saved = await fetchAndStoreVideos(threadId, videoUrls, senderTabId);
      if (saved > 0) {
        broadcastToExtension({ type: 'VIDEOS_SAVED', threadId, saved });
      }
      return { success: true, saved };
    }

    case 'EXPORT_PDF': {
      return await handleExportPDF(message);
    }

    case 'PDF_GENERATED': {
      // PDF payload lives in chrome.storage.session under message.storageKey.
      // Never relay base64 through the message bus — large payloads blow past
      // the structured-clone budget and stall the SW.
      if (message.storageKey) {
        try {
          await chrome.alarms.create(`pdf-gc:${message.storageKey}`, { delayInMinutes: 10 });
        } catch (e) {
          console.warn('[XOE-SW] Failed to schedule PDF GC alarm', e);
        }
      }
      await chrome.runtime.sendMessage({
        type: 'PDF_READY',
        threadId: message.threadId,
        storageKey: message.storageKey,
        filename: message.filename,
        size: message.size
      }).catch(() => {});
      scheduleOffscreenIdleClose();
      return { success: true };
    }

    case 'PDF_CONSUMED': {
      if (typeof message.storageKey === 'string') {
        await chrome.alarms.clear(`pdf-gc:${message.storageKey}`).catch(() => {});
      }
      return { success: true };
    }

    case 'PDF_ERROR': {
      await chrome.runtime.sendMessage({
        type: 'PDF_READY',
        threadId: message.threadId,
        error: message.error
      }).catch(() => {});
      scheduleOffscreenIdleClose();
      return { success: true };
    }

    case 'NOTIFY_THREAD_DELETED': {
      if (message.threadId) {
        await broadcastToXTabs({ type: 'THREAD_DELETED', threadId: message.threadId });
      }
      return { success: true };
    }

    case 'NOTIFY_THREADS_DELETED': {
      if (Array.isArray(message.threadIds)) {
        await broadcastToXTabs({ type: 'THREADS_DELETED', threadIds: message.threadIds });
      }
      return { success: true };
    }

    case 'NOTIFY_ALL_DELETED': {
      await broadcastToXTabs({ type: 'ALL_THREADS_DELETED' });
      return { success: true };
    }

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}

// ─── Video Fetch & Store ────────────────────────────────────

const ALLOWED_VIDEO_HOSTS = ['video.twimg.com'];
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB per video
const VIDEO_FETCH_TIMEOUT_MS = 60_000;
const VIDEO_FETCH_CONCURRENCY = 2;

function isAllowedVideoUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (!ALLOWED_VIDEO_HOSTS.includes(parsed.hostname)) return false;
    if (!/\.mp4$/i.test(parsed.pathname)) return false;
    // ext_tw_video / amplify_video は /vid/、tweet_video (GIF) は /tweet_video/
    return parsed.pathname.includes('/vid/') || parsed.pathname.includes('/tweet_video/');
  }
  catch { return false; }
}

async function fetchVideoWithTimeout(url, timeoutMs = VIDEO_FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const contentType = resp.headers.get('content-type') || '';
    if (!/^video\//i.test(contentType)) {
      throw new Error('unexpected content-type: ' + contentType);
    }
    // Reject before streaming the body when the server advertises a size over
    // MAX_VIDEO_BYTES. Saves us from buffering 50MB+ just to discard it.
    const cl = resp.headers.get('content-length');
    if (cl) {
      const n = Number(cl);
      if (Number.isFinite(n) && n > MAX_VIDEO_BYTES) {
        ac.abort();
        throw new Error('content-length exceeds limit: ' + n);
      }
    }
    const blob = await resp.blob();
    if (blob.size > MAX_VIDEO_BYTES) {
      throw new Error('video too large: ' + blob.size);
    }
    // 空/極端に小さい応答は再生不可能 — Referer 無しスタブ/404/空ボディを弾く
    if (blob.size < 10240) {
      throw new Error(`video too small: ${blob.size} bytes (url=${url})`);
    }
    return blob;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeVideoEntries(videoUrls) {
  if (!Array.isArray(videoUrls)) return [];
  return videoUrls
    .map((entry, idx) => {
      if (typeof entry === 'string') {
        return { index: idx, urls: [entry] };
      }
      if (!entry || !Array.isArray(entry.urls)) return null;
      const deduped = [...new Set(entry.urls.filter((url) => isAllowedVideoUrl(url)))];
      if (deduped.length === 0) return null;
      return {
        index: Number.isFinite(Number(entry.tweetIdx)) ? Number(entry.tweetIdx) : idx,
        urls: deduped
      };
    })
    .filter(Boolean);
}

// Dedupe concurrent FETCH_VIDEOS for the same thread — prevents two sidepanel
// calls from racing and double-storing identical blobs.
const inFlightVideoFetches = new Map();

// Content Script (ページ内コンテキスト) 経由で動画 fetch するフォールバック。
// SW 直 fetch が X CDN の hotlink 保護で失敗した場合に使用。
async function fetchVideoViaContentScript(url, tabId) {
  if (tabId == null || tabId < 0) throw new Error('no tab id for CS fetch');
  const resp = await chrome.tabs.sendMessage(tabId, { type: 'FETCH_VIDEO_VIA_PAGE', url });
  if (!resp || !resp.ok) {
    throw new Error('CS fetch failed: ' + (resp?.error || 'no response'));
  }
  const binary = atob(resp.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: resp.contentType || 'video/mp4' });
}

async function fetchAndStoreVideos(threadId, videoUrls, tabId = null) {
  const entries = normalizeVideoEntries(videoUrls);
  if (entries.length === 0) return 0;
  console.log('[XOE-SW] fetchAndStoreVideos start', { threadId, entries: entries.length, tabId });

  const existing = inFlightVideoFetches.get(threadId);
  if (existing) return existing;

  const task = (async () => {
    let saved = 0;
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= entries.length) return;
        const entry = entries[i];
        for (const url of entry.urls) {
          let blob = null;
          // 1st: SW fetch (DNR で Referer 注入済み)
          try {
            blob = await fetchVideoWithTimeout(url);
          } catch (err) {
            console.warn('[XOE-SW] SW fetch failed:', url, err.message);
          }
          // 2nd: Content Script 経由 fetch (ページ context = 正規の Referer/Cookie)
          if (!blob && tabId != null) {
            try {
              blob = await fetchVideoViaContentScript(url, tabId);
              console.log('[XOE-SW] CS fetch succeeded:', url, (blob.size / 1024 / 1024).toFixed(1) + 'MB');
            } catch (err) {
              console.warn('[XOE-SW] CS fetch failed:', url, err.message);
            }
          }
          if (blob) {
            try {
              await addVideoBlob(threadId, entry.index, blob, url);
              saved++;
              console.log('[XOE-SW] Video stored:', entry.index, 'size:', (blob.size / 1024 / 1024).toFixed(1) + 'MB');
              break;
            } catch (err) {
              console.warn('[XOE-SW] addVideoBlob failed:', url, err.message);
            }
          }
        }
      }
    };

    const pool = [];
    const n = Math.min(VIDEO_FETCH_CONCURRENCY, entries.length);
    for (let i = 0; i < n; i++) pool.push(worker());
    await Promise.allSettled(pool);
    return saved;
  })();

  inFlightVideoFetches.set(threadId, task);
  try {
    return await task;
  } finally {
    inFlightVideoFetches.delete(threadId);
  }
}

// ─── PDF Export Handler ─────────────────────────────────────

async function handleExportPDF(message) {
  const threadId = message.threadId;
  if (!threadId) throw new Error('Missing threadId for PDF export');

  // Existence check only — offscreen (task #8) reads thread + images from IDB directly.
  const threadData = await getThread(threadId);
  if (!threadData) throw new Error(`Thread not found: ${threadId}`);

  await ensureOffscreenDocument();

  const authorHandle = threadData.tweets?.[0]?.author?.handle || 'unknown';
  const dateStr = new Date(threadData.timestamp).toISOString().slice(0, 10);
  const filename = `${authorHandle}_${dateStr}_${threadId.slice(0, 8)}.pdf`;

  // New payload contract: no threadData — offscreen fetches from IDB.
  chrome.runtime.sendMessage({
    type: 'GENERATE_PDF', threadId, filename
  }).catch(() => {});

  return { success: true, message: 'PDF generation started' };
}

// ─── Image Fetch & Store ────────────────────────────────────

const ALLOWED_IMAGE_HOSTS = ['pbs.twimg.com', 'abs.twimg.com'];
const IMAGE_FETCH_CONCURRENCY = 3;
const IMAGE_FETCH_TIMEOUT_MS = 30000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB per image

function isAllowedImageUrl(url) {
  if (!url) return false;
  try { return ALLOWED_IMAGE_HOSTS.includes(new URL(url).hostname); }
  catch { return false; }
}

async function fetchImageWithTimeout(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const blob = await resp.blob();
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('image too large: ' + blob.size);
    return blob;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch an array of image URLs in parallel (3-way semaphore), then persist
 * successful results as Blobs via addImages() in a single rw transaction.
 *
 * Input items are `{ tweetIdx, imgIdx, url }` from content_script.js. The
 * index stored in image_blobs is a composite integer `tweetIdx * 10000 + imgIdx`
 * so offscreen/sidepanel can decode it back to tweet/image coordinates.
 */
async function fetchAndStoreImages(threadId, imageUrls) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return 0;

  const results = new Array(imageUrls.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= imageUrls.length) return;
      const entry = imageUrls[i];
      if (!entry || !entry.url) continue;
      if (!isAllowedImageUrl(entry.url)) {
        console.warn('[XOE-SW] Image URL not allowed:', entry.url);
        continue;
      }
      try {
        const blob = await fetchImageWithTimeout(entry.url);
        const tIdx = Number(entry.tweetIdx);
        const iIdx = Number(entry.imgIdx);
        const index = (Number.isFinite(tIdx) && Number.isFinite(iIdx))
          ? (tIdx * 10000) + iIdx
          : (Number.isFinite(Number(entry.index)) ? Number(entry.index) : i);
        results[i] = {
          index,
          blob,
          mimeType: blob.type || 'image/jpeg'
        };
      } catch (err) {
        console.warn('[XOE-SW] Image fetch failed:', entry.url, err.message);
      }
    }
  };

  try {
    const pool = [];
    const n = Math.min(IMAGE_FETCH_CONCURRENCY, imageUrls.length);
    for (let i = 0; i < n; i++) pool.push(worker());
    await Promise.allSettled(pool);

    const ready = results.filter(Boolean);
    if (ready.length === 0) {
      console.warn('[XOE-SW] No images fetched successfully for', threadId);
      return 0;
    }
    const stored = await addImages(threadId, ready);
    console.log('[XOE-SW] Stored', stored, '/', imageUrls.length, 'images for', threadId);
    return stored;
  } catch (err) {
    console.warn('[XOE-SW] fetchAndStoreImages failure:', err.message);
    return 0;
  }
}

// ─── Broadcast Helper ───────────────────────────────────────

function broadcastToExtension(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function broadcastToXTabs(message) {
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://twitter.com/*', 'https://x.com/*', 'https://pro.x.com/*']
    });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  } catch {}
}
