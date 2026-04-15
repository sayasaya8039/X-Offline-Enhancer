/**
 * Service Worker for X Offline Enhancer
 * Manifest V3 background script (ES module)
 */

import {
  addThread, getThread, getAllThreads, deleteThread, deleteAllThreads,
  searchThreads, getSavedIds, getStorageSize,
  purgeExpiredCaches, purgeUntilUnderLimit,
  addVideoBlob, deleteVideosByThread, deleteAllVideos
} from './lib/db-esm.js';
import { validateThreadForStorage } from './lib/thread-model.mjs';
import { logSW } from './lib/utils-esm.js';

console.log('[XOE-SW] Service worker loaded');

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
  if (changeInfo.status !== 'complete' || !chrome.sidePanel) return;
  try {
    chrome.sidePanel.setOptions({
      tabId,
      path: 'sidepanel.html',
      enabled: isXUrl(tab.url)
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
  if (alarm.name === 'cache-cleanup') {
    runCacheCleanup().catch((err) => console.error('[XOE-SW] Alarm cleanup error:', err));
  }
});

// ─── Offscreen Document Management ─────────────────────────

let offscreenCreating = null;

async function ensureOffscreenDocument() {
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
      thread.integrity = validation.integrity;
      thread.timestamp = thread.timestamp || Date.now();
      await addThread(thread);
      console.log('[XOE-SW] Thread saved:', thread.id, 'tweets:', thread.tweets.length);

      if (sender.tab?.id) {
        chrome.tabs.sendMessage(sender.tab.id, {
          type: 'SAVE_COMPLETE', id: thread.id
        }).catch(() => {});
      }
      broadcastToExtension({ type: 'THREAD_SAVED', threadId: thread.id });

      // Run cleanup after save (non-blocking)
      runCacheCleanup().catch(() => {});

      return { success: true, id: thread.id };
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

    case 'GET_ALL_THREADS': {
      const threads = await getAllThreads();
      return { success: true, threads };
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
      const saved = await fetchAndStoreVideos(threadId, videoUrls);
      if (saved > 0) {
        broadcastToExtension({ type: 'VIDEOS_SAVED', threadId, saved });
      }
      return { success: true, saved };
    }

    case 'EXPORT_PDF': {
      return await handleExportPDF(message);
    }

    case 'PDF_GENERATED': {
      broadcastToExtension({
        type: 'PDF_READY',
        pdfBase64: message.pdfBase64,
        filename: message.filename
      });
      setTimeout(() => closeOffscreenDocument(), 500);
      return { success: true };
    }

    case 'PDF_ERROR': {
      broadcastToExtension({
        type: 'PDF_READY',
        error: message.error
      });
      setTimeout(() => closeOffscreenDocument(), 500);
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

function isAllowedVideoUrl(url) {
  if (!url) return false;
  try { return ALLOWED_VIDEO_HOSTS.includes(new URL(url).hostname); }
  catch { return false; }
}

async function fetchAndStoreVideos(threadId, videoUrls) {
  let saved = 0;
  for (let i = 0; i < videoUrls.length; i++) {
    const url = videoUrls[i];
    if (!isAllowedVideoUrl(url)) continue;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn('[XOE-SW] Video fetch HTTP', resp.status, url);
        continue;
      }
      const blob = await resp.blob();
      if (blob.size > MAX_VIDEO_BYTES) {
        console.warn('[XOE-SW] Video too large:', blob.size, url);
        continue;
      }
      await addVideoBlob(threadId, i, blob, url);
      saved++;
      console.log('[XOE-SW] Video stored:', i, 'size:', (blob.size / 1024 / 1024).toFixed(1) + 'MB');
    } catch (err) {
      console.warn('[XOE-SW] Video fetch failed:', url, err.message);
    }
  }
  return saved;
}

// ─── PDF Export Handler ─────────────────────────────────────

async function handleExportPDF(message) {
  const threadId = message.threadId;
  if (!threadId) throw new Error('Missing threadId for PDF export');

  const threadData = await getThread(threadId);
  if (!threadData) throw new Error(`Thread not found: ${threadId}`);

  await ensureOffscreenDocument();

  const authorHandle = threadData.tweets?.[0]?.author?.handle || 'unknown';
  const dateStr = new Date(threadData.timestamp).toISOString().slice(0, 10);
  const filename = `${authorHandle}_${dateStr}_${threadId.slice(0, 8)}.pdf`;

  chrome.runtime.sendMessage({
    type: 'GENERATE_PDF', threadData, filename
  }).catch(() => {});

  return { success: true, message: 'PDF generation started' };
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
