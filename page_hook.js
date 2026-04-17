// X Offline Enhancer — MAIN world hook
// X の GraphQL / REST API レスポンスから video_info.variants を抽出し、
// content_script (isolated world) に window.postMessage で渡す。
//
// これにより Performance Observer では拾えない:
// 1. X API が提示する progressive mp4 variant (低〜中解像度の再生可能 mp4)
// 2. HLS m3u8 URL
// を確実に取得できる。

(function () {
  'use strict';

  const PREFIX = '[XOE-HOOK]';
  const seenUrls = new Set();

  function postVariant(url, kind, extra) {
    if (!url || typeof url !== 'string') return;
    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    window.postMessage({
      type: 'XOE_VIDEO_VARIANT',
      url,
      kind,
      ...(extra || {})
    }, '*');
  }

  function scanObject(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 12) return;
    if (Array.isArray(obj)) {
      for (const item of obj) scanObject(item, depth + 1);
      return;
    }

    const vi = obj.video_info;
    if (vi && Array.isArray(vi.variants)) {
      for (const v of vi.variants) {
        if (!v || !v.url) continue;
        const isMp4 = v.content_type === 'video/mp4' || /\.mp4(?:[?#]|$)/.test(v.url);
        const isHls = v.content_type === 'application/x-mpegURL' || /\.m3u8(?:[?#]|$)/.test(v.url);
        if (isMp4) postVariant(v.url, 'mp4', { bitrate: v.bitrate });
        else if (isHls) postVariant(v.url, 'hls');
      }
    }

    for (const key in obj) {
      const val = obj[key];
      if (val && typeof val === 'object') scanObject(val, depth + 1);
    }
  }

  function tryExtract(bodyText, url) {
    if (!bodyText || bodyText.length < 2) return;
    try {
      const data = JSON.parse(bodyText);
      scanObject(data);
    } catch {
      // Not JSON — ignore
    }
  }

  // ─── fetch hook ───────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const resp = await origFetch.apply(this, arguments);
    try {
      const reqUrl = typeof input === 'string' ? input : (input?.url || '');
      if (reqUrl && (reqUrl.includes('/graphql/') || reqUrl.includes('/i/api/') || reqUrl.includes('TweetResult') || reqUrl.includes('TweetDetail'))) {
        resp.clone().text().then((txt) => tryExtract(txt, reqUrl)).catch(() => {});
      }
    } catch {}
    return resp;
  };

  // ─── XMLHttpRequest hook ──────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__xoeUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const url = this.__xoeUrl || '';
    if (url && (url.includes('/graphql/') || url.includes('/i/api/') || url.includes('TweetResult') || url.includes('TweetDetail'))) {
      this.addEventListener('load', () => {
        try {
          const body = this.responseType === '' || this.responseType === 'text' ? this.responseText : null;
          if (body) tryExtract(body, url);
        } catch {}
      });
    }
    return origSend.apply(this, arguments);
  };

  console.log(PREFIX, 'installed');
})();
