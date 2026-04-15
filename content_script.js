/**
 * X Offline Enhancer - Content Script
 * Injects Save/PiP buttons into tweets and extracts thread data.
 */

(function () {
  'use strict';

  const DEBUG = false;
  function log(...args) { if (DEBUG) console.log('[XOE]', ...args); }

  console.log('[XOE] Content script loaded on', location.href);

  const PROCESSED_ATTR = 'data-xoe-processed';
  const BUTTON_CLASS_PREFIX = 'xoe-';
  const savedTweetIds = new Set();

  const MAX_IMAGES = 50;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const ALLOWED_IMAGE_HOSTS = ['pbs.twimg.com', 'abs.twimg.com', 'video.twimg.com'];
  const PARALLEL_FETCH_LIMIT = 4;
  const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
  const MAX_VIDEOS_PER_THREAD = 10;

  // ── Helpers ──────────────────────────────────────────────

  function isAllowedImageUrl(url) {
    if (!url) return false;
    if (url.startsWith('data:image/')) return true;
    try { return ALLOWED_IMAGE_HOSTS.includes(new URL(url).hostname); }
    catch { return false; }
  }

  function extractTweetId(articleEl) {
    const links = articleEl.querySelectorAll('a[href*="/status/"]');
    for (const link of links) {
      const match = link.href.match(/\/status\/(\d+)/);
      if (match) return match[1];
    }
    return null;
  }

  function normalizeTweetText(value) {
    return String(value ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\u00a0/g, ' ')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function extractTweetText(articleEl) {
    const textEl = articleEl.querySelector('[data-testid="tweetText"]');
    if (textEl) {
      return {
        text: normalizeTweetText(textEl.innerText || textEl.textContent || ''),
        textSource: 'tweetText'
      };
    }

    const langNodes = articleEl.querySelectorAll('div[lang]');
    const textParts = [...langNodes]
      .map((node) => normalizeTweetText(node.innerText || node.textContent || ''))
      .filter(Boolean);

    if (textParts.length > 0) {
      return {
        text: [...new Set(textParts)].join('\n'),
        textSource: 'lang'
      };
    }

    return { text: '', textSource: 'missing' };
  }

  function tweetHasMedia(tweet) {
    return (Array.isArray(tweet?.images) && tweet.images.length > 0) || Boolean(tweet?.hasVideo);
  }

  function tweetHasContent(tweet) {
    return normalizeTweetText(tweet?.text).length > 0 || tweetHasMedia(tweet);
  }

  function normalizeHandle(tweet) {
    return String(tweet?.author?.handle || '').trim().toLowerCase();
  }

  function isThreadDetailPage() {
    return /\/status\/\d+/.test(location.pathname);
  }

  function extractTweetData(articleEl) {
    const id = extractTweetId(articleEl);
    if (!id) return null;

    const { text, textSource } = extractTweetText(articleEl);

    let name = '', handle = '';
    const userNameEl = articleEl.querySelector('[data-testid="User-Name"]');
    if (userNameEl) {
      const handleMatch = (userNameEl.textContent || '').match(/@([A-Za-z0-9_]+)/);
      if (handleMatch) handle = handleMatch[1];
      const nameLink = userNameEl.querySelector('a');
      if (nameLink) {
        const firstSpan = nameLink.querySelector('span');
        if (firstSpan) name = firstSpan.textContent.trim();
      }
    }

    const avatarImg = articleEl.querySelector(
      'img[src*="pbs.twimg.com/profile_images"], img[src*="abs.twimg.com/sticky/default_profile_images"]'
    );
    const avatarUrl = avatarImg ? avatarImg.src : '';

    const timeEl = articleEl.querySelector('time');
    const timestamp = timeEl ? timeEl.getAttribute('datetime') : '';

    const images = [];
    articleEl.querySelectorAll('img[src*="pbs.twimg.com/media"]').forEach((img) => {
      if (!images.includes(img.src)) images.push(img.src);
    });

    const hasVideo = !!(articleEl.querySelector('video') || articleEl.querySelector('[data-testid="videoPlayer"]'));
    const videoUrl = hasVideo ? findVideoUrlForArticle(articleEl) : null;

    return { id, text, textSource, author: { name, handle, avatarUrl }, timestamp, images, hasVideo, videoUrl };
  }

  function findVideoUrlForArticle(articleEl) {
    const videoEl = articleEl.querySelector('video');
    if (!videoEl) return null;

    // Method 1: Direct non-blob src
    if (videoEl.src && !videoEl.src.startsWith('blob:') && isAllowedImageUrl(videoEl.src)) {
      return videoEl.src;
    }
    const sourceEl = videoEl.querySelector('source');
    if (sourceEl?.src && !sourceEl.src.startsWith('blob:') && isAllowedImageUrl(sourceEl.src)) {
      return sourceEl.src;
    }

    // Method 2: Match video poster's media ID with performance entries
    const poster = videoEl.poster || '';
    const posterMatch = poster.match(/\/(ext_tw_video_thumb|tweet_video_thumb|amplify_video_thumb)\/(\d+)\//);
    if (posterMatch) {
      const mediaId = posterMatch[2];
      try {
        const entries = performance.getEntriesByType('resource');
        let bestUrl = null;
        let bestRes = 0;
        for (const entry of entries) {
          if (entry.name.includes('video.twimg.com') && entry.name.includes('.mp4') && entry.name.includes(mediaId)) {
            const resMatch = entry.name.match(/\/(\d+)x(\d+)\//);
            const res = resMatch ? parseInt(resMatch[1]) * parseInt(resMatch[2]) : 1;
            if (res > bestRes) { bestUrl = entry.name; bestRes = res; }
          }
        }
        if (bestUrl) return bestUrl;
      } catch {}
    }

    return null;
  }

  function selectThreadTweets(candidates, clickedTweetId, options = {}) {
    const clickedIndex = candidates.findIndex((tweet) => tweet.id === clickedTweetId);
    if (clickedIndex < 0) return [];

    const clickedTweet = candidates[clickedIndex];
    if (options.isThreadView === false) return [clickedTweet];

    const clickedHandle = normalizeHandle(clickedTweet);
    if (!clickedHandle) return [clickedTweet];

    let start = clickedIndex;
    let end = clickedIndex;

    while (start > 0) {
      const prevTweet = candidates[start - 1];
      if (normalizeHandle(prevTweet) !== clickedHandle || !tweetHasContent(prevTweet)) break;
      start--;
    }

    while (end < candidates.length - 1) {
      const nextTweet = candidates[end + 1];
      if (normalizeHandle(nextTweet) !== clickedHandle || !tweetHasContent(nextTweet)) break;
      end++;
    }

    return candidates.slice(start, end + 1);
  }

  function collectThreadTweets(rootArticle) {
    const clickedTweetId = extractTweetId(rootArticle);
    if (!clickedTweetId) return [];

    const scopeRoot = rootArticle.closest('[data-testid="primaryColumn"]')
      || rootArticle.closest('[data-testid="cellInnerDiv"]')?.parentElement?.parentElement
      || document.querySelector('[data-testid="primaryColumn"]')
      || document.querySelector('[data-testid="DeckColumns"]')
      || document.querySelector('main')
      || document.body;

    let articles = scopeRoot.querySelectorAll('article[data-testid="tweet"]');
    if (articles.length === 0) {
      articles = scopeRoot.querySelectorAll('article[role="article"]');
    }
    const candidates = [];
    const seen = new Set();
    for (const article of articles) {
      const data = extractTweetData(article);
      if (data && !seen.has(data.id)) {
        seen.add(data.id);
        candidates.push(data);
      }
    }

    const selected = selectThreadTweets(candidates, clickedTweetId, {
      isThreadView: isThreadDetailPage()
    });
    if (selected.length > 0) return selected;

    const clickedTweet = candidates.find((tweet) => tweet.id === clickedTweetId);
    return clickedTweet ? [clickedTweet] : [];
  }

  async function fetchImageAsBase64(url) {
    if (!isAllowedImageUrl(url)) return null;
    try {
      const resp = await fetch(url);
      const blob = await resp.blob();
      if (blob.size > MAX_IMAGE_BYTES) return null;
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }

  async function fetchImagesParallel(urls) {
    const cache = {};
    const queue = [...urls];
    const workers = [];
    for (let i = 0; i < Math.min(PARALLEL_FETCH_LIMIT, queue.length); i++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const url = queue.shift();
          if (url && !cache[url]) {
            cache[url] = await fetchImageAsBase64(url);
          }
        }
      })());
    }
    await Promise.all(workers);
    return cache;
  }

  // ── Save Logic ───────────────────────────────────────────

  async function handleSave(articleEl, btn) {
    const tweetId = extractTweetId(articleEl);
    if (!tweetId || savedTweetIds.has(tweetId)) return;

    const labelEl = btn.querySelector('.xoe-btn-label');
    const iconEl = btn.querySelector('.xoe-btn-icon');
    btn.classList.add(`${BUTTON_CLASS_PREFIX}saving`);
    if (labelEl) labelEl.textContent = '保存中…';
    btn.disabled = true;

    try {
      const tweets = collectThreadTweets(articleEl);
      if (tweets.length === 0) throw new Error('No tweets found');
      if (!tweets.some((tweet) => tweet.id === tweetId)) {
        throw new Error('Clicked tweet missing from collected thread');
      }

      log('Saving thread:', tweetId, 'tweets:', tweets.length);

      const urlSet = new Set();
      let count = 0;
      for (const tweet of tweets) {
        for (const imgUrl of tweet.images) {
          if (count >= MAX_IMAGES) break;
          if (isAllowedImageUrl(imgUrl)) { urlSet.add(imgUrl); count++; }
        }
        if (tweet.author.avatarUrl && isAllowedImageUrl(tweet.author.avatarUrl)) {
          urlSet.add(tweet.author.avatarUrl);
        }
      }

      const imageCache = await fetchImagesParallel([...urlSet]);

      // Collect unique video URLs from tweets
      const videoUrls = [...new Set(
        tweets.map(t => t.videoUrl).filter(u => u && isAllowedImageUrl(u))
      )].slice(0, MAX_VIDEOS_PER_THREAD);

      const threadData = {
        id: tweetId,
        url: window.location.href,
        tweets,
        imageCache,
        videoUrls,
        timestamp: Date.now(),
        tags: []
      };

      const response = await chrome.runtime.sendMessage({ type: 'SAVE_THREAD', data: threadData });

      if (response && response.success) {
        savedTweetIds.add(tweetId);
        if (btn.isConnected) {
          btn.classList.remove(`${BUTTON_CLASS_PREFIX}saving`);
          btn.classList.add(`${BUTTON_CLASS_PREFIX}saved`);
          if (iconEl?.isConnected) iconEl.innerHTML = ICON_CHECK;
        }

        // Fetch videos in background if any
        if (videoUrls.length > 0) {
          if (labelEl?.isConnected) labelEl.textContent = '動画取得中…';
          chrome.runtime.sendMessage(
            { type: 'FETCH_VIDEOS', threadId: tweetId, videoUrls },
            (vResp) => {
              if (chrome.runtime.lastError) {
                log('Video fetch failed:', chrome.runtime.lastError.message);
              } else {
                log('Videos saved:', vResp?.saved || 0);
              }
              if (labelEl?.isConnected) labelEl.textContent = '保存済';
            }
          );
        } else {
          if (labelEl?.isConnected) labelEl.textContent = '保存済';
        }
      } else {
        throw new Error(response?.error || 'Save failed');
      }
    } catch (err) {
      log('Save failed:', err.message);
      if (btn.isConnected) {
        btn.classList.remove(`${BUTTON_CLASS_PREFIX}saving`);
        if (labelEl?.isConnected) labelEl.textContent = '保存';
        btn.disabled = false;
      }
    }
  }

  // ── PiP Logic ────────────────────────────────────────────

  function isPiPSupported() {
    return document.pictureInPictureEnabled !== false &&
           typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function';
  }

  async function handlePiP(articleEl) {
    const video = articleEl.querySelector('video');
    if (!video) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      await video.requestPictureInPicture();
    } catch (err) {
      log('PiP failed:', err.message);
    }
  }

  try {
    if (navigator.mediaSession && typeof navigator.mediaSession.setActionHandler === 'function') {
      navigator.mediaSession.setActionHandler('enterpictureinpicture', async () => {
        const video = document.querySelector('video');
        if (video) await video.requestPictureInPicture();
      });
    }
  } catch {}

  // ── SVG Icons ─────────────────────────────────────────────

  const ICON_BOOKMARK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"></path></svg>';
  const ICON_CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  const ICON_PIP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><rect x="12" y="9" width="8" height="6" rx="1" ry="1" fill="currentColor" opacity="0.3"></rect></svg>';

  // ── Button Injection ─────────────────────────────────────

  function createButton(labelText, iconSvg, className, onClick) {
    const btn = document.createElement('button');
    btn.className = `${BUTTON_CLASS_PREFIX}btn ${BUTTON_CLASS_PREFIX}${className}`;
    btn.type = 'button';
    const iconSpan = document.createElement('span');
    iconSpan.className = 'xoe-btn-icon';
    iconSpan.innerHTML = iconSvg;
    const labelSpan = document.createElement('span');
    labelSpan.className = 'xoe-btn-label';
    labelSpan.textContent = labelText;
    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      onClick();
    });
    return btn;
  }

  function findActionBar(article) {
    const groups = article.querySelectorAll('[role="group"]');
    for (const group of groups) {
      if (group.querySelector('[data-testid="reply"]') ||
          group.querySelector('[data-testid="retweet"]') ||
          group.querySelector('[data-testid="like"]') ||
          group.querySelector('[data-testid="bookmark"]')) {
        return group;
      }
    }
    if (groups.length > 0) return groups[groups.length - 1];
    return article.querySelector('[role="toolbar"]') || null;
  }

  function injectButtons(article) {
    if (article.hasAttribute(PROCESSED_ATTR)) return;
    if (article.querySelector('.xoe-actions')) return;
    article.setAttribute(PROCESSED_ATTR, 'true');

    const actionBar = findActionBar(article);
    if (!actionBar) return;

    const tweetId = extractTweetId(article);

    const container = document.createElement('div');
    container.className = `${BUTTON_CLASS_PREFIX}actions`;
    if (tweetId) container.dataset.tweetId = tweetId;

    const isSaved = tweetId && savedTweetIds.has(tweetId);
    const saveBtn = createButton(
      isSaved ? '保存済' : '保存',
      isSaved ? ICON_CHECK : ICON_BOOKMARK,
      isSaved ? 'save-btn xoe-saved' : 'save-btn',
      () => handleSave(article, saveBtn)
    );
    if (isSaved) saveBtn.disabled = true;
    container.appendChild(saveBtn);

    const hasVideo = !!(article.querySelector('video') || article.querySelector('[data-testid="videoPlayer"]'));
    if (hasVideo && isPiPSupported()) {
      const pipBtn = createButton('PiP', ICON_PIP, 'pip-btn', () => handlePiP(article));
      container.appendChild(pipBtn);
    }

    actionBar.appendChild(container);
  }

  // ── Observer ─────────────────────────────────────────────

  let processTimer = null;

  function processAllTweets() {
    let articles = document.querySelectorAll('article[data-testid="tweet"]');
    if (articles.length === 0) {
      articles = document.querySelectorAll('article[role="article"]');
    }
    articles.forEach(a => {
      if (!a.hasAttribute(PROCESSED_ATTR) && !a.querySelector('.xoe-actions')) {
        injectButtons(a);
      }
    });
  }

  const observer = new MutationObserver(() => {
    if (processTimer) clearTimeout(processTimer);
    processTimer = setTimeout(processAllTweets, 200);
  });

  function startObserving() {
    log('Starting observer');
    processAllTweets();
    const timeline = document.querySelector('[data-testid="primaryColumn"]')
                   || document.querySelector('[data-testid="DeckColumns"]')
                   || document.querySelector('main')
                   || document.body;
    observer.observe(timeline, { childList: true, subtree: true });
  }

  // ── Init ─────────────────────────────────────────────────

  // IMPORTANT: Start observer FIRST, then restore saved IDs asynchronously.
  // This ensures buttons are injected even if SW messaging fails.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(startObserving, 500));
  } else {
    setTimeout(startObserving, 500);
  }

  // Restore saved IDs asynchronously (non-blocking)
  try {
    chrome.runtime.sendMessage({ type: 'GET_SAVED_IDS' }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[XOE] GET_SAVED_IDS failed:', chrome.runtime.lastError.message);
        return;
      }
      if (response?.success && Array.isArray(response.ids)) {
        response.ids.forEach(id => savedTweetIds.add(String(id)));
        log('Restored', savedTweetIds.size, 'saved IDs');
      }
    });
  } catch (err) {
    console.warn('[XOE] sendMessage error:', err);
  }

  // ── Button Reset Helpers ──────────────────────────────────

  function resetSaveButton(tweetId) {
    savedTweetIds.delete(tweetId);
    const container = document.querySelector(`.xoe-actions[data-tweet-id="${CSS.escape(tweetId)}"]`);
    if (!container) return;
    const btn = container.querySelector('.xoe-save-btn');
    if (btn) {
      btn.classList.remove(`${BUTTON_CLASS_PREFIX}saving`, `${BUTTON_CLASS_PREFIX}saved`);
      const label = btn.querySelector('.xoe-btn-label');
      const icon = btn.querySelector('.xoe-btn-icon');
      if (label) label.textContent = '保存';
      if (icon) icon.innerHTML = ICON_BOOKMARK;
      btn.disabled = false;
    }
  }

  function resetAllSaveButtons() {
    savedTweetIds.clear();
    document.querySelectorAll(`.${BUTTON_CLASS_PREFIX}saved`).forEach(btn => {
      btn.classList.remove(`${BUTTON_CLASS_PREFIX}saved`);
      const label = btn.querySelector('.xoe-btn-label');
      const icon = btn.querySelector('.xoe-btn-icon');
      if (label) label.textContent = '保存';
      if (icon) icon.innerHTML = ICON_BOOKMARK;
      btn.disabled = false;
    });
  }

  // ── Message Listener ────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SAVE_COMPLETE' && msg.id) {
      savedTweetIds.add(msg.id);
      const container = document.querySelector(`.xoe-actions[data-tweet-id="${CSS.escape(msg.id)}"]`);
      if (container) {
        const btn = container.querySelector('.xoe-save-btn');
        if (btn) {
          btn.classList.remove(`${BUTTON_CLASS_PREFIX}saving`);
          btn.classList.add(`${BUTTON_CLASS_PREFIX}saved`);
          const label = btn.querySelector('.xoe-btn-label');
          const icon = btn.querySelector('.xoe-btn-icon');
          if (label) label.textContent = '保存済';
          if (icon) icon.innerHTML = ICON_CHECK;
          btn.disabled = true;
        }
      }
    }

    // Single thread deleted
    if (msg.type === 'THREAD_DELETED' && msg.threadId) {
      resetSaveButton(String(msg.threadId));
    }

    // Batch threads deleted
    if (msg.type === 'THREADS_DELETED' && Array.isArray(msg.threadIds)) {
      msg.threadIds.forEach(id => resetSaveButton(String(id)));
    }

    // All threads deleted
    if (msg.type === 'ALL_THREADS_DELETED') {
      resetAllSaveButtons();
    }
  });
})();
