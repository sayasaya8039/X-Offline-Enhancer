/**
 * Offscreen Document - PDF Generation
 * Receives GENERATE_PDF messages, renders thread HTML,
 * converts to canvas via html2canvas, then generates PDF with jsPDF.
 */

const ALLOWED_IMAGE_HOSTS = ['pbs.twimg.com', 'abs.twimg.com', 'video.twimg.com'];

function isAllowedImageUrl(url) {
  if (!url) return false;
  if (url.startsWith('data:image/')) return true;
  try { return ALLOWED_IMAGE_HOSTS.includes(new URL(url).hostname); }
  catch { return false; }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'GENERATE_PDF') return;
  generatePDF(message.threadData)
    .then((pdfBase64) => {
      chrome.runtime.sendMessage({
        type: 'PDF_GENERATED',
        pdfBase64,
        filename: message.filename || 'thread.pdf'
      });
    })
    .catch((err) => {
      chrome.runtime.sendMessage({
        type: 'PDF_ERROR',
        error: err.message
      });
    });
});

/**
 * Build HTML string from thread data for rendering.
 * All user-controlled text is escaped. Image src is validated.
 */
function buildThreadHTML(threadData) {
  const tweets = threadData.tweets || [];
  const author = tweets[0]?.author || {};
  const cache = threadData.imageCache || {};

  let html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                padding: 20px; color: #0f1419; background: #fff;">
      <div style="border-bottom: 2px solid #1d9bf0; padding-bottom: 12px; margin-bottom: 16px;">
        <div style="font-size: 18px; font-weight: bold;">${escapeHTML(author.name || 'Unknown')}</div>
        <div style="font-size: 14px; color: #536471;">@${escapeHTML(author.handle || 'unknown')}</div>
      </div>
  `;

  for (const tweet of tweets) {
    html += `<div style="margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid #eff3f4;">`;
    html += `<div style="font-size: 15px; line-height: 1.5; white-space: pre-wrap;">${escapeHTML(tweet.text || '')}</div>`;

    if (tweet.images && tweet.images.length > 0) {
      for (const imgUrl of tweet.images) {
        const src = cache[imgUrl] || imgUrl;
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

/**
 * Escape HTML special characters
 */
function escapeHTML(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape for use in HTML attribute values
 */
function escapeAttr(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Wait for all images in the render area to load (with timeout)
 */
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
 * Generate PDF from thread data.
 * - html2canvas scale reduced to 1.5 to save memory (H9)
 * - canvas.toDataURL() called once and cached (C4)
 * - Canvas explicitly freed after use
 */
async function generatePDF(threadData) {
  const renderArea = document.getElementById('render-area');

  // 1. Render HTML
  renderArea.innerHTML = buildThreadHTML(threadData);

  // 2. Wait for images to load
  await waitForImages(renderArea);

  // Small delay for rendering to settle
  await new Promise(r => setTimeout(r, 100));

  // 3. Convert to canvas via html2canvas (scale: 1.5 instead of 2)
  const canvas = await html2canvas(renderArea, {
    scale: 1.5,
    useCORS: true,
    allowTaint: false,
    backgroundColor: '#ffffff',
    width: 595,
    windowWidth: 595
  });

  // 4. Cache toDataURL result once (C4 fix - was called per page in loop)
  const imageData = canvas.toDataURL('image/jpeg', 0.92);

  // 5. Generate PDF with jsPDF (page splitting)
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF('p', 'pt', 'a4');

  const pageWidth = 595;
  const pageHeight = 842;
  const imgWidth = pageWidth;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;

  let heightLeft = imgHeight;
  let position = 0;

  // First page
  pdf.addImage(imageData, 'JPEG', 0, position, imgWidth, imgHeight);
  heightLeft -= pageHeight;

  // Additional pages
  while (heightLeft > 0) {
    position -= pageHeight;
    pdf.addPage();
    pdf.addImage(imageData, 'JPEG', 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
  }

  // 6. Return as Base64 data URI
  const pdfBase64 = pdf.output('datauristring');

  // 7. Clean up: clear render area and free canvas memory
  renderArea.innerHTML = '';
  canvas.width = 0;
  canvas.height = 0;

  return pdfBase64;
}
