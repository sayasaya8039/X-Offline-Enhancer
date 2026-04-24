import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';

import {
  buildImageBlobUrlMap,
  buildLazyImageBlobUrlMap,
  resolveImageSrc,
  buildVideoBlobMaps,
  buildLazyVideoBlobMaps,
  resolveVideoSrc
} from '../lib/reader-media.mjs';
import {
  addImages,
  deleteAllThreads,
  getImagesForThread
} from '../lib/db-esm.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeBlob(text, type = 'image/jpeg') {
  return new Blob([text], { type });
}

function loadHandleMessageHarness() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'service_worker.js'), 'utf8');
  const helperMatch = source.match(
    /\/\/ ─── Helpers[\s\S]*?\n\/\/ 永続保存を優先/
  );
  const queueMatch = source.match(
    /\/\/ ─── Image Persistence Queue[\s\S]*?\n\/\/ ─── Side Panel Setup/
  );
  const match = source.match(
    /async function handleMessage\(message, sender\) \{[\s\S]*?\n\}\n\n\/\/ ─── Video Fetch & Store/
  );
  const alarmMatch = source.match(
    /chrome\.alarms\.onAlarm\.addListener[\s\S]*?\n\}\);\n\n\/\/ ─── Offscreen Document Management/
  );
  const imageFetchMatch = source.match(
    /\/\/ ─── Image Fetch & Store[\s\S]*?\n\/\/ ─── Broadcast Helper/
  );
  if (!match) {
    throw new Error('handleMessage not found in service_worker.js');
  }
  if (!helperMatch) {
    throw new Error('message helpers not found in service_worker.js');
  }
  if (!alarmMatch) {
    throw new Error('alarm listener not found in service_worker.js');
  }
  if (!imageFetchMatch) {
    throw new Error('image fetch helpers not found in service_worker.js');
  }

  const helperSource = helperMatch[0].replace(/\n\/\/ 永続保存を優先$/, '');
  const queueSource = queueMatch
    ? queueMatch[0].replace(/\n\/\/ ─── Side Panel Setup$/, '')
    : '';
  const handleMessageSource = match[0].replace(/\n\n\/\/ ─── Video Fetch & Store$/, '');
  const alarmSource = alarmMatch[0].replace(/\n\n\/\/ ─── Offscreen Document Management$/, '');
  const imageFetchSource = imageFetchMatch[0].replace(/\n\/\/ ─── Broadcast Helper$/, '');
  const events = [];
  const alarmCalls = [];
  const deletedThreads = [];
  const deletedImageThreads = [];
  const storedImages = [];
  const fetchAttempts = [];
  let onAlarmListener = null;
  const storageData = {};
  const context = {
    validateThreadForStorage(thread) {
      return { ok: true, integrity: { status: 'complete', totalTweets: thread?.tweets?.length || 0 } };
    },
    addThread: async () => {},
    getSavedIds: async () => [],
    deleteThread: async (threadId) => {
      deletedThreads.push(threadId);
    },
    deleteAllThreads: async () => {
      deletedThreads.push('*');
    },
    deleteImagesForThread: async (threadId) => {
      deletedImageThreads.push(threadId);
      for (let i = storedImages.length - 1; i >= 0; i--) {
        if (storedImages[i].threadId === threadId) {
          storedImages.splice(i, 1);
        }
      }
    },
    deleteVideosByThread: async () => {},
    deleteAllVideos: async () => {},
    fetchAndStoreVideos: async () => 0,
    addImages: async (threadId, items, options = {}) => {
      if (options && typeof options.precondition === 'function' && !options.precondition()) {
        return 0;
      }
      for (const item of items || []) {
        storedImages.push({ threadId, ...item });
      }
      return (items || []).length;
    },
    fetchAndStoreImages: async () => 0,
    fetch: async (url) => {
      fetchAttempts.push(url);
      return {
        ok: true,
        blob: async () => ({ size: 1234, type: 'image/jpeg', url })
      };
    },
    AbortController,
    URL,
    setTimeout,
    clearTimeout,
    broadcastToExtension(message) {
      events.push(message);
    },
    broadcastToXTabs: async () => {},
    scheduleCleanup() {
      events.push({ type: 'cleanup-scheduled' });
    },
    chrome: {
      alarms: {
        create(name, info) {
          alarmCalls.push({ name, info });
          return Promise.resolve();
        },
        onAlarm: {
          addListener(listener) {
            onAlarmListener = listener;
          }
        }
      },
      runtime: {
        onStartup: { addListener() {} },
        onInstalled: { addListener() {} }
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === 'string') {
              return { [key]: storageData[key] };
            }
            if (Array.isArray(key)) {
              return Object.fromEntries(key.map((item) => [item, storageData[item]]));
            }
            if (key && typeof key === 'object') {
              return { ...key, ...Object.fromEntries(
                Object.keys(key).filter((item) => item in storageData).map((item) => [item, storageData[item]])
              ) };
            }
            return { ...storageData };
          },
          async set(values) {
            Object.assign(storageData, values);
          },
          async remove(key) {
            delete storageData[key];
          }
        }
      },
      tabs: {
        async query() {
          return [];
        },
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

  vm.runInNewContext(
    `${helperSource}\n${queueSource}\n${alarmSource}\n${handleMessageSource}\n${imageFetchSource}; this.handleMessage = handleMessage; this.processPendingImagePersistenceJobs = typeof processPendingImagePersistenceJobs === 'function' ? processPendingImagePersistenceJobs : undefined;`,
    context
  );
  context.events = events;
  context.alarmCalls = alarmCalls;
  context.deletedThreads = deletedThreads;
  context.deletedImageThreads = deletedImageThreads;
  context.storedImages = storedImages;
  context.fetchAttempts = fetchAttempts;
  context.onAlarmListener = onAlarmListener;
  context.storageData = storageData;
  return context;
}

function loadFetchAndStoreVideosHarness() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'service_worker.js'), 'utf8');
  const normalizeMatch = source.match(/function normalizeVideoEntries\(videoUrls\) \{[\s\S]*?\n\}/);
  const fetchMatch = source.match(/async function fetchAndStoreVideos\(threadId, videoUrls[^)]*\) \{[\s\S]*?\n\}/);
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

test('deleteAllThreads removes image blobs for saved threads', async () => {
  const threadId = 'delete-all-images-regression';
  await addImages(threadId, [
    { index: 0, blob: makeBlob('first'), mimeType: 'image/jpeg' },
    { index: 1, blob: makeBlob('second'), mimeType: 'image/jpeg' }
  ]);

  assert.equal((await getImagesForThread(threadId)).length, 2);

  await deleteAllThreads();

  assert.deepEqual(await getImagesForThread(threadId), []);
});

test('lazy image blob resolver creates object URLs only when an image is resolved', () => {
  const created = [];
  const { map, activeUrls } = buildLazyImageBlobUrlMap(
    [
      { index: 10000, blob: { id: 'hero' } },
      { index: 20000, blob: { id: 'later' } }
    ],
    (blob) => {
      created.push(blob.id);
      return `blob:${blob.id}`;
    }
  );

  assert.deepEqual(created, []);
  assert.deepEqual(activeUrls, []);

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

  assert.deepEqual(created, ['hero']);
  assert.deepEqual(activeUrls, ['blob:hero']);

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
  assert.deepEqual(created, ['hero']);
  assert.deepEqual(activeUrls, ['blob:hero']);
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

test('lazy video blob resolver creates object URLs only when a video is resolved', () => {
  const tweets = [
    { id: '100', hasVideo: true, videoUrl: null },
    { id: '101', hasVideo: true, videoUrl: 'https://video.twimg.com/ext_tw_video/777/pu/vid/640x360/clip.mp4' }
  ];
  const created = [];
  const { byUrl, fallbackByTweetIndex, activeUrls } = buildLazyVideoBlobMaps(
    tweets,
    [
      { index: 0, url: 'https://video.twimg.com/ext_tw_video/555/pu/vid/640x360/clip.mp4', blob: { id: 'fallback-video' } },
      { index: 1, url: 'https://video.twimg.com/ext_tw_video/777/pu/vid/640x360/clip.mp4', blob: { id: 'url-video' } }
    ],
    (blob) => {
      created.push(blob.id);
      return `blob:${blob.id}`;
    }
  );

  assert.deepEqual(created, []);
  assert.deepEqual(activeUrls, []);

  assert.equal(
    resolveVideoSrc({
      tweet: tweets[1],
      tweetIdx: 1,
      videoBlobMap: byUrl,
      fallbackVideoBlobMap: fallbackByTweetIndex
    }),
    'blob:url-video'
  );

  assert.deepEqual(created, ['url-video']);
  assert.deepEqual(activeUrls, ['blob:url-video']);

  assert.equal(
    resolveVideoSrc({
      tweet: tweets[0],
      tweetIdx: 0,
      videoBlobMap: byUrl,
      fallbackVideoBlobMap: fallbackByTweetIndex
    }),
    'blob:fallback-video'
  );

  assert.deepEqual(created, ['url-video', 'fallback-video']);
  assert.deepEqual(activeUrls, ['blob:url-video', 'blob:fallback-video']);
});

test('buildVideoBlobMaps recovers tweet index from legacy video record ids when index is missing', () => {
  const tweets = [
    { id: '100', hasVideo: true, videoUrl: 'https://video.twimg.com/ext_tw_video/555/pu/vid/1280x720/clip.mp4' }
  ];
  const { byUrl, fallbackByTweetIndex } = buildVideoBlobMaps(
    tweets,
    [{
      id: 'thread-1:0',
      url: 'https://video.twimg.com/ext_tw_video/555/pu/vid/640x360/clip.mp4',
      blob: { id: 'video-legacy' }
    }],
    (blob) => `blob:${blob.id}`
  );

  assert.equal(
    resolveVideoSrc({
      tweet: tweets[0],
      tweetIdx: 0,
      videoBlobMap: byUrl,
      fallbackVideoBlobMap: fallbackByTweetIndex
    }),
    'blob:video-legacy'
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

test('SAVE_THREAD persists image jobs before responding without direct fetch', async () => {
  const harness = loadHandleMessageHarness();
  let fetchCalled = false;

  harness.fetchAndStoreImages = async () => {
    fetchCalled = true;
    return 2;
  };

  const response = await harness.handleMessage(
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

  assert.equal(response.success, true);
  assert.equal(response.imagesSaved, 0);
  assert.equal(response.imageFetch, 'pending');
  assert.equal(fetchCalled, false);
  assert.deepEqual(
    plain(harness.storageData.xoePendingImageJobs['1234567890'].imageUrls),
    [{ tweetIdx: 0, imgIdx: 0, url: 'https://pbs.twimg.com/media/hero.jpg' }]
  );
  assert.ok(harness.alarmCalls.some((call) => call.name === 'image-persistence-jobs'));
  assert.ok(harness.events.some((event) => event.type === 'THREAD_SAVED' && event.threadId === '1234567890'));
  assert.ok(!harness.events.some((event) => event.type === 'THREAD_IMAGES_READY'));
});

test('image persistence queue processing broadcasts success and removes completed jobs', async () => {
  const harness = loadHandleMessageHarness();
  const fetched = [];

  harness.fetchAndStoreImages = async (threadId, imageUrls) => {
    fetched.push({ threadId, imageUrls });
    return 2;
  };

  await harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567894',
        tweets: [{ id: '1234567894', text: 'hello', images: [], hasVideo: false }],
        imageUrls: [{ tweetIdx: 0, imgIdx: 0, url: 'https://pbs.twimg.com/media/hero.jpg' }]
      }
    },
    {}
  );

  await harness.processPendingImagePersistenceJobs();

  assert.deepEqual(plain(fetched), [
    {
      threadId: '1234567894',
      imageUrls: [{ tweetIdx: 0, imgIdx: 0, url: 'https://pbs.twimg.com/media/hero.jpg' }]
    }
  ]);
  assert.deepEqual(plain(harness.storageData.xoePendingImageJobs), {});
  assert.ok(harness.events.some((event) => (
    event.type === 'THREAD_IMAGES_READY'
    && event.threadId === '1234567894'
    && event.saved === 2
  )));
});

test('image persistence alarm waits for queued jobs before resolving', async () => {
  const harness = loadHandleMessageHarness();
  let releaseFetch;
  const fetchStarted = new Promise((resolve) => {
    harness.fetchAndStoreImages = async () => {
      resolve();
      await new Promise((release) => {
        releaseFetch = release;
      });
      return 1;
    };
  });

  await harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567896',
        tweets: [{ id: '1234567896', text: 'hello', images: [], hasVideo: false }],
        imageUrls: [{ tweetIdx: 0, imgIdx: 0, url: 'https://pbs.twimg.com/media/hero.jpg' }]
      }
    },
    {}
  );

  const alarmPromise = harness.onAlarmListener({ name: 'image-persistence-jobs' });
  let alarmResolved = false;
  alarmPromise.then(() => {
    alarmResolved = true;
  });

  await fetchStarted;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(alarmResolved, false);

  releaseFetch();
  await alarmPromise;

  assert.equal(alarmResolved, true);
  assert.deepEqual(plain(harness.storageData.xoePendingImageJobs), {});
  assert.ok(harness.events.some((event) => (
    event.type === 'THREAD_IMAGES_READY'
    && event.threadId === '1234567896'
    && event.saved === 1
  )));
});

test('SAVE_THREAD skips background image persistence when there are no image URLs', async () => {
  const harness = loadHandleMessageHarness();
  let fetchCalled = false;

  harness.fetchAndStoreImages = async () => {
    fetchCalled = true;
    return 1;
  };

  const response = await harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567891',
        tweets: [{ id: '1234567891', text: 'hello', images: [], hasVideo: false }],
        imageUrls: []
      }
    },
    {}
  );

  assert.equal(response.success, true);
  assert.equal(response.imagesSaved, 0);
  assert.equal(response.imageFetch, 'none');
  assert.equal(fetchCalled, false);
  assert.ok(!harness.events.some((event) => event.type === 'THREAD_IMAGES_READY'));
});

test('SAVE_THREAD removes an existing pending image job when saved again with no image URLs', async () => {
  const harness = loadHandleMessageHarness();
  let fetchCalled = false;

  harness.fetchAndStoreImages = async () => {
    fetchCalled = true;
    return 1;
  };

  await harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567897',
        tweets: [{ id: '1234567897', text: 'with image', images: [], hasVideo: false }],
        imageUrls: [{ tweetIdx: 0, imgIdx: 0, url: 'https://pbs.twimg.com/media/old.jpg' }]
      }
    },
    {}
  );

  const response = await harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567897',
        tweets: [{ id: '1234567897', text: 'without image', images: [], hasVideo: false }],
        imageUrls: []
      }
    },
    {}
  );

  assert.equal(response.success, true);
  assert.equal(response.imageFetch, 'none');
  assert.equal(fetchCalled, false);
  assert.equal(harness.storageData.xoePendingImageJobs['1234567897'], undefined);
});

test('image persistence queue reports fetch failures', async () => {
  const harness = loadHandleMessageHarness();
  const warnings = [];
  harness.console.warn = (...args) => warnings.push(args);
  harness.fetchAndStoreImages = async () => {
    throw new Error('network stalled');
  };

  const response = await harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567892',
        tweets: [{ id: '1234567892', text: 'hello', images: [], hasVideo: false }],
        imageUrls: [{ tweetIdx: 0, imgIdx: 0, url: 'https://pbs.twimg.com/media/hero.jpg' }]
      }
    },
    {}
  );

  assert.equal(response.success, true);
  await harness.processPendingImagePersistenceJobs();

  assert.ok(warnings.some((args) => String(args[0]).includes('Queued image persistence failed')));
  assert.ok(harness.events.some((event) => (
    event.type === 'THREAD_IMAGES_FAILED'
    && event.threadId === '1234567892'
    && event.error === 'network stalled'
  )));
});

test('image persistence queue reports zero saved images as observable failure', async () => {
  const harness = loadHandleMessageHarness();
  const warnings = [];
  harness.console.warn = (...args) => warnings.push(args);
  harness.fetchAndStoreImages = async () => 0;

  const response = await harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567893',
        tweets: [{ id: '1234567893', text: 'hello', images: [], hasVideo: false }],
        imageUrls: [{ tweetIdx: 0, imgIdx: 0, url: 'https://pbs.twimg.com/media/hero.jpg' }]
      }
    },
    {}
  );

  assert.equal(response.success, true);
  await harness.processPendingImagePersistenceJobs();

  assert.ok(warnings.some((args) => String(args[0]).includes('Queued image persistence failed')));
  assert.ok(harness.events.some((event) => (
    event.type === 'THREAD_IMAGES_FAILED'
    && event.threadId === '1234567893'
    && event.error === 'No images fetched successfully'
  )));
});

test('SAVE_THREAD replaces pending image jobs for the same thread', async () => {
  const harness = loadHandleMessageHarness();

  await harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567895',
        tweets: [{ id: '1234567895', text: 'first', images: [], hasVideo: false }],
        imageUrls: [{ tweetIdx: 0, imgIdx: 0, url: 'https://pbs.twimg.com/media/old.jpg' }]
      }
    },
    {}
  );
  await harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567895',
        tweets: [{ id: '1234567895', text: 'second', images: [], hasVideo: false }],
        imageUrls: [{ tweetIdx: 1, imgIdx: 0, url: 'https://pbs.twimg.com/media/new.jpg' }]
      }
    },
    {}
  );

  assert.deepEqual(
    plain(harness.storageData.xoePendingImageJobs['1234567895'].imageUrls),
    [{ tweetIdx: 1, imgIdx: 0, url: 'https://pbs.twimg.com/media/new.jpg' }]
  );
});

test('stale in-flight image jobs do not store images or broadcast completion', async () => {
  const harness = loadHandleMessageHarness();
  let releaseFetch;
  const fetchStarted = new Promise((resolve) => {
    harness.fetch = async (url) => {
      harness.fetchAttempts.push(url);
      resolve();
      await new Promise((release) => {
        releaseFetch = release;
      });
      return {
        ok: true,
        blob: async () => ({ size: 1234, type: 'image/jpeg', url })
      };
    };
  });

  await harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567898',
        tweets: [{ id: '1234567898', text: 'with image', images: [], hasVideo: false }],
        imageUrls: [{ tweetIdx: 0, imgIdx: 0, url: 'https://pbs.twimg.com/media/old.jpg' }]
      }
    },
    {}
  );

  const alarmPromise = harness.onAlarmListener({ name: 'image-persistence-jobs' });
  await fetchStarted;

  await harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567898',
        tweets: [{ id: '1234567898', text: 'without image', images: [], hasVideo: false }],
        imageUrls: []
      }
    },
    {}
  );

  releaseFetch();
  await alarmPromise;

  assert.deepEqual(harness.storedImages, []);
  assert.equal(harness.storageData.xoePendingImageJobs['1234567898'], undefined);
  assert.ok(!harness.events.some((event) => event.type === 'THREAD_IMAGES_READY'));
  assert.ok(!harness.events.some((event) => event.type === 'THREAD_IMAGES_FAILED'));
});

test('SAVE_THREAD with no images waits behind an active image commit and removes committed blobs without READY or FAILED', async () => {
  const harness = loadHandleMessageHarness();
  let releaseCommit;
  const commitStarted = new Promise((resolve) => {
    harness.addImages = async (threadId, items, options = {}) => {
      if (options && typeof options.precondition === 'function' && !options.precondition()) {
        return 0;
      }
      resolve();
      await new Promise((release) => {
        releaseCommit = release;
      });
      for (const item of items || []) {
        harness.storedImages.push({ threadId, ...item });
      }
      return (items || []).length;
    };
  });

  await harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567804',
        tweets: [{ id: '1234567804', text: 'with image', images: [], hasVideo: false }],
        imageUrls: [{ tweetIdx: 0, imgIdx: 0, url: 'https://pbs.twimg.com/media/window.jpg' }]
      }
    },
    {}
  );

  const alarmPromise = harness.onAlarmListener({ name: 'image-persistence-jobs' });
  await commitStarted;

  const saveWithoutImagesPromise = harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567804',
        tweets: [{ id: '1234567804', text: 'without image', images: [], hasVideo: false }],
        imageUrls: []
      }
    },
    {}
  );
  await Promise.resolve();

  releaseCommit();
  await saveWithoutImagesPromise;
  await alarmPromise;

  assert.deepEqual(harness.storedImages, []);
  assert.deepEqual(harness.deletedImageThreads, ['1234567804']);
  assert.equal(harness.storageData.xoePendingImageJobs['1234567804'], undefined);
  assert.ok(!harness.events.some((event) => event.type === 'THREAD_IMAGES_READY'));
  assert.ok(!harness.events.some((event) => event.type === 'THREAD_IMAGES_FAILED'));
});

test('DELETE_THREAD cancels pending image jobs before deleting the thread', async () => {
  const harness = loadHandleMessageHarness();

  await harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567899',
        tweets: [{ id: '1234567899', text: 'with image', images: [], hasVideo: false }],
        imageUrls: [{ tweetIdx: 0, imgIdx: 0, url: 'https://pbs.twimg.com/media/delete.jpg' }]
      }
    },
    {}
  );

  await harness.handleMessage({ type: 'DELETE_THREAD', threadId: '1234567899' }, {});
  await harness.processPendingImagePersistenceJobs();

  assert.deepEqual(harness.deletedThreads, ['1234567899']);
  assert.deepEqual(plain(harness.storageData.xoePendingImageJobs), {});
  assert.deepEqual(harness.fetchAttempts, []);
  assert.deepEqual(harness.storedImages, []);
  assert.ok(!harness.events.some((event) => event.type === 'THREAD_IMAGES_READY'));
});

test('DELETE_ALL_THREADS cancels all pending image jobs before deleting threads', async () => {
  const harness = loadHandleMessageHarness();

  await harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567801',
        tweets: [{ id: '1234567801', text: 'first', images: [], hasVideo: false }],
        imageUrls: [{ tweetIdx: 0, imgIdx: 0, url: 'https://pbs.twimg.com/media/first.jpg' }]
      }
    },
    {}
  );
  await harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567802',
        tweets: [{ id: '1234567802', text: 'second', images: [], hasVideo: false }],
        imageUrls: [{ tweetIdx: 0, imgIdx: 0, url: 'https://pbs.twimg.com/media/second.jpg' }]
      }
    },
    {}
  );

  await harness.handleMessage({ type: 'DELETE_ALL_THREADS' }, {});
  await harness.processPendingImagePersistenceJobs();

  assert.deepEqual(harness.deletedThreads, ['*']);
  assert.deepEqual(plain(harness.storageData.xoePendingImageJobs), {});
  assert.deepEqual(harness.fetchAttempts, []);
  assert.deepEqual(harness.storedImages, []);
  assert.ok(!harness.events.some((event) => event.type === 'THREAD_IMAGES_READY'));
});

test('content-script messages reject privileged message types', async () => {
  for (const type of ['DELETE_THREAD', 'GET_THREAD', 'EXPORT_PDF']) {
    const harness = loadHandleMessageHarness();
    await assert.rejects(
      harness.handleMessage(
        { type, threadId: '1234567899' },
        { tab: { id: 1, url: 'https://x.com/example/status/1234567899' } }
      ),
      new Error(`Content script message type not allowed: ${type}`)
    );
  }
});

test('content-script origin checks require exact X hostnames', async () => {
  for (const url of [
    'https://x.com.evil.test/example/status/1234567899',
    'https://twitter.com.evil.test/example/status/1234567899'
  ]) {
    const harness = loadHandleMessageHarness();
    await assert.rejects(
      harness.handleMessage(
        { type: 'FETCH_VIDEOS', threadId: '1234567899', videoUrls: [] },
        { tab: { id: 1, url } }
      ),
      new Error('Unauthorized message origin')
    );
  }

  const harness = loadHandleMessageHarness();
  assert.deepEqual(
    plain(await harness.handleMessage(
      { type: 'FETCH_VIDEOS', threadId: '1234567899', videoUrls: [] },
      { tab: { id: 1, url: 'https://x.com/example/status/1234567899' } }
    )),
    { success: true, saved: 0 }
  );
});

test('image persistence alarm uses at least a 0.5 minute delay', async () => {
  const harness = loadHandleMessageHarness();

  await harness.handleMessage(
    {
      type: 'SAVE_THREAD',
      data: {
        id: '1234567803',
        tweets: [{ id: '1234567803', text: 'with image', images: [], hasVideo: false }],
        imageUrls: [{ tweetIdx: 0, imgIdx: 0, url: 'https://pbs.twimg.com/media/delay.jpg' }]
      }
    },
    {}
  );

  const imageAlarm = harness.alarmCalls.find((call) => call.name === 'image-persistence-jobs');
  assert.equal(imageAlarm?.info?.delayInMinutes, 0.5);
});
