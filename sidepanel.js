/**
 * Side Panel UI for X Offline Enhancer (ES Module)
 */

window.__xoeModuleLoaded = true;

import { getIntegrityMessage, pickPrimaryTweet } from './lib/thread-model.mjs';
import { isAllowedImageUrl } from './lib/utils-esm.js';
import {
  getAllThreadsMeta, getThread, deleteThread, deleteAllThreads,
  searchThreads, getStorageSize,
  purgeExpiredCaches, purgeUntilUnderLimit,
  getVideosByThread, deleteVideosByThread, deleteAllVideos
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

// ─── Cache Settings ─────────────────────────────────────────

const DEFAULT_CACHE_SETTINGS = {
  cacheLimitMB: 200,
  cacheTTLDays: 30
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
    const pct = limitBytes > 0 ? Math.min((usage / limitBytes) * 100, 100) : 0;
    storageFill.style.width = pct + '%';
    if (pct > 90) storageFill.style.background = '#f4212e';
    else if (pct > 70) storageFill.style.background = '#ffd400';
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
  updateSelectionCount();
}

function exitSelectionMode() {
  selectionMode = false;
  selectedIds.clear();
  headerNormal.style.display = '';
  headerSelection.style.display = 'none';
  threadListEl.classList.remove('selection-mode');
  threadListEl.querySelectorAll('.thread-card.selected').forEach(c => c.classList.remove('selected'));
}

function toggleSelection(threadId, card) {
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
  const isAllSelected = selectedIds.size ===
    threadListEl.querySelectorAll('.thread-card').length;

  if (isAllSelected) {
    // Deselect all
    selectedIds.clear();
    threadListEl.querySelectorAll('.thread-card.selected').forEach(c => c.classList.remove('selected'));
  } else {
    // Select all
    threadListEl.querySelectorAll('.thread-card').forEach(card => {
      const id = card.dataset.threadId;
      if (id) { selectedIds.add(id); card.classList.add('selected'); }
    });
  }
  updateSelectionCount();
}

function updateSelectionCount() {
  selectionCountEl.textContent = `${selectedIds.size}件選択`;
  btnDeleteSelected.disabled = selectedIds.size === 0;

  const total = threadListEl.querySelectorAll('.thread-card').length;
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
  for (const id of deletedIds) {
    await deleteThread(id);
    await deleteVideosByThread(id).catch(() => {});
  }
  chrome.runtime.sendMessage({ type: 'NOTIFY_THREADS_DELETED', threadIds: deletedIds }).catch(() => {});
  exitSelectionMode();
  loadThreadList(searchInput.value.trim());
  updateStorageDisplay();
}

// ─── Thread List (lightweight meta, no imageCache) ──────────

const TRASH_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>';

async function loadThreadList(query) {
  let threads;
  try {
    threads = query ? await searchThreads(query) : await getAllThreadsMeta();
  } catch (err) {
    console.error('[XOE] loadThreadList error:', err);
    threadListEl.textContent = '';
    emptyState.style.display = 'flex';
    return;
  }

  if (!threads || threads.length === 0) {
    threadListEl.textContent = '';
    emptyState.style.display = 'flex';
    return;
  }

  emptyState.style.display = 'none';
  const fragment = document.createDocumentFragment();

  threads.forEach((thread, i) => {
    const card = document.createElement('div');
    card.className = 'thread-card';
    card.style.animationDelay = `${Math.min(i * 0.04, 0.5)}s`;
    card.dataset.threadId = thread.id;

    const firstTweet = pickPrimaryTweet(thread);
    const author = firstTweet?.author || {};

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
    textDiv.textContent = truncate(firstTweet?.text || '', 100);

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
    deleteBtn.innerHTML = TRASH_SVG;

    metaDiv.append(tagsDiv, deleteBtn);
    bodyDiv.append(headerDiv, textDiv, metaDiv);
    card.append(avatarDiv, bodyDiv);
    fragment.appendChild(card);
  });

  threadListEl.textContent = '';
  threadListEl.appendChild(fragment);
  updateStorageDisplay();
}

// ─── Reader View (full data with imageCache) ────────────────

async function openReaderView(threadId) {
  let thread;
  try { thread = await getThread(threadId); } catch (err) {
    console.error('[XOE] getThread error:', err);
    return;
  }
  if (!thread) return;

  currentThreadId = threadId;
  currentView = 'reader';
  readerContent.textContent = '';

  // Revoke old video blob URLs
  activeVideoBlobUrls.forEach(u => URL.revokeObjectURL(u));
  activeVideoBlobUrls.length = 0;

  // Load stored videos for this thread
  let videoBlobMap = new Map();
  try {
    const videos = await getVideosByThread(threadId);
    for (const v of videos) {
      if (v.blob) {
        const blobUrl = URL.createObjectURL(v.blob);
        activeVideoBlobUrls.push(blobUrl);
        videoBlobMap.set(v.url, blobUrl);
      }
    }
  } catch (err) {
    console.error('[XOE] Video load error:', err);
  }

  const firstTweet = pickPrimaryTweet(thread);
  const author = firstTweet?.author || {};
  const cache = thread.imageCache || {};
  const avatarSrc = cache[author.avatarUrl] || author.avatarUrl || '';

  const authorDiv = document.createElement('div');
  authorDiv.className = 'reader-author';

  const avatarDiv = document.createElement('div');
  avatarDiv.className = 'reader-avatar';
  if (avatarSrc && isAllowedImageUrl(avatarSrc)) {
    const img = document.createElement('img');
    img.src = avatarSrc;
    img.alt = '';
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
    thread.tweets.forEach(tweet => {
      const tweetDiv = document.createElement('div');
      tweetDiv.className = 'reader-tweet';

      const textDiv = document.createElement('div');
      textDiv.className = 'reader-tweet-text';
      textDiv.textContent = tweet.text || '';
      tweetDiv.appendChild(textDiv);

      if (tweet.images && tweet.images.length > 0) {
        const imagesDiv = document.createElement('div');
        imagesDiv.className = 'reader-tweet-images';
        imagesDiv.dataset.count = Math.min(tweet.images.length, 4);
        tweet.images.slice(0, 4).forEach(imgUrl => {
          const src = cache[imgUrl] || imgUrl;
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

      // Video playback from stored blob
      if (tweet.hasVideo && tweet.videoUrl && videoBlobMap.has(tweet.videoUrl)) {
        const videoEl = document.createElement('video');
        videoEl.src = videoBlobMap.get(tweet.videoUrl);
        videoEl.controls = true;
        videoEl.preload = 'metadata';
        videoEl.playsInline = true;
        videoEl.className = 'reader-tweet-video';
        videoEl.onerror = function () { this.style.display = 'none'; };
        tweetDiv.appendChild(videoEl);
      } else if (tweet.hasVideo && !tweet.videoUrl) {
        const notice = document.createElement('div');
        notice.className = 'reader-video-notice';
        notice.textContent = '動画は保存されていません';
        tweetDiv.appendChild(notice);
      }

      readerContent.appendChild(tweetDiv);
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
  // Release video blob URLs to free memory
  activeVideoBlobUrls.forEach(u => URL.revokeObjectURL(u));
  activeVideoBlobUrls.length = 0;
  currentView = 'list';
  currentThreadId = null;
  readerView.style.display = 'none';
  threadListView.style.display = '';
  document.getElementById('header').style.display = '';
  loadThreadList(searchInput.value.trim());
}

// ─── Event Handlers ─────────────────────────────────────────

threadListEl.addEventListener('click', (e) => {
  const card = e.target.closest('.thread-card');

  // In selection mode, all clicks toggle selection
  if (selectionMode && card) {
    toggleSelection(card.dataset.threadId, card);
    return;
  }

  // Normal mode: individual delete button
  const deleteBtn = e.target.closest('.card-delete');
  if (deleteBtn) {
    e.stopPropagation();
    const id = deleteBtn.dataset.deleteId;
    showConfirm('スレッドを削除', 'このスレッドを削除しますか？この操作は元に戻せません。').then(ok => {
      if (ok) {
        deleteThread(id).then(() => {
          deleteVideosByThread(id).catch(() => {});
          chrome.runtime.sendMessage({ type: 'NOTIFY_THREAD_DELETED', threadId: id }).catch(() => {});
          loadThreadList(searchInput.value.trim());
          updateStorageDisplay();
        });
      }
    });
    return;
  }

  // Normal mode: open reader
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

searchInput.addEventListener('input', debounce(() => {
  loadThreadList(searchInput.value.trim());
}, 300));

btnSelectMode.addEventListener('click', enterSelectionMode);
btnCancelSelect.addEventListener('click', exitSelectionMode);
btnSelectAll.addEventListener('click', selectAll);
btnDeleteSelected.addEventListener('click', deleteSelectedThreads);

cacheLimitSelect.addEventListener('change', onSettingChange);
cacheTTLSelect.addEventListener('change', onSettingChange);
btnManualCleanup.addEventListener('click', onManualCleanup);

// ─── Message Listener ───────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'THREAD_SAVED' || message.type === 'CACHE_CLEANED') {
    if (currentView === 'list') loadThreadList(searchInput.value.trim());
    updateStorageDisplay();
  }

  if (message.type === 'VIDEOS_SAVED') {
    updateStorageDisplay();
  }

  if (message.type === 'PDF_READY') {
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
});

// ─── Init ───────────────────────────────────────────────────

try {
  loadSettings();
  loadThreadList();
  updateStorageDisplay();
} catch (err) {
  console.error('[XOE] Init error:', err);
}
