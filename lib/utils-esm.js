/**
 * Shared Utilities for X Offline Enhancer (ES Module)
 */

export const DEBUG = false;

export function log(...args) {
  if (DEBUG) console.log('[XOE]', ...args);
}

export function logSW(...args) {
  if (DEBUG) console.log('[XOE-SW]', ...args);
}

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const escapeAttr = escapeHtml;

export const ALLOWED_IMAGE_DOMAINS = [
  'pbs.twimg.com',
  'abs.twimg.com',
  'video.twimg.com'
];

export function isAllowedImageUrl(url) {
  if (!url) return false;
  if (url.startsWith('data:image/')) return true;
  try {
    const parsed = new URL(url);
    return ALLOWED_IMAGE_DOMAINS.includes(parsed.hostname);
  } catch {
    return false;
  }
}
