/**
 * Side Panel UI for X Offline Enhancer (ES Module)
 */

window.__xoeModuleLoaded = true;

import { getIntegrityMessage, pickPrimaryTweet } from './lib/thread-model.mjs';
import { isAllowedImageUrl } from './lib/utils-esm.js';
import {
  buildImageBlobUrlMap,
  resolveImageSrc,
  resolveAvatarSrc,
  buildVideoBlobMaps,
  resolveVideoSrc
} from './lib/reader-media.mjs';
import {
  getAllThreadsMeta, getThread, deleteThread, deleteAllThreads,
  searchThreads, getStorageSize,
  purgeExpiredCaches, purgeUntilUnderLimit,
  getVideosByThread, deleteVideosByThread, deleteAllVideos,
  getImagesForThread,
  exportAll, importAll
} from './lib/db-esm.js';

console.log('[XOE] Side panel module loaded');

// ─── State ──────────────────────────────────────────────────

let currentView = 'list';
let currentThreadId = null;
let pdfToastTimer = null;
let pdfExporting = false;
let settingsOpen = false;
let selectionMode = false;
const selectedIds = new Set();
const activeVideoBlobUrls = [];
const activeImageBlobUrls = [];

// Virtual scroll state
const VIRT_INITIAL = 100;
const VIRT_PAGE = 50;
let threadsCache = [];
let renderedCount = 0;
let currentQuery = '';
let loadMoreObserver = null;
let sentinelEl = null;

// Reader lazy mount
let readerObserver = null;

// THREAD_SAVED debounce
let threadSavedTimer = null;

// ─── Cache Settings ─────────────────────────────────────────

const DEFAULT_CACHE_SETTINGS = {
  cacheLimitMB: 0,
  cacheTTLDays: 0
};

async function getCacheSettings() {
  const result = await chrome.storage.local.get('cacheSettings');
  return { ...DEFAULT_CACHE_SETTINGS, ...result.cacheSettings };
}

async function saveCacheSettings(settings) {
  await chrome.storage.local.set({ cacheSettings: settings });
}

// ─── DOM refs ───────────────────────────────────────────────

const threadListView = document.getElementById('thread-list-view');
const threadListEl = document.getElementById('thread-list');
const emptyState = document.getElementById('empty-state');
const readerView = document.getElementById('reader-view');
const readerContent = document.getElementById('reader-content');
const searchInput = document.getElementById('search-input');
const storageText = document.getElementById('storage-text');
const storageFill = document.getElementById('storage-fill');
const btnBack = document.getElementById('btn-back');
const btnDeleteAll = document.getElementById('btn-delete-all');
const btnSettings = document.getElementById('btn-settings');
const btnExportPdf = document.getElementById('btn-export-pdf');
const btnDeleteThread = document.getElementById('btn-delete-thread');
const pdfToast = document.getElementById('pdf-toast');
const pdfToastLabel = document.getElementById('pdf-toast-label');
const pdfDownloadLink = document.getElementById('pdf-download-link');
const settingsPanel = document.getElementById('settings-panel');
const cacheLimitSelect = document.getElementById('cache-limit');
const cacheTTLSelect = document.getElementById('cache-ttl');
const btnManualCleanup = document.getElementById('btn-manual-cleanup');
const cleanupStatus = document.getElementById('cleanup-status');
const headerNormal = document.getElementById('header-normal');
const headerSelection = document.getElementById('header-selection');
const btnSelectMode = document.getElementById('btn-select-mode');
const btnCancelSelect = document.getElementById('btn-cancel-select');
const btnSelectAll = document.getElementById('btn-select-all');
const btnDeleteSelected = document.getElementById('btn-delete-selected');
const selectionCountEl = document.getElementById('selection-count');

// Build a trash <svg><use href="#icon-trash"/></svg> once, clone per card
const TRASH_ICON_TEMPLATE = (() => {
  const tmp = document.createElement('div');
  tmp.innerHTML = '<svg width="16" height="16" aria-hidden="true"><use href="#icon-trash"/></svg>';
  return tmp.firstChild;
})();

// ─── Helpers ────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + 'KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + 'MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'GB';
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  const now = new Date();
  const diffMs = Math.max(0, now - d);
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'たった今';
  if (diffMin < 60) return diffMin + '分前';
  if (diffHr < 24) return diffHr + '時間前';
  if (diffDay < 7) return diffDay + '日前';

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y === now.getFullYear() ? `${m}/${day}` : `${y}/${m}/${day}`;
}

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

function escapeAttr(v) {
  // CSS.escape is available in all MV3 targets; fallback for safety
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : String(v).replace(/"/g, '\\"');
}

function appendIntegrityBadge(container, integrity) {
  if (!integrity || integrity.status !== 'partial') return;
  const badge = document.createElement('span');
  badge.className = 'card-tag card-tag-warning';
  badge.textContent = '不完全保存';
  container.appendChild(badge);
}

function renderIntegrityNotice(parent, integrity) {
  const message = getIntegrityMessage(integrity);
  if (!message) return;

  const notice = document.createElement('div');
  notice.className = integrity?.status === 'invalid'
    ? 'reader-integrity reader-integrity-error'
    : 'reader-integrity reader-integrity-warning';
  notice.textContent = message;
  parent.appendChild(notice);
}

// Prefer the pre-computed summary from storage; fall back to primary tweet.
function getThreadSummary(thread) {
  if (thread && thread.summary) return thread.summary;
  const t = pickPrimaryTweet(thread);
  const author = (t && t.author) || {};
  return {
    primaryAuthor: author,
    primaryText: (t && t.text) || '',
    imageCount: (t && t.images) ? t.images.length : 0,
    videoCount: t && t.hasVideo ? 1 : 0
  };
}

// ─── Confirm Dialog (XSS-safe: DOM API only) ───────────────

function showConfirm(title, message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    const titleEl = document.createElement('div');
    titleEl.className = 'confirm-title';
    titleEl.textContent = title;

    const messageEl = document.createElement('div');
    messageEl.className = 'confirm-message';
    messageEl.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn-danger-fill';
    confirmBtn.textContent = '削除';
    confirmBtn.addEventListener('click', () => { overlay.remove(); resolve(true); });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-cancel';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(false); });

    actions.append(confirmBtn, cancelBtn);
    dialog.append(titleEl, messageEl, actions);
    overlay.appendChild(dialog);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(false); }
    });

    document.body.appendChild(overlay);
  });
}

// ─── Storage Display ────────────────────────────────────────

async function updateStorageDisplay() {
  try {
    const { usage, quota } = await getStorageSize();
    const settings = await getCacheSettings();
    const limitBytes = settings.cacheLimitMB > 0
      ? settings.cacheLimitMB * 1024 * 1024
      : Math.min(quota || 500 * 1024 * 1024, 500 * 1024 * 1024);
    storageText.textContent = `${formatBytes(usage)} / ${formatBytes(limitBytes)}`;
    const pct = limitBytes > 0 ? Math.min(usage / limitBytes, 1) : 0;
    // Use transform: scaleX (GPU-composited) instead of width to avoid layout
    storageFill.style.transform = `scaleX(${pct})`;
    if (pct > 0.9) storageFill.style.background = '#f4212e';
    else if (pct > 0.7) storageFill.style.background = '#ffd400';
    else storageFill.style.background = '';
  } catch (err) {
    console.error('[XOE] Storage display error:', err);
    storageText.textContent = '取得不可';
  }
}

// ─── Settings Panel ─────────────────────────────────────────

async function loadSettings() {
  const settings = await getCacheSettings();
  cacheLimitSelect.value = String(settings.cacheLimitMB);
  cacheTTLSelect.value = String(settings.cacheTTLDays);
}

async function onSettingChange() {
  const settings = {
    cacheLimitMB: parseInt(cacheLimitSelect.value, 10),
    cacheTTLDays: parseInt(cacheTTLSelect.value, 10)
  };
  await saveCacheSettings(settings);
  updateStorageDisplay();
}

async function onManualCleanup() {
  btnManualCleanup.disabled = true;
  cleanupStatus.textContent = 'クリーンアップ中…';

  try {
    const settings = await getCacheSettings();
    let totalPurged = 0;

    if (settings.cacheTTLDays > 0) {
      const r = await purgeExpiredCaches(settings.cacheTTLDays);
      totalPurged += r.purged;
    }
    if (settings.cacheLimitMB > 0) {
      const limitBytes = settings.cacheLimitMB * 1024 * 1024;
      const r = await purgeUntilUnderLimit(limitBytes);
      totalPurged += r.purged;
    }

    cleanupStatus.textContent = totalPurged > 0
      ? `${totalPurged}件の画像キャッシュを削除しました`
      : 'クリーンアップ不要です';
    if (currentView === 'list') {
      loadThreadList(searchInput.value.trim());
    }
    updateStorageDisplay();
  } catch (err) {
    console.error('[XOE] Manual cleanup error:', err);
    cleanupStatus.textContent = 'エラーが発生しました';
  }

  btnManualCleanup.disabled = false;
  setTimeout(() => { cleanupStatus.textContent = ''; }, 4000);
}

// ─── Selection Mode ─────────────────────────────────────────

function enterSelectionMode() {
  selectionMode = true;
  selectedIds.clear();
  headerNormal.style.display = 'none';
  headerSelection.style.display = '';
  threadListEl.classList.add('selection-mode');
  threadListEl.classList.remove('all-selected');
  updateSelectionCount();
}

function exitSelectionMode() {
  selectionMode = false;
  selectedIds.clear();
  headerNormal.style.display = '';
  headerSelection.style.display = 'none';
  threadListEl.classList.remove('selection-mode');
  threadListEl.classList.remove('all-selected');
  threadListEl.querySelectorAll('.thread-card.selected').forEach(c => c.classList.remove('selected'));
}

function materializeAllSelected() {
  if (!threadListEl.classList.contains('all-selected')) return;
  threadListEl.classList.remove('all-selected');
  threadListEl.querySelectorAll('.thread-card').forEach(c => {
    if (selectedIds.has(c.dataset.threadId)) c.classList.add('selected');
  });
}

function toggleSelection(threadId, card) {
  // If the fast-path bulk class is active, switch to per-card before toggling.
  materializeAllSelected();
  if (selectedIds.has(threadId)) {
    selectedIds.delete(threadId);
    card.classList.remove('selected');
  } else {
    selectedIds.add(threadId);
    card.classList.add('selected');
  }
  updateSelectionCount();
}

function selectAll() {
  const allIds = threadsCache.map(t => String(t.id));
  const total = allIds.length;
  const isAllSelected = selectedIds.size === total && total > 0;

  if (isAllSelected) {
    selectedIds.clear();
    threadListEl.classList.remove('all-selected');
    threadListEl.querySelectorAll('.thread-card.selected').forEach(c => c.classList.remove('selected'));
  } else {
    selectedIds.clear();
    allIds.forEach(id => selectedIds.add(id));
    // Bulk class avoids O(n) class updates on every card
    threadListEl.classList.add('all-selected');
    threadListEl.querySelectorAll('.thread-card.selected').forEach(c => c.classList.remove('selected'));
  }
  updateSelectionCount();
}

function updateSelectionCount() {
  selectionCountEl.textContent = `${selectedIds.size}件選択`;
  btnDeleteSelected.disabled = selectedIds.size === 0;
  const total = threadsCache.length;
  btnSelectAll.textContent = (selectedIds.size === total && total > 0) ? '全解除' : '全選択';
}

async function deleteSelectedThreads() {
  if (selectedIds.size === 0) return;
  const count = selectedIds.size;
  const ok = await showConfirm(
    `${count}件のスレッドを削除`,
    `選択した${count}件のスレッドを削除しますか？この操作は元に戻せません。`
  );
  if (!ok) return;

  const deletedIds = [...selectedIds];
  // H7: parallel delete (was serial for-await)
  await Promise.all(deletedIds.map(id =>
    Promise.all([
      deleteThread(id),
      deleteVideosByThread(id).catch(() => {})
    ])
  ));
  chrome.runtime.sendMessage({ type: 'NOTIFY_THREADS_DELETED', threadIds: deletedIds }).catch(() => {});
  exitSelectionMode();
  loadThreadList(searchInput.value.trim());
  updateStorageDisplay();
}

// ─── Thread Card Creation (uses summary, cloned trash icon) ──

function createThreadCard(thread, animDelay) {
  const card = document.createElement('div');
  card.className = 'thread-card';
  if (animDelay != null) card.style.animationDelay = `${animDelay}s`;
  card.dataset.threadId = String(thread.id);

  const summary = getThreadSummary(thread);
  const author = summary.primaryAuthor || {};

  const avatarDiv = document.createElement('div');
  avatarDiv.className = 'card-avatar';
  if (author.avatarUrl && isAllowedImageUrl(author.avatarUrl)) {
    const img = document.createElement('img');
    img.src = author.avatarUrl;
    img.alt = '';
    img.loading = 'lazy';
    avatarDiv.appendChild(img);
  }

  const bodyDiv = document.createElement('div');
  bodyDiv.className = 'card-body';

  const headerDiv = document.createElement('div');
  headerDiv.className = 'card-header';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'card-name';
  nameSpan.textContent = author.name || '不明';
  const handleSpan = document.createElement('span');
  handleSpan.className = 'card-handle';
  handleSpan.textContent = author.handle ? '@' + author.handle : '';
  const sepSpan = document.createElement('span');
  sepSpan.className = 'card-separator';
  sepSpan.textContent = '·';
  const dateSpan = document.createElement('span');
  dateSpan.className = 'card-date';
  dateSpan.textContent = formatDate(thread.timestamp);
  headerDiv.append(nameSpan, handleSpan, sepSpan, dateSpan);

  const textDiv = document.createElement('div');
  textDiv.className = 'card-text';
  textDiv.textContent = truncate(summary.primaryText || '', 100);

  const metaDiv = document.createElement('div');
  metaDiv.className = 'card-meta';
  const tagsDiv = document.createElement('div');
  tagsDiv.className = 'card-tags';
  (thread.tags || []).slice(0, 3).forEach(t => {
    const tagSpan = document.createElement('span');
    tagSpan.className = 'card-tag';
    tagSpan.textContent = t;
    tagsDiv.appendChild(tagSpan);
  });
  appendIntegrityBadge(tagsDiv, thread.integrity);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'card-delete';
  deleteBtn.dataset.deleteId = String(thread.id);
  deleteBtn.title = '削除';
  deleteBtn.appendChild(TRASH_ICON_TEMPLATE.cloneNode(true));

  metaDiv.append(tagsDiv, deleteBtn);
  bodyDiv.append(headerDiv, textDiv, metaDiv);
  card.append(avatarDiv, bodyDiv);
  return card;
}

// ─── Thread List Virtual Scroll ─────────────────────────────

function ensureSentinel() {
  if (!sentinelEl) {
    sentinelEl = document.createElement('div');
    sentinelEl.className = 'list-sentinel';
    sentinelEl.style.height = '1px';
  }
  return sentinelEl;
}

function teardownLoadMoreObserver() {
  if (loadMoreObserver) {
    loadMoreObserver.disconnect();
    loadMoreObserver = null;
  }
  if (sentinelEl && sentinelEl.parentNode) {
    sentinelEl.parentNode.removeChild(sentinelEl);
  }
}

function setupLoadMoreObserver() {
  teardownLoadMoreObserver();
  if (renderedCount >= threadsCache.length) return;
  const sentinel = ensureSentinel();
  threadListEl.appendChild(sentinel);
  loadMoreObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        renderMore();
        break;
      }
    }
  }, { root: threadListView, rootMargin: '400px' });
  loadMoreObserver.observe(sentinel);
}

function renderMore() {
  if (renderedCount >= threadsCache.length) {
    teardownLoadMoreObserver();
    return;
  }
  const end = Math.min(renderedCount + VIRT_PAGE, threadsCache.length);
  const frag = document.createDocumentFragment();
  for (let i = renderedCount; i < end; i++) {
    // H10: animationDelay only applied to first 10 cards to avoid Nx composite thrash
    const delay = i < 10 ? i * 0.04 : null;
    frag.appendChild(createThreadCard(threadsCache[i], delay));
  }
  if (sentinelEl && sentinelEl.parentNode) {
    threadListEl.insertBefore(frag, sentinelEl);
  } else {
    threadListEl.appendChild(frag);
  }
  renderedCount = end;
  if (renderedCount >= threadsCache.length) {
    teardownLoadMoreObserver();
  }
}

async function loadThreadList(query) {
  currentQuery = query || '';
  let threads;
  try {
    threads = currentQuery ? await searchThreads(currentQuery) : await getAllThreadsMeta();
  } catch (err) {
    console.error('[XOE] loadThreadList error:', err);
    threadsCache = [];
    renderedCount = 0;
    teardownLoadMoreObserver();
    threadListEl.textContent = '';
    emptyState.style.display = 'flex';
    return;
  }

  threadsCache = threads || [];
  renderedCount = 0;
  teardownLoadMoreObserver();
  threadListEl.textContent = '';

  if (threadsCache.length === 0) {
    emptyState.style.display = 'flex';
    updateStorageDisplay();
    return;
  }
  emptyState.style.display = 'none';

  const initialEnd = Math.min(VIRT_INITIAL, threadsCache.length);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < initialEnd; i++) {
    const delay = i < 10 ? i * 0.04 : null;
    frag.appendChild(createThreadCard(threadsCache[i], delay));
  }
  threadListEl.appendChild(frag);
  renderedCount = initialEnd;
  setupLoadMoreObserver();
  updateStorageDisplay();
}

// C6: incremental update for newly saved threads (no full rebuild).
async function prependNewestThread() {
  if (currentQuery) {
    // In search mode, fall back to full refresh.
    loadThreadList(currentQuery);
    return;
  }
  try {
    const latest = await getAllThreadsMeta(1);
    if (!latest || latest.length === 0) {
      loadThreadList('');
      return;
    }
    const newest = latest[0];
    const newestIdStr = String(newest.id);
    if (threadsCache.length && String(threadsCache[0].id) === newestIdStr) {
      // Same top thread — likely an update to it. Replace in-place.
      threadsCache[0] = newest;
      const selector = `.thread-card[data-thread-id="${escapeAttr(newestIdStr)}"]`;
      const existingCard = threadListEl.querySelector(selector);
      if (existingCard) {
        const newCard = createThreadCard(newest, null);
        existingCard.replaceWith(newCard);
      }
      return;
    }
    // Genuinely new thread — prepend to cache and DOM.
    threadsCache.unshift(newest);
    const newCard = createThreadCard(newest, null);
    threadListEl.prepend(newCard);
    renderedCount += 1;
    emptyState.style.display = 'none';
  } catch (err) {
    console.error('[XOE] prependNewestThread error:', err);
    loadThreadList(currentQuery);
  }
}

function removeThreadFromList(id) {
  const idStr = String(id);
  threadsCache = threadsCache.filter(t => String(t.id) !== idStr);
  selectedIds.delete(idStr);
  try {
    const selector = `.thread-card[data-thread-id="${escapeAttr(idStr)}"]`;
    const card = threadListEl.querySelector(selector);
    if (card) {
      card.remove();
      renderedCount = Math.max(0, renderedCount - 1);
    }
  } catch (err) {
    console.warn('[XOE] removeThreadFromList selector error:', err);
  }
  if (threadsCache.length === 0) {
    emptyState.style.display = 'flex';
  }
  updateSelectionCount();
}

// ─── Reader View (lazy-mount tweet articles) ───────────────

function teardownReaderObserver() {
  if (readerObserver) {
    readerObserver.disconnect();
    readerObserver = null;
  }
}

function setupReaderObserver() {
  teardownReaderObserver();
  readerObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && entry.target._xoeMount) {
        const mount = entry.target._xoeMount;
        entry.target._xoeMount = null;
        readerObserver.unobserve(entry.target);
        mount();
      }
    }
  }, { root: readerView, rootMargin: '300px' });
}

function buildTweetArticle(tweet, tweetIdx, cache, imageBlobMap, videoBlobMap, fallbackVideoBlobMap) {
  const tweetDiv = document.createElement('article');
  tweetDiv.className = 'reader-tweet reader-tweet-pending';
  // Reserve space so the observer has stable layout to detect intersection.
  tweetDiv.style.minHeight = '120px';

  tweetDiv._xoeMount = () => {
    tweetDiv.classList.remove('reader-tweet-pending');
    tweetDiv.style.minHeight = '';

    const textDiv = document.createElement('div');
    textDiv.className = 'reader-tweet-text';
    textDiv.textContent = tweet.text || '';
    tweetDiv.appendChild(textDiv);

    if (tweet.images && tweet.images.length > 0) {
      const imagesDiv = document.createElement('div');
      imagesDiv.className = 'reader-tweet-images';
      imagesDiv.dataset.count = Math.min(tweet.images.length, 4);
      tweet.images.slice(0, 4).forEach((imgUrl, imgIdx) => {
        const src = resolveImageSrc({
          tweetIdx,
          imgIdx,
          imgUrl,
          imageBlobMap,
          legacyCache: cache
        });
        if (isAllowedImageUrl(src)) {
          const img = document.createElement('img');
          img.src = src;
          img.alt = '';
          img.loading = 'lazy';
          img.onerror = function () { this.style.display = 'none'; };
          imagesDiv.appendChild(img);
        }
      });
      if (imagesDiv.children.length > 0) tweetDiv.appendChild(imagesDiv);
    }

    if (tweet.externalVideoUrl) {
      const notice = document.createElement('div');
      notice.className = 'reader-video-notice';
      notice.textContent = 'リンク先の動画はこの投稿内には保存されていません。';
      tweetDiv.appendChild(notice);

      const link = document.createElement('a');
      link.className = 'reader-video-link';
      link.href = tweet.externalVideoUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'リンク先を開く';
      tweetDiv.appendChild(link);
      return;
    }

    const videoSrc = resolveVideoSrc({
      tweet,
      tweetIdx,
      videoBlobMap,
      fallbackVideoBlobMap
    });
    if (tweet.hasVideo && videoSrc) {
      const videoEl = document.createElement('video');
      videoEl.src = videoSrc;
      videoEl.controls = true;
      // blob URL はローカルデータなので metadata プリロードは低コスト。
      // duration / 初期フレームを表示するため metadata を使用。
      videoEl.preload = 'metadata';
      videoEl.playsInline = true;
      videoEl.className = 'reader-tweet-video';
      videoEl.onerror = function (e) {
        console.warn('[XOE] video load error', e, videoEl.error);
        this.style.display = 'none';
        const notice = document.createElement('div');
        notice.className = 'reader-video-notice';
        notice.textContent = '動画の読み込みに失敗しました（ファイルが破損している可能性）';
        this.parentNode?.insertBefore(notice, this);
      };
      tweetDiv.appendChild(videoEl);
    } else if (tweet.hasVideo) {
      const notice = document.createElement('div');
      notice.className = 'reader-video-notice';
      notice.textContent = '動画は保存されていません';
      tweetDiv.appendChild(notice);
    }
  };

  return tweetDiv;
}

async function openReaderView(threadId) {
  let thread;
  let videos = [];
  let images = [];
  try {
    // H8: parallel fetch of thread + media blobs
    const [t, v, i] = await Promise.all([
      getThread(threadId),
      getVideosByThread(threadId).catch(() => []),
      getImagesForThread(threadId).catch(() => [])
    ]);
    thread = t;
    videos = v || [];
    images = i || [];
  } catch (err) {
    console.error('[XOE] openReaderView fetch error:', err);
    return;
  }
  if (!thread) return;

  currentThreadId = threadId;
  currentView = 'reader';

  // Clear old content BEFORE revoking URLs so no <video> still references them.
  teardownReaderObserver();
  readerContent.textContent = '';
  activeVideoBlobUrls.forEach(u => URL.revokeObjectURL(u));
  activeVideoBlobUrls.length = 0;
  activeImageBlobUrls.forEach(u => URL.revokeObjectURL(u));
  activeImageBlobUrls.length = 0;

  const { map: imageBlobMap, activeUrls: imageBlobUrls } = buildImageBlobUrlMap(images, (blob) => URL.createObjectURL(blob));
  activeImageBlobUrls.push(...imageBlobUrls);
  const {
    byUrl: videoBlobMap,
    fallbackByTweetIndex,
    activeUrls: videoBlobUrls
  } = buildVideoBlobMaps(thread.tweets || [], videos, (blob) => URL.createObjectURL(blob));
  activeVideoBlobUrls.push(...videoBlobUrls);

  const firstTweet = pickPrimaryTweet(thread);
  const author = (firstTweet && firstTweet.author) || {};
  const cache = thread.imageCache || {};
  const avatarSrc = resolveAvatarSrc({
    avatarUrl: author.avatarUrl,
    avatarIndex: thread.avatarIndex,
    imageBlobMap,
    legacyCache: cache
  });

  const authorDiv = document.createElement('div');
  authorDiv.className = 'reader-author';

  const avatarDiv = document.createElement('div');
  avatarDiv.className = 'reader-avatar';
  if (avatarSrc && isAllowedImageUrl(avatarSrc)) {
    const img = document.createElement('img');
    img.src = avatarSrc;
    img.alt = '';
    img.loading = 'lazy';
    avatarDiv.appendChild(img);
  }

  const infoDiv = document.createElement('div');
  infoDiv.className = 'reader-author-info';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'reader-author-name';
  nameSpan.textContent = author.name || '不明';
  const handleSpan = document.createElement('span');
  handleSpan.className = 'reader-author-handle';
  handleSpan.textContent = author.handle ? '@' + author.handle : '';
  const dateSpan = document.createElement('span');
  dateSpan.className = 'reader-save-date';
  dateSpan.textContent = '保存: ' + formatDate(thread.timestamp);
  infoDiv.append(nameSpan, handleSpan, dateSpan);
  authorDiv.append(avatarDiv, infoDiv);
  readerContent.appendChild(authorDiv);
  renderIntegrityNotice(readerContent, thread.integrity);

  if (thread.tweets && thread.tweets.length > 0) {
    setupReaderObserver();
    thread.tweets.forEach((tweet, i) => {
      const article = buildTweetArticle(tweet, i, cache, imageBlobMap, videoBlobMap, fallbackByTweetIndex);
      readerContent.appendChild(article);
      if (i < 3) {
        // Eagerly mount above-the-fold so first paint has content.
        const mount = article._xoeMount;
        article._xoeMount = null;
        if (mount) mount();
      } else {
        readerObserver.observe(article);
      }
    });
  } else if (thread.text) {
    const tweetDiv = document.createElement('div');
    tweetDiv.className = 'reader-tweet';
    const textDiv = document.createElement('div');
    textDiv.className = 'reader-tweet-text';
    textDiv.textContent = thread.text;
    tweetDiv.appendChild(textDiv);
    readerContent.appendChild(tweetDiv);
  }

  threadListView.style.display = 'none';
  document.getElementById('header').style.display = 'none';
  settingsPanel.style.display = 'none';
  readerView.style.display = '';
}

function closeReaderView() {
  teardownReaderObserver();
  currentView = 'list';
  currentThreadId = null;
  readerView.style.display = 'none';
  // Remove video elements first so no <video>.src still references the blob URL
  readerContent.textContent = '';
  activeVideoBlobUrls.forEach(u => URL.revokeObjectURL(u));
  activeVideoBlobUrls.length = 0;
  activeImageBlobUrls.forEach(u => URL.revokeObjectURL(u));
  activeImageBlobUrls.length = 0;
  threadListView.style.display = '';
  document.getElementById('header').style.display = '';
  loadThreadList(searchInput.value.trim());
}

// ─── Event Handlers ─────────────────────────────────────────

threadListEl.addEventListener('click', (e) => {
  const card = e.target.closest('.thread-card');

  if (selectionMode && card) {
    toggleSelection(card.dataset.threadId, card);
    return;
  }

  const deleteBtn = e.target.closest('.card-delete');
  if (deleteBtn) {
    e.stopPropagation();
    const id = deleteBtn.dataset.deleteId;
    showConfirm('スレッドを削除', 'このスレッドを削除しますか？この操作は元に戻せません。').then(ok => {
      if (ok) {
        deleteThread(id).then(() => {
          deleteVideosByThread(id).catch(() => {});
          chrome.runtime.sendMessage({ type: 'NOTIFY_THREAD_DELETED', threadId: id }).catch(() => {});
          removeThreadFromList(id);
          updateStorageDisplay();
        });
      }
    });
    return;
  }

  if (card) openReaderView(card.dataset.threadId);
});

btnBack.addEventListener('click', closeReaderView);

btnSettings.addEventListener('click', () => {
  settingsOpen = !settingsOpen;
  settingsPanel.style.display = settingsOpen ? '' : 'none';
  btnSettings.classList.toggle('active', settingsOpen);
});

btnDeleteAll.addEventListener('click', () => {
  showConfirm('すべてのスレッドを削除', '保存済みのスレッドをすべて削除しますか？この操作は元に戻せません。').then(ok => {
    if (ok) {
      deleteAllThreads().then(() => {
        deleteAllVideos().catch(() => {});
        chrome.runtime.sendMessage({ type: 'NOTIFY_ALL_DELETED' }).catch(() => {});
        if (selectionMode) exitSelectionMode();
        loadThreadList();
        updateStorageDisplay();
      });
    }
  });
});

btnExportPdf.addEventListener('click', () => {
  if (!currentThreadId || pdfExporting) return;
  pdfExporting = true;
  btnExportPdf.disabled = true;
  chrome.runtime.sendMessage({ type: 'EXPORT_PDF', threadId: currentThreadId });
  setTimeout(() => { pdfExporting = false; btnExportPdf.disabled = false; }, 30000);
});

btnDeleteThread.addEventListener('click', () => {
  if (!currentThreadId) return;
  showConfirm('スレッドを削除', 'このスレッドを削除しますか？この操作は元に戻せません。').then(ok => {
    if (ok) {
      const id = currentThreadId;
      deleteThread(id).then(() => {
        deleteVideosByThread(id).catch(() => {});
        chrome.runtime.sendMessage({ type: 'NOTIFY_THREAD_DELETED', threadId: id }).catch(() => {});
        closeReaderView();
      });
    }
  });
});

// Search debounce tightened 300ms → 200ms (MEDIUM)
searchInput.addEventListener('input', debounce(() => {
  loadThreadList(searchInput.value.trim());
}, 200));

btnSelectMode.addEventListener('click', enterSelectionMode);
btnCancelSelect.addEventListener('click', exitSelectionMode);
btnSelectAll.addEventListener('click', selectAll);
btnDeleteSelected.addEventListener('click', deleteSelectedThreads);

cacheLimitSelect.addEventListener('change', onSettingChange);
cacheTTLSelect.addEventListener('change', onSettingChange);
btnManualCleanup.addEventListener('click', onManualCleanup);

// ─── Backup: Export / Import ───────────────────────────────
const btnExportAll = document.getElementById('btn-export-all');
const btnImportAll = document.getElementById('btn-import-all');
const importFileInput = document.getElementById('import-file-input');
const backupStatus = document.getElementById('backup-status');

function setBackupStatus(msg) {
  if (backupStatus) backupStatus.textContent = msg || '';
}

async function onExportAll() {
  if (!btnExportAll) return;
  const orig = btnExportAll.textContent;
  btnExportAll.disabled = true;
  btnExportAll.textContent = 'エクスポート中...';
  setBackupStatus('');
  try {
    const dump = await exportAll({
      onProgress: ({ stage, done, total }) => {
        setBackupStatus(`${stage} ${done}/${total}`);
      }
    });
    const json = JSON.stringify(dump);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `xoe-backup_${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setBackupStatus(`完了: threads=${dump.counts.threads}, images=${dump.counts.images}, videos=${dump.counts.videos}`);
  } catch (err) {
    console.error('[XOE] Export failed:', err);
    setBackupStatus('エクスポート失敗: ' + (err?.message || err));
  } finally {
    btnExportAll.disabled = false;
    btnExportAll.textContent = orig;
  }
}

function onImportAllClick() {
  if (importFileInput) importFileInput.click();
}

async function onImportFileSelected(ev) {
  const file = ev.target?.files?.[0];
  if (!file) return;
  if (!btnImportAll) return;
  const orig = btnImportAll.textContent;
  btnImportAll.disabled = true;
  btnImportAll.textContent = 'インポート中...';
  setBackupStatus('');
  try {
    const text = await file.text();
    const dump = JSON.parse(text);
    const result = await importAll(dump, {
      onProgress: ({ stage, done, total }) => {
        setBackupStatus(`${stage} ${done}/${total}`);
      }
    });
    setBackupStatus(`復元完了: threads=${result.threads}, images=${result.images}, videos=${result.videos}`);
    await loadThreadList();
    await updateStorageDisplay();
  } catch (err) {
    console.error('[XOE] Import failed:', err);
    setBackupStatus('インポート失敗: ' + (err?.message || err));
  } finally {
    btnImportAll.disabled = false;
    btnImportAll.textContent = orig;
    if (importFileInput) importFileInput.value = '';
  }
}

btnExportAll?.addEventListener('click', onExportAll);
btnImportAll?.addEventListener('click', onImportAllClick);
importFileInput?.addEventListener('change', onImportFileSelected);

// ─── Message Listener ───────────────────────────────────────

// Debounce bursts of THREAD_SAVED (multi-thread batch save) to a single refresh.
function scheduleThreadSavedRefresh() {
  if (threadSavedTimer) clearTimeout(threadSavedTimer);
  threadSavedTimer = setTimeout(() => {
    threadSavedTimer = null;
    if (currentView !== 'list') return;
    prependNewestThread();
    updateStorageDisplay();
  }, 200);
}

async function handlePdfReady(message) {
  pdfExporting = false;
  btnExportPdf.disabled = false;

  if (message.error) {
    if (pdfToastLabel) pdfToastLabel.textContent = 'PDF生成エラー';
    pdfDownloadLink.textContent = message.error;
    pdfDownloadLink.removeAttribute('href');
    pdfToast.style.display = '';
    if (pdfToastTimer) clearTimeout(pdfToastTimer);
    pdfToastTimer = setTimeout(() => { pdfToast.style.display = 'none'; }, 5000);
    return;
  }

  // C3 new protocol: SW hands off via chrome.storage.session to avoid
  // blowing up the message channel with large base64 payloads.
  if (message.storageKey) {
    try {
      const data = await chrome.storage.session.get(message.storageKey);
      const entry = data && data[message.storageKey];
      const base64 = entry && entry.base64;
      const filename = message.filename || (entry && entry.filename) || 'thread.pdf';
      if (base64 && base64.startsWith('data:application/pdf')) {
        if (pdfToastLabel) pdfToastLabel.textContent = 'PDF生成完了';
        pdfDownloadLink.textContent = 'ダウンロード';
        pdfDownloadLink.href = base64;
        pdfDownloadLink.download = filename;
        pdfToast.style.display = '';
        if (pdfToastTimer) clearTimeout(pdfToastTimer);
        pdfToastTimer = setTimeout(() => { pdfToast.style.display = 'none'; }, 8000);

        // Auto-trigger download via temp anchor per brief
        const a = document.createElement('a');
        a.href = base64;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else if (pdfToastLabel) {
        pdfToastLabel.textContent = 'PDFデータが見つかりません';
        pdfToast.style.display = '';
        if (pdfToastTimer) clearTimeout(pdfToastTimer);
        pdfToastTimer = setTimeout(() => { pdfToast.style.display = 'none'; }, 5000);
      }
    } catch (err) {
      console.error('[XOE] PDF storage fetch error:', err);
    } finally {
      try { await chrome.storage.session.remove(message.storageKey); } catch {}
      try {
        await chrome.runtime.sendMessage({ type: 'PDF_CONSUMED', storageKey: message.storageKey });
      } catch {}
    }
    return;
  }

  // Legacy: inline base64 in message (backward compat)
  if (message.pdfBase64 && message.pdfBase64.startsWith('data:application/pdf')) {
    if (pdfToastLabel) pdfToastLabel.textContent = 'PDF生成完了';
    pdfDownloadLink.textContent = 'ダウンロード';
    pdfDownloadLink.href = message.pdfBase64;
    pdfDownloadLink.download = message.filename || 'thread.pdf';
    pdfToast.style.display = '';
    if (pdfToastTimer) clearTimeout(pdfToastTimer);
    pdfToastTimer = setTimeout(() => { pdfToast.style.display = 'none'; }, 8000);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return;

  if (message.type === 'THREAD_SAVED') {
    scheduleThreadSavedRefresh();
    return;
  }
  if (message.type === 'CACHE_CLEANED') {
    if (currentView === 'list') loadThreadList(searchInput.value.trim());
    updateStorageDisplay();
    return;
  }
  if (message.type === 'VIDEOS_SAVED') {
    updateStorageDisplay();
    return;
  }
  if (message.type === 'THREAD_IMAGES_READY') {
    updateStorageDisplay();
    return;
  }
  if (message.type === 'PDF_READY') {
    handlePdfReady(message);
  }
});

// ─── Init ───────────────────────────────────────────────────

try {
  loadSettings();
  loadThreadList();
  updateStorageDisplay();
} catch (err) {
  console.error('[XOE] Init error:', err);
}
