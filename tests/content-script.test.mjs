import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadFunctionFromContentScript(functionName) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');
  const pattern = new RegExp(`function ${functionName}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`);
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Function not found in content_script.js: ${functionName}`);
  }

  const context = {};
  vm.runInNewContext(`${match[0]}; this.${functionName} = ${functionName};`, context);
  return context[functionName];
}

function loadInjectButtonsHarness() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');
  const match = source.match(/function injectButtons\(article\) \{[\s\S]*?\n  \}/);
  if (!match) {
    throw new Error('injectButtons not found in content_script.js');
  }

  const context = {
    PROCESSED_ATTR: 'data-xoe-processed',
    BUTTON_CLASS_PREFIX: 'xoe-',
    savedTweetIds: new Map(),
    ICON_CHECK: '<check />',
    ICON_BOOKMARK: '<bookmark />',
    ICON_PIP: '<pip />',
    extractTweetId: () => 'tweet-1',
    isPiPSupported: () => false,
    createButton: (labelText, iconSvg, className, action) => ({
      labelText,
      iconSvg,
      className,
      action,
      disabled: false
    }),
    document: {
      createElement: () => ({
        className: '',
        dataset: {},
        children: [],
        appendChild(child) {
          this.children.push(child);
        }
      })
    }
  };

  vm.runInNewContext(`${match[0]}; this.injectButtons = injectButtons;`, context);
  return context;
}

function loadObserverCallbackHarness() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');
  const match = source.match(/const observer = new MutationObserver\(\(mutations\) => \{([\s\S]*?)\n  \}\);/);
  if (!match) {
    throw new Error('MutationObserver callback not found in content_script.js');
  }

  const body = match[1];
  const context = {
    PROCESSED_ATTR: 'data-xoe-processed',
    pendingArticles: new Set(),
    processTimer: null,
    flushPending() {},
    clearTimeout() {},
    setTimeout() {
      return 1;
    }
  };
  context.queueArticle = (article) => {
    context.pendingArticles.add(article);
  };

  vm.runInNewContext(
    `this.runObserver = function(mutations) {${body}\n    };`,
    context
  );
  return context;
}

function loadFindVideoUrlHarness() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');
  const snippets = [
    /function extractVideoMediaId\([^)]*\) \{[\s\S]*?\n  \}/,
    /function getVideoResolutionScore\([^)]*\) \{[\s\S]*?\n  \}/,
    /function isDirectVideoVariant\([^)]*\) \{[\s\S]*?\n  \}/,
    /function rememberVideoVariant\([^)]*\) \{[\s\S]*?\n  \}/,
    /function getVideoCandidatesForMediaId\([^)]*\) \{[\s\S]*?\n  \}/,
    /function findVideoDetailsFromNodes\([^)]*\) \{[\s\S]*?\n  \}/,
    /function findVideoUrlFromNodes\([^)]*\) \{[\s\S]*?\n  \}/
  ].map((pattern) => {
    const match = source.match(pattern);
    if (!match) {
      throw new Error(`Required video helper not found in content_script.js: ${pattern}`);
    }
    return match[0];
  });
  if (snippets.length === 0) {
    throw new Error('video helpers not found in content_script.js');
  }

  const context = {
    videoUrlCache: new Map(),
    isAllowedImageUrl(url) {
      return typeof url === 'string' && (url.startsWith('https://video.twimg.com/') || url.startsWith('https://pbs.twimg.com/'));
    }
  };

  vm.runInNewContext(`${snippets.join('\n')}; this.findVideoUrlFromNodes = findVideoUrlFromNodes;`, context);
  return context;
}

test('extractTweetId prefers the article permalink over quoted tweet links', () => {
  const extractTweetId = loadFunctionFromContentScript('extractTweetId');

  const ownPermalink = { href: 'https://x.com/alice/status/2222222222222222222' };
  const quotedPermalink = { href: 'https://x.com/bob/status/1111111111111111111' };
  const timeEl = {
    closest(selector) {
      assert.equal(selector, 'a[href*="/status/"]');
      return ownPermalink;
    }
  };

  const articleEl = {
    querySelector(selector) {
      assert.equal(selector, 'time');
      return timeEl;
    },
    querySelectorAll(selector) {
      assert.equal(selector, 'a[href*="/status/"]');
      return [quotedPermalink, ownPermalink];
    }
  };

  assert.equal(extractTweetId(articleEl), '2222222222222222222');
});

test('extractTweetId falls back to the first status link when no permalink time exists', () => {
  const extractTweetId = loadFunctionFromContentScript('extractTweetId');

  const articleEl = {
    querySelector(selector) {
      assert.equal(selector, 'time');
      return null;
    },
    querySelectorAll(selector) {
      assert.equal(selector, 'a[href*="/status/"]');
      return [
        { href: 'https://x.com/alice/status/3333333333333333333' },
        { href: 'https://x.com/alice/status/4444444444444444444' }
      ];
    }
  };

  assert.equal(extractTweetId(articleEl), '3333333333333333333');
});

test('injectButtons leaves articles retryable until the action bar exists', () => {
  const harness = loadInjectButtonsHarness();
  let actionBar = null;
  const appended = [];
  harness.findActionBar = () => actionBar;

  const article = {
    attrs: new Set(),
    dataset: {},
    hasAttribute(name) {
      return this.attrs.has(name);
    },
    setAttribute(name) {
      this.attrs.add(name);
    },
    querySelector() {
      return null;
    }
  };

  harness.injectButtons(article);
  assert.equal(article.hasAttribute('data-xoe-processed'), false);

  actionBar = {
    appendChild(node) {
      appended.push(node);
    }
  };

  harness.injectButtons(article);
  assert.equal(article.hasAttribute('data-xoe-processed'), true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].className, 'xoe-actions');
});

test('observer re-queues the existing article when late action-bar nodes are added inside it', () => {
  const harness = loadObserverCallbackHarness();
  const article = {
    id: 'tweet-article',
    hasAttribute() {
      return false;
    }
  };
  const addedNode = {
    nodeType: 1,
    tagName: 'DIV',
    querySelectorAll(selector) {
      assert.equal(selector, 'article[data-testid="tweet"], article[role="article"]');
      return [];
    },
    closest(selector) {
      assert.equal(selector, 'article[data-testid="tweet"], article[role="article"]');
      return article;
    }
  };

  harness.runObserver([{ addedNodes: [addedNode] }]);

  assert.equal(harness.pendingArticles.has(article), true);
});

test('findVideoUrlFromNodes resolves a cached MP4 URL from poster thumbnails when no video tag is available', () => {
  const harness = loadFindVideoUrlHarness();
  const expectedUrl = 'https://video.twimg.com/ext_tw_video/9876543210/pu/vid/1280x720/clip.mp4';
  harness.videoUrlCache.set('9876543210', new Map([
    [expectedUrl, { url: expectedUrl, res: 921600 }]
  ]));

  const thumbnailImg = {
    src: 'https://pbs.twimg.com/ext_tw_video_thumb/9876543210/pu/img/thumb.jpg'
  };
  const articleEl = {
    querySelectorAll(selector) {
      assert.equal(selector, 'img');
      return [thumbnailImg];
    }
  };
  const videoPlayerEl = {
    querySelectorAll(selector) {
      assert.equal(selector, 'img');
      return [thumbnailImg];
    }
  };

  assert.equal(
    harness.findVideoUrlFromNodes(articleEl, null, null, videoPlayerEl),
    expectedUrl
  );
});

test('findVideoUrlFromNodes prefers cached MP4 variants over HLS playlist URLs', () => {
  const harness = loadFindVideoUrlHarness();
  const expectedUrl = 'https://video.twimg.com/ext_tw_video/222/pu/vid/640x360/clip.mp4';
  harness.videoUrlCache.set('222', new Map([
    [expectedUrl, { url: expectedUrl, res: 230400 }]
  ]));

  const articleEl = {
    querySelectorAll() {
      return [];
    }
  };
  const videoEl = {
    currentSrc: 'https://video.twimg.com/ext_tw_video/222/pl/playlist.m3u8',
    src: 'https://video.twimg.com/ext_tw_video/222/pl/playlist.m3u8'
  };

  assert.equal(
    harness.findVideoUrlFromNodes(articleEl, videoEl, null, null),
    expectedUrl
  );
});
