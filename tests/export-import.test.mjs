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

test('exportAll / importAll roundtrip preserves threads, images, videos', async () => {
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
