import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import {
  addThread, addImages, addVideoBlob,
  getThread, getImagesForThread, getVideosByThread,
  deleteAllThreads, deleteAllVideos, deleteImagesForThread,
  exportAll, importAll
} from '../lib/db-esm.js';

function makeBlob(text, type = 'image/jpeg') {
  return new Blob([text], { type });
}

async function resetDb() {
  await deleteAllThreads();
  await deleteAllVideos();
}

function makeDump(overrides = {}) {
  return {
    xoeExportVersion: 1,
    threads: [],
    images: [],
    videos: [],
    ...overrides
  };
}

test('exportAll / importAll roundtrip preserves threads, images, videos', async () => {
  await resetDb();

  // 1. Seed DB with sample data
  const thread = {
    id: '1001',
    url: 'https://x.com/foo/status/1001',
    tweets: [{
      id: '1001',
      text: 'hello world',
      author: { name: 'Foo', handle: 'foo', avatarUrl: 'https://pbs.twimg.com/profile_images/1/a.jpg' },
      images: ['https://pbs.twimg.com/media/x.jpg'],
      hasVideo: true
    }],
    avatarIndex: { 'https://pbs.twimg.com/profile_images/1/a.jpg': 0 },
    timestamp: Date.now(),
    tags: []
  };
  await addThread(thread);
  await addImages('1001', [
    { index: 0, blob: makeBlob('imgA'), mimeType: 'image/jpeg' },
    { index: -10000, blob: makeBlob('avatarA'), mimeType: 'image/jpeg' }
  ]);
  await addVideoBlob('1001', 0, makeBlob('videobytes', 'video/mp4'), 'https://video.twimg.com/x.mp4');

  // 2. Export
  const dump = await exportAll();
  assert.equal(dump.xoeExportVersion, 1);
  assert.equal(dump.counts.threads, 1);
  assert.equal(dump.counts.images, 2);
  assert.equal(dump.counts.videos, 1);
  assert.equal(dump.threads[0].id, '1001');
  assert.ok(typeof dump.images[0].data === 'string' && dump.images[0].data.length > 0);
  assert.ok(typeof dump.videos[0].data === 'string' && dump.videos[0].data.length > 0);

  // 3. Serialize / deserialize (simulate file save → load)
  const json = JSON.stringify(dump);
  const parsed = JSON.parse(json);

  // 4. Wipe DB
  await deleteAllThreads();
  await deleteAllVideos();
  await deleteImagesForThread('1001');
  const afterWipe = await getThread('1001');
  assert.ok(afterWipe == null, 'thread should be gone after wipe');

  // 5. Import
  const result = await importAll(parsed);
  assert.equal(result.threads, 1);
  assert.equal(result.images, 2);
  assert.equal(result.videos, 1);

  // 6. Verify restored content
  const restored = await getThread('1001');
  assert.equal(restored.id, '1001');
  assert.equal(restored.tweets[0].text, 'hello world');
  assert.equal(restored.avatarIndex['https://pbs.twimg.com/profile_images/1/a.jpg'], 0);

  const imgs = await getImagesForThread('1001');
  assert.equal(imgs.length, 2);
  const bodyImg = imgs.find((r) => r.index === 0);
  const avatarImg = imgs.find((r) => r.index === -10000);
  assert.ok(bodyImg?.blob && avatarImg?.blob);
  assert.equal(await bodyImg.blob.text(), 'imgA');
  assert.equal(await avatarImg.blob.text(), 'avatarA');

  const vids = await getVideosByThread('1001');
  assert.equal(vids.length, 1);
  assert.equal(await vids[0].blob.text(), 'videobytes');
});

test('importAll rejects wrong schema version', async () => {
  await assert.rejects(
    importAll({ xoeExportVersion: 99, threads: [], images: [], videos: [] }),
    /unsupported export version/
  );
});

test('importAll sanitizes unsafe externalVideoUrl values before storing threads', async () => {
  await resetDb();

  await importAll(makeDump({
    threads: [{
      id: 'unsafe-external-video',
      url: 'https://x.com/foo/status/2001',
      externalVideoUrl: 'javascript:alert(1)',
      tweets: [
        { id: '2001', text: 'bad js', externalVideoUrl: 'javascript:alert(1)' },
        { id: '2002', text: 'bad data', externalVideoUrl: 'data:text/html;base64,PHNjcmlwdD4=' },
        { id: '2003', text: 'bad host', externalVideoUrl: 'https://evil.example/watch?v=abc' },
        { id: '2004', text: 'youtube ok', externalVideoUrl: 'https://www.youtube.com/watch?v=lzdmb_Z-yZc' },
        { id: '2005', text: 'x video ok', externalVideoUrl: 'https://x.com/other/status/2043037616979759465/video/1' }
      ],
      timestamp: Date.now(),
      tags: []
    }]
  }));

  const restored = await getThread('unsafe-external-video');
  assert.equal(restored.externalVideoUrl, null);
  assert.equal(restored.tweets[0].externalVideoUrl, null);
  assert.equal(restored.tweets[1].externalVideoUrl, null);
  assert.equal(restored.tweets[2].externalVideoUrl, null);
  assert.equal(restored.tweets[3].externalVideoUrl, 'https://www.youtube.com/watch?v=lzdmb_Z-yZc');
  assert.equal(restored.tweets[4].externalVideoUrl, 'https://x.com/other/status/2043037616979759465/video/1');
});

test('importAll rejects excessive record counts', async () => {
  await resetDb();

  await assert.rejects(
    importAll(makeDump({ threads: Array.from({ length: 10001 }, () => null) })),
    /Import data exceeds supported limits/
  );
});

test('importAll rejects oversized base64 media payloads', async () => {
  await resetDb();

  await assert.rejects(
    importAll(makeDump({
      images: [{
        threadId: 'oversized-image',
        index: 0,
        mimeType: 'image/png',
        data: 'A'.repeat((16 * 1024 * 1024) + 4)
      }]
    })),
    /Import data exceeds supported limits/
  );
});

test('importAll rejects unsupported media mime types', async () => {
  await resetDb();

  await assert.rejects(
    importAll(makeDump({
      images: [{
        threadId: 'bad-mime',
        index: 0,
        mimeType: 'text/html',
        data: 'aGk='
      }]
    })),
    /Invalid import data/
  );
});

test('importAll rejects invalid base64 media data', async () => {
  await resetDb();

  await assert.rejects(
    importAll(makeDump({
      videos: [{
        threadId: 'bad-base64',
        index: 0,
        url: 'https://video.twimg.com/ext_tw_video/555/pu/vid/640x360/clip.mp4',
        mimeType: 'video/mp4',
        data: 'not base64!*'
      }]
    })),
    /Invalid import data/
  );
});
