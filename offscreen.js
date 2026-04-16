/**
 * Offscreen Document - PDF Generation
 *
 * Receives GENERATE_PDF { threadId } messages, reads the thread + image blobs
 * directly from IndexedDB (via lib/db-esm.js), reconstructs the render tree
 * with blob: object URLs, then produces a PDF via html2canvas + jsPDF.
 *
 * Image index contract with service_worker.js (task #7):
 *   image_blobs key = tweetIdx * 10000 + imgIdx
 * where tweetIdx is the tweet's position in the thread and imgIdx is the
 * image's position within that tweet. buildThreadHTML decodes this directly.
 */

const ALLOWED_IMAGE_HOSTS = ['pbs.twimg.com', 'abs.twimg.com', 'video.twimg.com'];

function isAllowedImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('data:image/')) return true;
  if (url.startsWith('blob:')) return true;
  try { return ALLOWED_IMAGE_HOSTS.includes(new URL(url).hostname); }
  catch { return false; }
}

// lib/db.js is an ES module (it uses static `import` from ./db-esm.js) so it
// cannot be loaded via a classic <script src="lib/db.js"> tag. Instead we
// dynamic-import lib/db-esm.js directly from this classic script. The promise
// is memoized so concurrent GENERATE_PDF requests share one module instance.
let dbModulePromise = null;
function loadDb() {
  if (!dbModulePromise) {
    dbModulePromise = import('./lib/db-esm.js');
  }
  return dbModulePromise;
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'GENERATE_PDF') return;
  const threadId = message.threadId;
  const filenameHint = message.filename;
  if (!threadId) {
    chrome.runtime.sendMessage({
      type: 'PDF_ERROR',
      error: 'GENERATE_PDF missing threadId',
      threadId: null
    });
    return;
  }
  generatePDF(threadId, filenameHint)
    .then(({ storageKey, filename, size }) => {
      chrome.runtime.sendMessage({
        type: 'PDF_GENERATED',
        threadId,
        storageKey,
        filename,
        size
      });
    })
    .catch((err) => {
      chrome.runtime.sendMessage({
        type: 'PDF_ERROR',
        error: err && err.message ? err.message : String(err),
        threadId
      });
    });
});

/**
 * Build HTML string from thread data for rendering.
 * Image addressing: service_worker.js (task #7) writes each image_blobs row
 * with `index = tweetIdx * 10000 + imgIdx`. Here we iterate tweets with their
 * zero-based position T and each tweet's images with per-tweet position I,
 * then look up `imageUrlMap.get(T * 10000 + I)` for a blob: object URL.
 * Fallbacks: legacy base64 imageCache (pre-v3) → bare remote URL.
 */
function buildThreadHTML(threadData, imageUrlMap, legacyCache) {
  const tweets = threadData.tweets || [];
  const author = tweets[0]?.author || {};

  let html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                padding: 20px; color: #0f1419; background: #fff;">
      <div style="border-bottom: 2px solid #1d9bf0; padding-bottom: 12px; margin-bottom: 16px;">
        <div style="font-size: 18px; font-weight: bold;">${escapeHTML(author.name || 'Unknown')}</div>
        <div style="font-size: 14px; color: #536471;">@${escapeHTML(author.handle || 'unknown')}</div>
      </div>
  `;

  for (let tweetIdx = 0; tweetIdx < tweets.length; tweetIdx++) {
    const tweet = tweets[tweetIdx];
    html += `<div style="margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid #eff3f4;">`;
    html += `<div style="font-size: 15px; line-height: 1.5; white-space: pre-wrap;">${escapeHTML(tweet.text || '')}</div>`;

    if (Array.isArray(tweet.images) && tweet.images.length > 0) {
      for (let imgIdx = 0; imgIdx < tweet.images.length; imgIdx++) {
        const imgUrl = tweet.images[imgIdx];
        if (!isAllowedImageUrl(imgUrl)) continue;
        const compositeKey = tweetIdx * 10000 + imgIdx;
        const fromBlob = imageUrlMap.get(compositeKey);
        const fromLegacy = legacyCache ? legacyCache[imgUrl] : null;
        const src = fromBlob || fromLegacy || imgUrl;
        if (isAllowedImageUrl(src)) {
          html += `<img src="${escapeAttr(src)}" style="max-width: 100%; margin-top: 8px; border-radius: 12px;" crossorigin="anonymous" />`;
        }
      }
    }

    if (tweet.timestamp) {
      html += `<div style="font-size: 13px; color: #536471; margin-top: 8px;">${escapeHTML(tweet.timestamp)}</div>`;
    }

    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function escapeHTML(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function waitForImages(container) {
  const images = container.querySelectorAll('img');
  if (images.length === 0) return Promise.resolve();

  const timeout = new Promise((resolve) => setTimeout(resolve, 10000));
  const allLoaded = Promise.all(
    Array.from(images).map(img => {
      if (img.complete) return Promise.resolve();
      return new Promise((resolve) => {
        img.onload = resolve;
        img.onerror = resolve;
      });
    })
  );
  return Promise.race([allLoaded, timeout]);
}

/**
 * Generate PDF for a thread stored in IndexedDB.
 * - Fetches thread record + image blobs via lib/db-esm.js
 * - Creates blob: object URLs for each image, cleaned up in finally{}
 * - Tolerates legacy pre-v3 threads that still carry inline base64 imageCache
 */
async function generatePDF(threadId, filenameHint) {
  const db = await loadDb();

  const thread = await db.getThread(threadId);
  if (!thread) throw new Error(`Thread not found in IDB: ${threadId}`);

  const imageRecords = await db.getImagesForThread(threadId);

  const imageUrlMap = new Map();
  const createdObjectUrls = [];
  const renderArea = document.getElementById('render-area');
  let canvas = null;

  try {
    for (const rec of imageRecords) {
      if (rec && rec.blob) {
        const url = URL.createObjectURL(rec.blob);
        createdObjectUrls.push(url);
        imageUrlMap.set(rec.index, url);
      }
    }

    // backward compat for pre-v3 base64 imageCache — only consulted when the
    // image_blobs store returned nothing for this thread (or for individual
    // missing indexes inside buildThreadHTML).
    const legacyCache = thread.imageCache && typeof thread.imageCache === 'object'
      ? thread.imageCache
      : null;

    renderArea.innerHTML = buildThreadHTML(thread, imageUrlMap, legacyCache);

    await waitForImages(renderArea);
    await new Promise(r => setTimeout(r, 100));

    canvas = await html2canvas(renderArea, {
      scale: 1.5,
      useCORS: true,
      allowTaint: false,
      backgroundColor: '#ffffff',
      width: 595,
      windowWidth: 595
    });

    const imageData = canvas.toDataURL('image/jpeg', 0.92);

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'pt', 'a4');

    const pageWidth = 595;
    const pageHeight = 842;
    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    let heightLeft = imgHeight;
    let position = 0;

    pdf.addImage(imageData, 'JPEG', 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;

    while (heightLeft > 0) {
      position -= pageHeight;
      pdf.addPage();
      pdf.addImage(imageData, 'JPEG', 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }

    // jsPDF data-URI format: "data:application/pdf;filename=generated.pdf;base64,<...>"
    // Strip to the raw base64 segment so sidepanel can reconstruct a Blob
    // without needing to parse the URI format.
    const dataUri = pdf.output('datauristring');
    const commaIdx = dataUri.indexOf(',');
    const base64 = commaIdx >= 0 ? dataUri.substring(commaIdx + 1) : dataUri;
    const filename = filenameHint || `thread-${threadId}.pdf`;
    // Approximate decoded byte size from base64 length (pre-padding adjust
    // unnecessary for display-only metadata).
    const size = Math.floor((base64.length * 3) / 4);

    const storageKey = `pdf:${threadId}:${Date.now()}`;
    await chrome.storage.session.set({
      [storageKey]: { base64, filename, size }
    });

    return { storageKey, filename, size };
  } finally {
    // Always free object URLs and DOM/canvas memory, even on failure, so a
    // crash mid-render can't leak blob references for the lifetime of the
    // offscreen document.
    if (renderArea) renderArea.innerHTML = '';
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    for (const url of createdObjectUrls) {
      try { URL.revokeObjectURL(url); } catch { /* noop */ }
    }
  }
}
