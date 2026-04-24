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

function loadContentScriptSnippets(patterns, exportCode, context = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');
  const snippets = patterns.map((pattern) => {
    const match = source.match(pattern);
    if (!match) {
      throw new Error(`Required content_script.js snippet not found: ${pattern}`);
    }
    return match[0];
  });

  vm.runInNewContext(`${snippets.join('\n')}; ${exportCode}`, context);
  return context;
}

function loadRedactUrlForLogHarness() {
  return loadContentScriptSnippets(
    [/function redactUrlForLog\([^)]*\) \{[\s\S]*?\n  \}/],
    'this.redactUrlForLog = redactUrlForLog;',
    { URL }
  );
}

function loadVideoSizeLimitHarness() {
  return loadContentScriptSnippets(
    [
      /const MAX_VIDEO_BYTES = \d+ \* 1024 \* 1024;/,
      /function enforceMaxVideoBytes\([^)]*\) \{[\s\S]*?\n  \}/
    ],
    'this.MAX_VIDEO_BYTES = MAX_VIDEO_BYTES; this.enforceMaxVideoBytes = enforceMaxVideoBytes;'
  );
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
    /function isExternalVideoUrl\([^)]*\) \{[\s\S]*?\n  \}/,
    /function findExternalVideoUrl\([^)]*\) \{[\s\S]*?\n  \}/,
    /function findStatusVideoLink\([^)]*\) \{[\s\S]*?\n  \}/,
    /function resolveExternalVideoUrl\([^)]*\) \{[\s\S]*?\n  \}/,
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
    URL,
    videoUrlCache: new Map(),
    isAllowedImageUrl(url) {
      return typeof url === 'string' && (url.startsWith('https://video.twimg.com/') || url.startsWith('https://pbs.twimg.com/'));
    }
  };

  vm.runInNewContext(
    `${snippets.join('\n')}; this.findVideoUrlFromNodes = findVideoUrlFromNodes; this.findExternalVideoUrl = findExternalVideoUrl; this.findStatusVideoLink = findStatusVideoLink; this.resolveExternalVideoUrl = resolveExternalVideoUrl; this.isDirectVideoVariant = isDirectVideoVariant; this.extractVideoMediaId = extractVideoMediaId; this.rememberVideoVariant = rememberVideoVariant;`,
    context
  );
  return context;
}

function loadBuildVideoEntriesHarness() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');
  const snippets = [
    /const MAX_VIDEOS_PER_THREAD = \d+;/,
    /function isFetchableVideoCandidate\([^)]*\) \{[\s\S]*?\n  \}/,
    /function getVideoCandidatesForMediaId\([^)]*\) \{[\s\S]*?\n  \}/,
    /function buildVideoSaveEntries\([^)]*\) \{[\s\S]*?\n  \}/
  ].map((pattern) => {
    const match = source.match(pattern);
    if (!match) {
      throw new Error(`Required buildVideoSaveEntries dependency not found: ${pattern}`);
    }
    return match[0];
  });

  const context = {
    videoUrlCache: new Map()
  };
  vm.runInNewContext(`${snippets.join('\n')}; this.buildVideoSaveEntries = buildVideoSaveEntries;`, context);
  return context;
}

function loadEnrichPendingVideoTweetsHarness(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');
  const match = source.match(/function triggerPendingVideoLoads\(pendingIds\) \{[\s\S]*?\n  async function enrichPendingVideoTweets\(tweets\) \{[\s\S]*?\n  \}/);
  if (!match) {
    throw new Error('enrichPendingVideoTweets dependencies not found in content_script.js');
  }

  const timeValues = overrides.timeValues || [0, 1, 2, 3001];
  const sleepCalls = [];
  const context = {
    document: {
      querySelectorAll: overrides.querySelectorAll || (() => [])
    },
    Date: {
      now: () => timeValues.length > 0 ? timeValues.shift() : 3001
    },
    setTimeout(resolve, delay) {
      sleepCalls.push(delay);
      resolve();
      return sleepCalls.length;
    },
    Promise,
    extractTweetId: overrides.extractTweetId || ((article) => article?.tweetId || ''),
    extractTweetData: overrides.extractTweetData || ((article) => article?.tweet || null),
    sleepCalls
  };

  vm.runInNewContext(
    `${match[0]}; this.enrichPendingVideoTweets = enrichPendingVideoTweets;`,
    context
  );
  return context;
}

function loadCollectThreadTweetsHarness() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');
  const match = source.match(/function collectThreadTweets\(rootArticle\) \{[\s\S]*?\n  \}/);
  if (!match) {
    throw new Error('collectThreadTweets not found in content_script.js');
  }

  const context = {
    document: {
      querySelector() {
        return null;
      }
    },
    extractTweetId(article) {
      return article?.tweetId || '';
    },
    extractTweetData(article) {
      return article?.tweet || null;
    },
    selectThreadTweets(candidates) {
      return candidates;
    },
    isThreadDetailPage() {
      return true;
    }
  };

  vm.runInNewContext(`${match[0]}; this.collectThreadTweets = collectThreadTweets;`, context);
  return context.collectThreadTweets;
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

test('redactUrlForLog removes query strings and fragments from video URLs', () => {
  const { redactUrlForLog } = loadRedactUrlForLogHarness();

  assert.equal(
    redactUrlForLog('https://video.twimg.com/ext_tw_video/123/pu/vid/720x720/clip.mp4?tag=12&token=secret#frag'),
    'https://video.twimg.com/ext_tw_video/123/pu/vid/720x720/clip.mp4'
  );
  assert.equal(
    redactUrlForLog('/i/api/graphql/TweetDetail?variables=secret#frag'),
    '/i/api/graphql/TweetDetail'
  );
});

test('enforceMaxVideoBytes rejects MP4 fallback bodies over 50MB before base64 conversion', () => {
  const { MAX_VIDEO_BYTES, enforceMaxVideoBytes } = loadVideoSizeLimitHarness();

  assert.doesNotThrow(() => enforceMaxVideoBytes(MAX_VIDEO_BYTES, 'MP4'));
  assert.throws(
    () => enforceMaxVideoBytes(MAX_VIDEO_BYTES + 1, 'MP4'),
    /MP4 exceeds 50MB/
  );
});

test('collectThreadTweets includes role-only thread replies when tweet testid articles are also present', () => {
  const collectThreadTweets = loadCollectThreadTweetsHarness();
  let scopeRoot;
  const clickedArticle = {
    tweetId: '100',
    tweet: { id: '100', text: 'first', images: [], hasVideo: false, author: { handle: 'alice' } },
    closest(selector) {
      assert.equal(selector, '[data-testid="primaryColumn"]');
      return scopeRoot;
    }
  };
  const replyArticle = {
    tweetId: '101',
    tweet: { id: '101', text: 'second', images: [], hasVideo: false, author: { handle: 'alice' } }
  };
  scopeRoot = {
    querySelectorAll(selector) {
      if (selector === 'article[data-testid="tweet"]') return [clickedArticle];
      if (selector === 'article[role="article"]') return [clickedArticle, replyArticle];
      if (selector === 'article[data-testid="tweet"], article[role="article"]') {
        return [clickedArticle, replyArticle];
      }
      throw new Error(`unexpected selector: ${selector}`);
    }
  };

  const tweets = collectThreadTweets(clickedArticle);

  assert.deepEqual(Array.from(tweets, (tweet) => tweet.id), ['100', '101']);
});

test('collectThreadTweets ignores nested role-only articles inside tweet cards', () => {
  const collectThreadTweets = loadCollectThreadTweetsHarness();
  let scopeRoot;
  const clickedArticle = {
    tweetId: '100',
    tweet: { id: '100', text: 'first', images: [], hasVideo: false, author: { handle: 'alice' } },
    closest(selector) {
      assert.equal(selector, '[data-testid="primaryColumn"]');
      return scopeRoot;
    }
  };
  const nestedQuoteArticle = {
    tweetId: '999',
    tweet: { id: '999', text: 'quoted', images: [], hasVideo: false, author: { handle: 'bob' } },
    parentElement: {
      closest(selector) {
        assert.equal(selector, 'article[data-testid="tweet"], article[role="article"]');
        return clickedArticle;
      }
    }
  };
  const replyArticle = {
    tweetId: '101',
    tweet: { id: '101', text: 'second', images: [], hasVideo: false, author: { handle: 'alice' } }
  };
  scopeRoot = {
    querySelectorAll(selector) {
      if (selector === 'article[data-testid="tweet"], article[role="article"]') {
        return [clickedArticle, nestedQuoteArticle, replyArticle];
      }
      return [];
    }
  };

  const tweets = collectThreadTweets(clickedArticle);

  assert.deepEqual(Array.from(tweets, (tweet) => tweet.id), ['100', '101']);
});

test('enrichPendingVideoTweets waits between scans even after updating one pending tweet', async () => {
  const articleOne = {
    tweetId: '100',
    tweet: {
      id: '100',
      hasVideo: true,
      videoUrl: 'https://video.twimg.com/ext_tw_video/100/pu/vid/640x360/clip.mp4',
      videoMediaId: '100',
      videoCandidates: ['https://video.twimg.com/ext_tw_video/100/pu/vid/640x360/clip.mp4']
    },
    querySelector() {
      return null;
    }
  };
  const articleTwo = {
    tweetId: '101',
    tweet: {
      id: '101',
      hasVideo: true,
      videoUrl: null,
      videoMediaId: null,
      videoCandidates: []
    },
    querySelector() {
      return null;
    }
  };
  const harness = loadEnrichPendingVideoTweetsHarness({
    querySelectorAll(selector) {
      assert.equal(selector, 'article[data-testid="tweet"], article[role="article"]');
      return [articleOne, articleTwo];
    }
  });
  const tweets = [
    { id: '100', hasVideo: true, videoUrl: null, videoMediaId: null, videoCandidates: [] },
    { id: '101', hasVideo: true, videoUrl: null, videoMediaId: null, videoCandidates: [] }
  ];

  await harness.enrichPendingVideoTweets(tweets);

  assert.deepEqual(tweets[0].videoCandidates, articleOne.tweet.videoCandidates);
  assert.deepEqual(tweets[1].videoCandidates, []);
  assert.ok(
    harness.sleepCalls.includes(150),
    'expected an inter-scan sleep while unresolved pending tweets remain'
  );
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

test('findExternalVideoUrl detects YouTube links inside the tweet article', () => {
  const harness = loadFindVideoUrlHarness();
  const articleEl = {
    querySelectorAll(selector) {
      assert.equal(selector, 'a[href]');
      return [
        { href: 'https://x.com/worldofai/status/123' },
        { href: 'https://youtu.be/lzdmb_Z-yZc' }
      ];
    }
  };

  assert.equal(
    harness.findExternalVideoUrl(articleEl),
    'https://youtu.be/lzdmb_Z-yZc'
  );
});

test('findStatusVideoLink returns linked X video tweet ids from status video anchors', () => {
  const harness = loadFindVideoUrlHarness();
  const articleEl = {
    querySelectorAll(selector) {
      assert.equal(selector, 'a[href]');
      return [
        { href: 'https://x.com/ClaudeCode_love/status/1912345678901234567' },
        { href: 'https://twitter.com/berryxia/status/2044929458419937462/video/1' }
      ];
    }
  };

  const result = harness.findStatusVideoLink(articleEl);
  assert.equal(result.href, 'https://twitter.com/berryxia/status/2044929458419937462/video/1');
  assert.equal(result.tweetId, '2044929458419937462');
});

test('resolveExternalVideoUrl ignores same-tweet X video links and keeps native video eligible', () => {
  const harness = loadFindVideoUrlHarness();
  const articleEl = {
    querySelectorAll() {
      return [{ href: 'https://twitter.com/berryxia/status/2044929458419937462/video/1' }];
    }
  };

  assert.equal(
    harness.resolveExternalVideoUrl(articleEl, '2044929458419937462', null, null, { nodeName: 'DIV' }),
    null
  );
});

test('resolveExternalVideoUrl treats different-tweet X video cards as external media', () => {
  const harness = loadFindVideoUrlHarness();
  const articleEl = {
    querySelectorAll() {
      return [{ href: 'https://x.com/kirillk_web3/status/2043037616979759465/video/1' }];
    }
  };

  assert.equal(
    harness.resolveExternalVideoUrl(articleEl, '1912345678901234567', null, null, { nodeName: 'DIV' }),
    'https://x.com/kirillk_web3/status/2043037616979759465/video/1'
  );
});

test('buildVideoSaveEntries skips external YouTube embeds even when preview candidates exist', () => {
  const harness = loadBuildVideoEntriesHarness();
  const entries = harness.buildVideoSaveEntries([
    {
      id: 'tweet-1',
      hasVideo: true,
      externalVideoUrl: 'https://youtu.be/lzdmb_Z-yZc',
      videoCandidates: ['https://video.twimg.com/ext_tw_video/555/pu/vid/640x360/clip.mp4'],
      videoMediaId: '555',
      videoUrl: 'https://video.twimg.com/ext_tw_video/555/pu/vid/640x360/clip.mp4'
    }
  ]);

  assert.deepEqual(entries, []);
});

test('buildVideoSaveEntries skips linked X video cards even when MP4 candidates exist', () => {
  const harness = loadBuildVideoEntriesHarness();
  const entries = harness.buildVideoSaveEntries([
    {
      id: 'tweet-2',
      hasVideo: true,
      externalVideoUrl: 'https://x.com/kirillk_web3/status/2043037616979759465/video/1',
      videoCandidates: ['https://video.twimg.com/ext_tw_video/777/pu/vid/640x360/clip.mp4'],
      videoMediaId: '777',
      videoUrl: 'https://video.twimg.com/ext_tw_video/777/pu/vid/640x360/clip.mp4'
    }
  ]);

  assert.deepEqual(entries, []);
});

test('isDirectVideoVariant accepts ext_tw_video / amplify_video / tweet_video mp4 URLs', () => {
  const harness = loadFindVideoUrlHarness();
  assert.equal(harness.isDirectVideoVariant('https://video.twimg.com/ext_tw_video/555/pu/vid/1280x720/clip.mp4'), true);
  assert.equal(harness.isDirectVideoVariant('https://video.twimg.com/amplify_video/777/vid/avc1/720x1280/abc.mp4?tag=16'), true);
  assert.equal(harness.isDirectVideoVariant('https://video.twimg.com/tweet_video/FpCl3A_VsAEWhRf.mp4'), true);
  assert.equal(harness.isDirectVideoVariant('https://video.twimg.com/ext_tw_video/555/pu/pl/playlist.m3u8'), false);
  assert.equal(harness.isDirectVideoVariant('https://other.example.com/ext_tw_video/555/pu/vid/720x480/x.mp4'), false);
});

test('extractVideoMediaId extracts tweet_video GIF hashes and numeric IDs', () => {
  const harness = loadFindVideoUrlHarness();
  assert.equal(harness.extractVideoMediaId('https://video.twimg.com/ext_tw_video/9876543210/pu/vid/1280x720/clip.mp4'), '9876543210');
  assert.equal(harness.extractVideoMediaId('https://pbs.twimg.com/amplify_video_thumb/555/img/a.jpg'), '555');
  assert.equal(harness.extractVideoMediaId('https://video.twimg.com/tweet_video/FpCl3A_VsAEWhRf.mp4'), 'FpCl3A_VsAEWhRf');
  assert.equal(harness.extractVideoMediaId('https://pbs.twimg.com/tweet_video_thumb/1234/img/thumb.jpg'), '1234');
});

test('rememberVideoVariant caches tweet_video GIF URLs', () => {
  const harness = loadFindVideoUrlHarness();
  const url = 'https://video.twimg.com/tweet_video/FpCl3A_VsAEWhRf.mp4';
  const mediaId = harness.rememberVideoVariant(url);
  assert.equal(mediaId, 'FpCl3A_VsAEWhRf');
});
