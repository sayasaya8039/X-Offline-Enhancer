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
  const MAX_SEEN_URLS = 1000;
  const MAX_RESPONSE_TEXT_CHARS = 5 * 1024 * 1024;
  const seenUrls = new Set();

  function rememberSeenUrl(url) {
    if (seenUrls.has(url)) {
      seenUrls.delete(url);
      seenUrls.add(url);
      return false;
    }

    seenUrls.add(url);
    if (seenUrls.size > MAX_SEEN_URLS) {
      const oldest = seenUrls.values().next().value;
      seenUrls.delete(oldest);
    }
    return true;
  }

  function postVariant(url, kind, extra) {
    if (!url || typeof url !== 'string') return;
    if (!rememberSeenUrl(url)) return;
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

  function isApiCandidate(url) {
    const str = String(url || '');
    return str.includes('/graphql/')
      || str.includes('/i/api/')
      || str.includes('TweetResult')
      || str.includes('TweetDetail');
  }

  function getHeader(headers, name) {
    try {
      if (headers && typeof headers.get === 'function') return headers.get(name) || '';
      if (headers && typeof headers.getResponseHeader === 'function') return headers.getResponseHeader(name) || '';
    } catch {}
    return '';
  }

  function shouldInspectHeaders(headers) {
    const contentLength = Number(getHeader(headers, 'content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_TEXT_CHARS) return false;

    const contentType = getHeader(headers, 'content-type');
    if (!contentType) return true;
    return /(?:json|graphql|javascript|text)/i.test(contentType);
  }

  function hasVariantSignal(bodyText) {
    return bodyText.includes('video_info')
      || bodyText.includes('variants')
      || bodyText.includes('video/mp4')
      || bodyText.includes('mpegURL')
      || bodyText.includes('.m3u8');
  }

  function tryExtract(bodyText, url) {
    if (!bodyText || bodyText.length < 2) return;
    if (!isApiCandidate(url)) return;
    if (bodyText.length > MAX_RESPONSE_TEXT_CHARS) return;
    if (!hasVariantSignal(bodyText)) return;
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
      if (isApiCandidate(reqUrl) && shouldInspectHeaders(resp.headers)) {
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
    if (isApiCandidate(url)) {
      this.addEventListener('load', () => {
        try {
          if (!shouldInspectHeaders(this)) return;
          const body = this.responseType === '' || this.responseType === 'text' ? this.responseText : null;
          if (body) tryExtract(body, url);
        } catch {}
      });
    }
    return origSend.apply(this, arguments);
  };

  console.log(PREFIX, 'installed');
})();
