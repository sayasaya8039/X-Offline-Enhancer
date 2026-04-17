/**
 * X Offline Enhancer - Content Script
 * Injects Save/PiP buttons into tweets and extracts thread data.
 */

(function () {
  'use strict';

  const DEBUG = false;
  function log(...args) { if (DEBUG) console.log('[XOE]', ...args); }

  if (DEBUG) log('Content script loaded on', location.href);

  const PROCESSED_ATTR = 'data-xoe-processed';
  const BUTTON_CLASS_PREFIX = 'xoe-';
  // Map<tweetId, containerEl|null> — presence marks saved; value is cached container reference.
  const savedTweetIds = new Map();

  const MAX_IMAGES = 50;
  const MAX_VIDEOS_PER_THREAD = 10;

  try { performance.setResourceTimingBufferSize(1000); } catch {}

  // ── Video URL cache (PerformanceObserver) ────────────────

  // Keeps all discovered mp4 variants per media id so save logic can fall back
  // to lower resolutions when larger variants exceed the IndexedDB size budget.
  const videoUrlCache = new Map(); // mediaId -> Map<url, { url, res }>
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        rememberVideoVariant(entry.name);
      }
    }).observe({ type: 'resource', buffered: true });
  } catch {}

  // ── Helpers ──────────────────────────────────────────────

  function isAllowedImageUrl(url) {
    if (!url) return false;
    if (url.startsWith('data:image/')) return true;
    return url.startsWith('https://pbs.twimg.com/')
        || url.startsWith('https://abs.twimg.com/')
        || url.startsWith('https://video.twimg.com/');
  }

  function isExternalVideoUrl(url) {
    if (!url) return false;
    try {
      const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      return host === 'youtube.com'
        || host === 'm.youtube.com'
        || host === 'youtu.be'
        || host === 'youtube-nocookie.com';
    } catch {
      return false;
    }
  }

  function findExternalVideoUrl(articleEl) {
    if (!articleEl?.querySelectorAll) return null;
    for (const link of articleEl.querySelectorAll('a[href]')) {
      const href = link?.href || '';
      if (isExternalVideoUrl(href)) return href;
    }
    return null;
  }

  function findStatusVideoLink(articleEl) {
    if (!articleEl?.querySelectorAll) return null;
    for (const link of articleEl.querySelectorAll('a[href]')) {
      const href = link?.href || '';
      const match = href.match(/\/status\/(\d+)\/video\/\d+/);
      if (match) {
        return { href, tweetId: match[1] };
      }
    }
    return null;
  }

  function resolveExternalVideoUrl(articleEl, currentTweetId, videoEl, sourceEl, videoPlayerEl) {
    if (!videoPlayerEl) return null;
    if (videoEl || sourceEl) return null;
    const statusVideoLink = findStatusVideoLink(articleEl);
    if (statusVideoLink) {
      return String(statusVideoLink.tweetId) === String(currentTweetId)
        ? null
        : statusVideoLink.href;
    }
    return findExternalVideoUrl(articleEl);
  }

  function extractVideoMediaId(url) {
    if (!url) return null;
    const str = String(url);
    // 数値ID系: ext_tw_video(_thumb)/ amplify_video(_thumb)/ tweet_video_thumb
    const numeric = str.match(/\/(?:ext_tw_video(?:_thumb)?|amplify_video(?:_thumb)?|tweet_video_thumb)\/(\d+)/);
    if (numeric) return numeric[1];
    // tweet_video (GIF本体) はファイル名がハッシュID
    const gif = str.match(/\/tweet_video\/([A-Za-z0-9_\-]+)\.mp4(?:[?#]|$)/);
    return gif ? gif[1] : null;
  }

  function getVideoResolutionScore(url) {
    const match = String(url).match(/\/(\d+)x(\d+)\//);
    if (!match) return 0;
    return parseInt(match[1], 10) * parseInt(match[2], 10);
  }

  function isDirectVideoVariant(url) {
    if (typeof url !== 'string') return false;
    if (!url.startsWith('https://video.twimg.com/')) return false;
    if (!/\.mp4(?:[?#]|$)/.test(url)) return false;
    // ext_tw_video / amplify_video は /vid/ 配下、tweet_video (GIF) は /tweet_video/ 配下
    return url.includes('/vid/') || url.includes('/tweet_video/');
  }

  function isFetchableVideoCandidate(url) {
    return isDirectVideoVariant(url);
  }

  function rememberVideoVariant(url) {
    if (!isDirectVideoVariant(url)) return null;
    const mediaId = extractVideoMediaId(url);
    if (!mediaId) return null;

    let variants = videoUrlCache.get(mediaId);
    if (!variants) {
      variants = new Map();
      videoUrlCache.set(mediaId, variants);
    }
    if (!variants.has(url)) {
      variants.set(url, {
        url,
        res: getVideoResolutionScore(url)
      });
    }
    return mediaId;
  }

  function getVideoCandidatesForMediaId(mediaId) {
    const variants = mediaId ? videoUrlCache.get(mediaId) : null;
    if (!variants) return [];
    return [...variants.values()]
      .sort((a, b) => a.res - b.res)
      .map((entry) => entry.url);
  }

  function extractTweetId(articleEl) {
    const timeEl = articleEl.querySelector('time');
    const timeLink = timeEl?.closest?.('a[href*="/status/"]');
    if (timeLink?.href) {
      const timeMatch = timeLink.href.match(/\/status\/(\d+)/);
      if (timeMatch) return timeMatch[1];
    }

    const links = articleEl.querySelectorAll('a[href*="/status/"]');
    for (const link of links) {
      const match = link.href.match(/\/status\/(\d+)/);
      if (match) return match[1];
    }
    return null;
  }

  function normalizeTweetText(value) {
    const str = String(value ?? '');
    if (!str.includes('\n') && !str.includes('\u00a0') && !str.includes('\r')) {
      return str.trim();
    }
    return str
      .replace(/\r\n/g, '\n')
      .replace(/\u00a0/g, ' ')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
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
    // Cache hit (only reuse if video URL already resolved when hasVideo).
    const cached = articleEl.__xoeCache;
    if (cached && (!cached.hasVideo || cached.videoUrl)) return cached;

    const id = extractTweetId(articleEl);
    if (!id) return null;

    // Single-sweep query — avoids 6-8 separate querySelector calls per article.
    const nodes = articleEl.querySelectorAll('[data-testid], div[lang], time, img, video, source');
    let tweetTextEl = null, userNameEl = null, videoPlayerEl = null, timeEl = null;
    let videoEl = null, sourceEl = null;
    const langNodes = [];
    const imgs = [];

    for (const node of nodes) {
      const tag = node.tagName;
      if (tag === 'TIME') { if (!timeEl) timeEl = node; continue; }
      if (tag === 'IMG') { imgs.push(node); continue; }
      if (tag === 'VIDEO') { if (!videoEl) videoEl = node; continue; }
      if (tag === 'SOURCE') { if (!sourceEl) sourceEl = node; continue; }
      if (tag === 'DIV' && node.hasAttribute('lang')) langNodes.push(node);

      const testid = node.getAttribute('data-testid');
      if (!testid) continue;
      if (testid === 'tweetText' && !tweetTextEl) tweetTextEl = node;
      else if (testid === 'User-Name' && !userNameEl) userNameEl = node;
      else if (testid === 'videoPlayer' && !videoPlayerEl) videoPlayerEl = node;
    }

    // Text
    let text = '', textSource = 'missing';
    if (tweetTextEl) {
      text = normalizeTweetText(tweetTextEl.innerText || tweetTextEl.textContent || '');
      textSource = 'tweetText';
    } else if (langNodes.length > 0) {
      const parts = langNodes
        .map((n) => normalizeTweetText(n.innerText || n.textContent || ''))
        .filter(Boolean);
      if (parts.length > 0) {
        text = [...new Set(parts)].join('\n');
        textSource = 'lang';
      }
    }

    // Author
    let name = '', handle = '';
    if (userNameEl) {
      const handleMatch = (userNameEl.textContent || '').match(/@([A-Za-z0-9_]+)/);
      if (handleMatch) handle = handleMatch[1];
      const nameLink = userNameEl.querySelector('a');
      if (nameLink) {
        const firstSpan = nameLink.querySelector('span');
        if (firstSpan) name = firstSpan.textContent.trim();
      }
    }

    // Avatar
    let avatarUrl = '';
    for (const img of imgs) {
      const src = img.src || '';
      if (src.includes('pbs.twimg.com/profile_images')
          || src.includes('abs.twimg.com/sticky/default_profile_images')) {
        avatarUrl = src;
        break;
      }
    }

    const timestamp = timeEl ? timeEl.getAttribute('datetime') : '';

    // Media images (filter in JS — avoids attribute-selector regex cost).
    const images = [];
    const seenImgs = new Set();
    for (const img of imgs) {
      const src = img.src || '';
      if (src.includes('pbs.twimg.com/media') && !seenImgs.has(src)) {
        seenImgs.add(src);
        images.push(src);
      }
    }

    const hasVideo = articleEl.dataset.xoeHasVideo === '1' || !!videoEl || !!videoPlayerEl;
    if (hasVideo) articleEl.dataset.xoeHasVideo = '1';

    const videoDetails = hasVideo
      ? findVideoDetailsFromNodes(articleEl, videoEl, sourceEl, videoPlayerEl)
      : { videoUrl: null, videoMediaId: null, videoCandidates: [] };
    const externalVideoUrl = hasVideo
      ? resolveExternalVideoUrl(articleEl, id, videoEl, sourceEl, videoPlayerEl)
      : null;

    const data = {
      id,
      text,
      textSource,
      author: { name, handle, avatarUrl },
      timestamp,
      images,
      hasVideo,
      videoUrl: videoDetails.videoUrl,
      videoMediaId: videoDetails.videoMediaId,
      videoCandidates: videoDetails.videoCandidates,
      externalVideoUrl
    };
    articleEl.__xoeCache = data;
    return data;
  }

  function findVideoUrlFromNodes(articleEl, videoEl, sourceEl, videoPlayerEl) {
    return findVideoDetailsFromNodes(articleEl, videoEl, sourceEl, videoPlayerEl).videoUrl;
  }

  function findVideoDetailsFromNodes(articleEl, videoEl, sourceEl, videoPlayerEl) {
    const directCandidates = [
      videoEl?.currentSrc,
      videoEl?.src,
      sourceEl?.src
    ];
    for (const candidate of directCandidates) {
      if (!candidate || candidate.startsWith('blob:') || !isAllowedImageUrl(candidate)) continue;
      if (isDirectVideoVariant(candidate)) {
        const mediaId = rememberVideoVariant(candidate) || extractVideoMediaId(candidate);
        const candidates = mediaId ? getVideoCandidatesForMediaId(mediaId) : [candidate];
        return {
          videoUrl: candidate,
          videoMediaId: mediaId,
          videoCandidates: candidates.length > 0 ? candidates : [candidate]
        };
      }
      const mediaId = extractVideoMediaId(candidate);
      const candidates = mediaId ? getVideoCandidatesForMediaId(mediaId) : [];
      if (candidates.length > 0) {
        return {
          videoUrl: candidates[candidates.length - 1],
          videoMediaId: mediaId,
          videoCandidates: candidates
        };
      }
    }

    const posterCandidates = [];
    if (videoEl?.poster) posterCandidates.push(videoEl.poster);
    if (videoPlayerEl?.querySelectorAll) {
      for (const img of videoPlayerEl.querySelectorAll('img')) {
        if (img?.src) posterCandidates.push(img.src);
      }
    }
    if (articleEl?.querySelectorAll) {
      for (const img of articleEl.querySelectorAll('img')) {
        if (img?.src) posterCandidates.push(img.src);
      }
    }

    for (const candidate of posterCandidates) {
      const mediaId = extractVideoMediaId(candidate);
      if (!mediaId) continue;
      const candidates = getVideoCandidatesForMediaId(mediaId);
      if (candidates.length > 0) {
        return {
          videoUrl: candidates[candidates.length - 1],
          videoMediaId: mediaId,
          videoCandidates: candidates
        };
      }
    }
    return {
      videoUrl: null,
      videoMediaId: null,
      videoCandidates: []
    };
  }

  // Pending な動画ツイートのロードを能動的にトリガー
  // (PerformanceObserver が mp4 URL を拾えるよう、未再生動画に対し muted play → pause を実行)
  function triggerPendingVideoLoads(pendingIds) {
    const triggered = [];
    document.querySelectorAll('article[data-testid="tweet"], article[role="article"]').forEach((articleEl) => {
      const tweetId = extractTweetId(articleEl);
      if (!tweetId || !pendingIds.has(tweetId)) return;
      const videoEl = articleEl.querySelector('video');
      if (!videoEl) return;
      try {
        videoEl.muted = true;
        const playResult = videoEl.play();
        triggered.push({ videoEl, playResult });
      } catch {}
    });
    // 少しだけ再生してネットワーク要求を発生させ、すぐ一時停止
    for (const { videoEl, playResult } of triggered) {
      Promise.resolve(playResult).then(() => {
        setTimeout(() => {
          try { videoEl.pause(); } catch {}
        }, 300);
      }).catch(() => {});
    }
  }

  async function enrichPendingVideoTweets(tweets) {
    const pending = tweets.filter((tweet) => tweet?.hasVideo && (!tweet.videoCandidates || tweet.videoCandidates.length === 0));
    if (pending.length === 0) return;

    const pendingIds = new Set(pending.map((tweet) => tweet.id));
    triggerPendingVideoLoads(pendingIds);
    const deadline = Date.now() + 3000;

    while (Date.now() < deadline) {
      let updatedAny = false;
      document.querySelectorAll('article[data-testid="tweet"], article[role="article"]').forEach((articleEl) => {
        const tweetId = extractTweetId(articleEl);
        if (!tweetId || !pendingIds.has(tweetId)) return;
        const refreshed = extractTweetData(articleEl);
        if (!refreshed?.videoCandidates?.length) return;
        const target = tweets.find((tweet) => tweet.id === tweetId);
        if (!target) return;
        target.videoUrl = refreshed.videoUrl;
        target.videoMediaId = refreshed.videoMediaId;
        target.videoCandidates = refreshed.videoCandidates;
        updatedAny = true;
      });

      if (pending.every((tweet) => Array.isArray(tweet.videoCandidates) && tweet.videoCandidates.length > 0)) {
        return;
      }
      if (!updatedAny) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }

  function buildVideoSaveEntries(tweets) {
    return tweets
      .map((tweet, tweetIdx) => {
        if (tweet.externalVideoUrl) return null;

        const candidates = [];
        const pushCandidate = (url) => {
          if (url && isFetchableVideoCandidate(url) && !candidates.includes(url)) {
            candidates.push(url);
          }
        };

        (tweet.videoCandidates || []).forEach(pushCandidate);
        if ((!tweet.videoCandidates || tweet.videoCandidates.length === 0) && tweet.videoMediaId) {
          getVideoCandidatesForMediaId(tweet.videoMediaId).forEach(pushCandidate);
        }
        pushCandidate(tweet.videoUrl);

        if (!tweet.hasVideo || candidates.length === 0) return null;
        return {
          tweetIdx,
          mediaId: tweet.videoMediaId || null,
          urls: candidates.slice(0, MAX_VIDEOS_PER_THREAD)
        };
      })
      .filter(Boolean)
      .slice(0, MAX_VIDEOS_PER_THREAD);
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
      || document.querySelector('main');

    if (!scopeRoot) {
      const only = extractTweetData(rootArticle);
      return only ? [only] : [];
    }

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

      await enrichPendingVideoTweets(tweets);

      log('Saving thread:', tweetId, 'tweets:', tweets.length);

      const imageUrls = [];
      let imgCount = 0;
      tweets.forEach((tweet, tweetIdx) => {
        tweet.images.forEach((imgUrl, imgIdx) => {
          if (imgCount >= MAX_IMAGES) return;
          if (isAllowedImageUrl(imgUrl)) {
            imageUrls.push({ tweetIdx, imgIdx, url: imgUrl });
            imgCount++;
          }
        });
      });

      const videoEntries = buildVideoSaveEntries(tweets);

      const threadData = {
        id: tweetId,
        url: window.location.href,
        tweets,
        imageUrls,
        videoUrls: videoEntries,
        timestamp: Date.now(),
        tags: []
      };

      const response = await chrome.runtime.sendMessage({ type: 'SAVE_THREAD', data: threadData });

      if (response && response.success) {
        const container = btn.closest('.xoe-actions');
        savedTweetIds.set(tweetId, container || null);
        if (btn.isConnected) {
          btn.classList.remove(`${BUTTON_CLASS_PREFIX}saving`);
          btn.classList.add(`${BUTTON_CLASS_PREFIX}saved`);
          if (iconEl?.isConnected) iconEl.innerHTML = ICON_CHECK;
        }

        if (videoEntries.length > 0) {
          if (labelEl?.isConnected) labelEl.textContent = '動画取得中…';
          chrome.runtime.sendMessage(
            { type: 'FETCH_VIDEOS', threadId: tweetId, videoUrls: videoEntries },
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

  function createButton(labelText, iconSvg, className, action) {
    const btn = document.createElement('button');
    btn.className = `${BUTTON_CLASS_PREFIX}btn ${BUTTON_CLASS_PREFIX}${className}`;
    btn.type = 'button';
    btn.dataset.xoeAction = action;
    const iconSpan = document.createElement('span');
    iconSpan.className = 'xoe-btn-icon';
    iconSpan.innerHTML = iconSvg;
    const labelSpan = document.createElement('span');
    labelSpan.className = 'xoe-btn-label';
    labelSpan.textContent = labelText;
    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);
    return btn;
  }

  function findActionBar(article) {
    try {
      const bar = article.querySelector(
        '[role="group"]:has([data-testid="reply"], [data-testid="retweet"], [data-testid="like"], [data-testid="bookmark"])'
      );
      if (bar) return bar;
    } catch {}
    const groups = article.querySelectorAll('[role="group"]');
    if (groups.length > 0) return groups[groups.length - 1];
    return article.querySelector('[role="toolbar"]') || null;
  }

  function injectButtons(article) {
    if (article.hasAttribute(PROCESSED_ATTR)) return;

    const actionBar = findActionBar(article);
    if (!actionBar) return;

    const tweetId = extractTweetId(article);

    // Detect video once at injection time and stamp the article so Save path
    // can skip a re-scan (H15).
    const hasVideo = !!(article.querySelector('video') || article.querySelector('[data-testid="videoPlayer"]'));
    if (hasVideo) article.dataset.xoeHasVideo = '1';

    const container = document.createElement('div');
    container.className = `${BUTTON_CLASS_PREFIX}actions`;
    if (tweetId) container.dataset.tweetId = tweetId;

    const isSaved = tweetId && savedTweetIds.has(tweetId);
    const saveBtn = createButton(
      isSaved ? '保存済' : '保存',
      isSaved ? ICON_CHECK : ICON_BOOKMARK,
      isSaved ? 'save-btn xoe-saved' : 'save-btn',
      'save'
    );
    if (isSaved) saveBtn.disabled = true;
    container.appendChild(saveBtn);

    if (hasVideo && isPiPSupported()) {
      const pipBtn = createButton('PiP', ICON_PIP, 'pip-btn', 'pip');
      container.appendChild(pipBtn);
    }

    actionBar.appendChild(container);
    article.setAttribute(PROCESSED_ATTR, 'true');

    if (tweetId && isSaved) savedTweetIds.set(tweetId, container);
  }

  // ── Event Delegation (single global listener) ────────────

  function globalClickHandler(e) {
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    const btn = target.closest('.xoe-btn');
    if (!btn) return;
    const article = btn.closest('article');
    if (!article) return;
    const action = btn.dataset.xoeAction;
    e.stopPropagation();
    e.preventDefault();
    if (action === 'save') {
      handleSave(article, btn);
    } else if (action === 'pip') {
      handlePiP(article);
    }
  }
  document.addEventListener('click', globalClickHandler, true);

  // ── Observer ─────────────────────────────────────────────

  let processTimer = null;
  const pendingArticles = new Set();

  function processInitialTweets() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const a of articles) {
      if (!a.hasAttribute(PROCESSED_ATTR)) injectButtons(a);
    }
    if (articles.length === 0) {
      const fallback = document.querySelectorAll('article[role="article"]');
      for (const a of fallback) {
        if (!a.hasAttribute(PROCESSED_ATTR)) injectButtons(a);
      }
    }
  }

  function scheduleLowPriority(fn) {
    if (typeof scheduler !== 'undefined' && typeof scheduler.postTask === 'function') {
      try { scheduler.postTask(fn, { priority: 'background' }); return; } catch {}
    }
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(fn, { timeout: 500 });
      return;
    }
    setTimeout(fn, 0);
  }

  function flushPending() {
    const articles = [...pendingArticles];
    pendingArticles.clear();
    for (const a of articles) {
      scheduleLowPriority(() => {
        if (a.isConnected && !a.hasAttribute(PROCESSED_ATTR)) {
          injectButtons(a);
        }
      });
    }
  }

  function queueArticle(a) {
    if (!a || a.hasAttribute(PROCESSED_ATTR)) return;
    pendingArticles.add(a);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1 || !node.querySelectorAll) continue;
        const ancestorArticle = typeof node.closest === 'function'
          ? node.closest('article[data-testid="tweet"], article[role="article"]')
          : null;
        if (ancestorArticle && !ancestorArticle.hasAttribute(PROCESSED_ATTR)) {
          queueArticle(ancestorArticle);
        }
        const articles = node.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
        for (const a of articles) {
          if (!a.hasAttribute(PROCESSED_ATTR)) queueArticle(a);
        }
      }
    }
    if (pendingArticles.size === 0) return;
    if (processTimer) clearTimeout(processTimer);
    processTimer = setTimeout(flushPending, 200);
  });

  function waitForScope() {
    const immediate = document.querySelector('[data-testid="primaryColumn"]')
      || document.querySelector('[data-testid="cellInnerDiv"]')?.closest('section');
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      const mo = new MutationObserver(() => {
        const s = document.querySelector('[data-testid="primaryColumn"]')
          || document.querySelector('[data-testid="cellInnerDiv"]')?.closest('section');
        if (s) { mo.disconnect(); resolve(s); }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  async function startObserving() {
    log('Waiting for primaryColumn scope');
    const timeline = await waitForScope();
    log('Starting observer');
    processInitialTweets();
    observer.observe(timeline, { childList: true, subtree: true });
  }

  // ── Init ─────────────────────────────────────────────────

  // Start observer (awaits primaryColumn); restore saved IDs in parallel.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { startObserving(); });
  } else {
    startObserving();
  }

  try {
    chrome.runtime.sendMessage({ type: 'GET_SAVED_IDS' }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[XOE] GET_SAVED_IDS failed:', chrome.runtime.lastError.message);
        return;
      }
      if (response?.success && Array.isArray(response.ids)) {
        for (const id of response.ids) {
          const sid = String(id);
          if (!savedTweetIds.has(sid)) savedTweetIds.set(sid, null);
        }
        log('Restored', savedTweetIds.size, 'saved IDs');
      }
    });
  } catch (err) {
    console.warn('[XOE] sendMessage error:', err);
  }

  // ── Button Reset Helpers ──────────────────────────────────

  function getContainer(tweetId) {
    const cached = savedTweetIds.get(tweetId);
    if (cached && cached.isConnected) return cached;
    return document.querySelector(`.xoe-actions[data-tweet-id="${CSS.escape(tweetId)}"]`);
  }

  function resetSaveButton(tweetId) {
    const container = getContainer(tweetId);
    savedTweetIds.delete(tweetId);
    if (!container) return;
    const btn = container.querySelector('.xoe-save-btn');
    if (!btn) return;
    btn.classList.remove(`${BUTTON_CLASS_PREFIX}saving`, `${BUTTON_CLASS_PREFIX}saved`);
    const label = btn.querySelector('.xoe-btn-label');
    const icon = btn.querySelector('.xoe-btn-icon');
    if (label) label.textContent = '保存';
    if (icon) icon.innerHTML = ICON_BOOKMARK;
    btn.disabled = false;
  }

  function resetAllSaveButtons() {
    savedTweetIds.clear();
    document.querySelectorAll(`.${BUTTON_CLASS_PREFIX}saved`).forEach((btn) => {
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
      const id = String(msg.id);
      const container = getContainer(id);
      savedTweetIds.set(id, container || null);
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

    if (msg.type === 'THREAD_DELETED' && msg.threadId) {
      resetSaveButton(String(msg.threadId));
    }

    if (msg.type === 'THREADS_DELETED' && Array.isArray(msg.threadIds)) {
      for (const id of msg.threadIds) resetSaveButton(String(id));
    }

    if (msg.type === 'ALL_THREADS_DELETED') {
      resetAllSaveButtons();
    }
  });

  // ── Page-context Video Fetch (anti-hotlink bypass) ──────────
  //
  // Service Worker からの fetch は Referer/Cookie が無いため X CDN が
  // スタブ応答 (904 bytes 等) を返す。ページ内 fetch はブラウザが自動で
  // Referer=https://x.com/, Origin=https://x.com, Cookie を付与するため
  // 正規 player と同じリクエストとして扱われる。
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'FETCH_VIDEO_VIA_PAGE') return;
    (async () => {
      try {
        const resp = await fetch(msg.url, { credentials: 'include' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const ct = resp.headers.get('content-type') || '';
        if (!/^video\//i.test(ct)) throw new Error('unexpected content-type: ' + ct);
        const buf = await resp.arrayBuffer();
        if (buf.byteLength < 10240) throw new Error('response too small: ' + buf.byteLength);
        // ArrayBuffer を base64 文字列に変換 (chrome.runtime message は JSON 限定)
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunkSize = 0x8000; // 32KB ずつ fromCharCode (stack overflow 回避)
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binary);
        sendResponse({ ok: true, base64, contentType: ct, size: buf.byteLength });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true; // async response
  });
})();
