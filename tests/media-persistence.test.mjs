import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  buildImageBlobUrlMap,
  resolveImageSrc,
  buildVideoBlobMaps,
  resolveVideoSrc
} from '../lib/reader-media.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadHandleMessageHarness() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'service_worker.js'), 'utf8');
  const match = source.match(
    /async function handleMessage\(message, sender\) \{[\s\S]*?\n\}\n\n\/\/ ─── Video Fetch & Store/
  );
  if (!match) {
    throw new Error('handleMessage not found in service_worker.js');
  }

  const handleMessageSource = match[0].replace(/\n\n\/\/ ─── Video Fetch & Store$/, '');
  const events = [];
  const context = {
    ALLOWED_ORIGINS: ['https://x.com', 'https://twitter.com', 'https://pro.x.com'],
    validateThreadForStorage(thread) {
      return { ok: true, integrity: { status: 'complete', totalTweets: thread?.tweets?.length || 0 } };
    },
    addThread: async () => {},
    fetchAndStoreImages: async () => 0,
    broadcastToExtension(message) {
      events.push(message);
    },
    scheduleCleanup() {
      events.push({ type: 'cleanup-scheduled' });
    },
    chrome: {
      tabs: {
        sendMessage() {
          return { catch() {} };
        }
      }
    },
    console: {
      log() {},
      warn() {},
      error() {}
    }
  };

  vm.runInNewContext(`${handleMessageSource}; this.handleMessage = handleMessage;`, context);
  context.events = events;
  return context;
}

function loadFetchAndStoreVideosHarness() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'service_worker.js'), 'utf8');
  const normalizeMatch = source.match(/function normalizeVideoEntries\(videoUrls\) \{[\s\S]*?\n\}/);
  const fetchMatch = source.match(/async function fetchAndStoreVideos\(threadId, videoUrls\) \{[\s\S]*?\n\}/);
  if (!normalizeMatch || !fetchMatch) {
    throw new Error('video helpers not found in service_worker.js');
  }

  const stored = [];
  const attempts = [];
  const context = {
    VIDEO_FETCH_CONCURRENCY: 2,
    inFlightVideoFetches: new Map(),
    console: {
      log() {},
      warn() {},
      error() {}
    },
    isAllowedVideoUrl(url) {
      return typeof url === 'string'
        && url.startsWith('https://video.twimg.com/')
        && url.includes('/vid/')
        && /\.mp4(?:[?#]|$)/.test(url);
    },
    async fetchVideoWithTimeout(url) {
      attempts.push(url);
      if (url.includes('1280x720')) {
        throw new Error('content-length exceeds limit');
      }
      return { size: 1024, url };
    },
    async addVideoBlob(threadId, index, blob, url) {
      stored.push({ threadId, index, blob, url });
    }
  };

  vm.runInNewContext(
    `${normalizeMatch[0]}\n${fetchMatch[0]}\nthis.fetchAndStoreVideos = fetchAndStoreVideos;`,
    context
  );
  context.stored = stored;
  context.attempts = attempts;
  return context;
}

test('resolveImageSrc prefers IndexedDB blob URLs and falls back to legacy cache', () => {
  const { map, activeUrls } = buildImageBlobUrlMap(
    [
      { index: 10000, blob: { id: 'hero' } },
      { index: 10001, blob: { id: 'detail' } }
    ],
    (blob) => `blob:${blob.id}`
  );

  assert.deepEqual(activeUrls, ['blob:hero', 'blob:detail']);
  assert.equal(
    resolveImageSrc({
      tweetIdx: 1,
      imgIdx: 0,
      imgUrl: 'https://pbs.twimg.com/media/hero.jpg',
      imageBlobMap: map,
      legacyCache: {}
    }),
    'blob:hero'
  );
  assert.equal(
    resolveImageSrc({
      tweetIdx: 2,
      imgIdx: 0,
      imgUrl: 'https://pbs.twimg.com/media/fallback.jpg',
      imageBlobMap: map,
      legacyCache: {
        'https://pbs.twimg.com/media/fallback.jpg': 'data:image/png;base64,legacy'
      }
    }),
    'data:image/png;base64,legacy'
  );
});

test('resolveVideoSrc falls back to stored videos by tweet index when tweet.videoUrl is missing', () => {
  const tweets = [
    { id: '100', hasVideo: true, videoUrl: null },
    { id: '101', hasVideo: false, videoUrl: null }
  ];
  const { byUrl, fallbackByTweetIndex, activeUrls } = buildVideoBlobMaps(
    tweets,
    [{ index: 0, url: 'https://video.twimg.com/ext_tw_video/555/pu/vid/1280x720/clip.mp4', blob: { id: 'video-1' } }],
    (blob) => `blob:${blob.id}`
  );

  assert.deepEqual(activeUrls, ['blob:video-1']);
  assert.equal(
    resolveVideoSrc({
      tweet: tweets[0],
      tweetIdx: 0,
      videoBlobMap: byUrl,
      fallbackVideoBlobMap: fallbackByTweetIndex
    }),
    'blob:video-1'
  );
});

test('fetchAndStoreVideos falls back to a smaller video variant when the largest one is rejected', async () => {
  const harness = loadFetchAndStoreVideosHarness();
  const saved = await harness.fetchAndStoreVideos('thread-1', [
    {
      tweetIdx: 4,
      urls: [
        'https://video.twimg.com/ext_tw_video/555/pu/vid/1280x720/clip.mp4',
        'https://video.twimg.com/ext_tw_video/555/pu/vid/640x360/clip.mp4'
      ]
    }
  ]);

  assert.equal(saved, 1);
  assert.deepEqual(harness.attempts, [
    'https://video.twimg.com/ext_tw_video/555/pu/vid/1280x720/clip.mp4',
    'https://video.twimg.com/ext_tw_video/555/pu/vid/640x360/clip.mp4'
  ]);
  assert.deepEqual(harness.stored, [
    {
      threadId: 'thread-1',
      index: 4,
      blob: { size: 1024, url: 'https://video.twimg.com/ext_tw_video/555/pu/vid/640x360/clip.mp4' },
      url: 'https://video.twimg.com/ext_tw_video/555/pu/vid/640x360/clip.mp4'
    }
  ]);
});

test('fetchAndStoreVideos ignores non-MP4 playlist URLs', async () => {
  const harness = loadFetchAndStoreVideosHarness();
  const saved = await harness.fetchAndStoreVideos('thread-2', [
    {
      tweetIdx: 1,
      urls: [
        'https://video.twimg.com/ext_tw_video/555/pl/playlist.m3u8',
        'https://video.twimg.com/ext_tw_video/555/pu/vid/320x180/clip.mp4'
      ]
    }
  ]);

  assert.equal(saved, 1);
  assert.deepEqual(harness.attempts, [
    'https://video.twimg.com/ext_tw_video/555/pu/vid/320x180/clip.mp4'
  ]);
});

test('SAVE_THREAD waits for image persistence before responding', async () => {
  const harness = loadHandleMessageHarness();
  let releaseFetch;
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  let fetchStarted = false;
  let fetchFinished = false;

  harness.fetchAndStoreImages = async () => {
    fetchStarted = true;
    await fetchGate;
    fetchFinished = true;
    return 2;
  };

  const responsePromise = harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567890',
        tweets: [{ id: '1234567890', text: 'hello', images: [], hasVideo: false }],
        imageUrls: [{ tweetIdx: 0, imgIdx: 0, url: 'https://pbs.twimg.com/media/hero.jpg' }]
      }
    },
    {}
  );

  let settled = false;
  responsePromise.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(settled, false);

  releaseFetch();
  const response = await responsePromise;

  assert.equal(fetchFinished, true);
  assert.equal(response.success, true);
  assert.equal(response.imagesSaved, 2);
});
