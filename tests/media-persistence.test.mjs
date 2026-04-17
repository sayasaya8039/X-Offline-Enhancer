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

test('resolveVideoSrc falls back to the single stored video when tweet.videoUrl is missing', () => {
  const tweets = [
    { id: '100', hasVideo: true, videoUrl: null },
    { id: '101', hasVideo: false, videoUrl: null }
  ];
  const { byUrl, fallbackByTweetIndex, activeUrls } = buildVideoBlobMaps(
    tweets,
    [{ url: 'https://video.twimg.com/ext_tw_video/555/pu/vid/1280x720/clip.mp4', blob: { id: 'video-1' } }],
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
