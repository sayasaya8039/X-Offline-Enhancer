import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const DB_NAME = 'XOfflineDB_v1';

function installChromeMock() {
  const calls = [];
  globalThis.chrome = {
    storage: {
      local: {
        set: (obj, cb) => {
          calls.push(obj);
          if (typeof cb === 'function') cb();
        }
      }
    }
  };
  return calls;
}

function removeChromeMock() {
  delete globalThis.chrome;
}

async function deleteDb(name = DB_NAME) {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

async function seedV3DB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('threads')) {
        const threads = db.createObjectStore('threads', { keyPath: 'id' });
        threads.createIndex('timestamp', 'timestamp', { unique: false });
        threads.createIndex('tags', 'tags', { unique: false, multiEntry: true });
      }
      if (!db.objectStoreNames.contains('image_blobs')) {
        const imgs = db.createObjectStore('image_blobs', { keyPath: 'key' });
        imgs.createIndex('threadId', 'threadId', { unique: false });
      }
      if (!db.objectStoreNames.contains('video_blobs')) {
        const vids = db.createObjectStore('video_blobs', { keyPath: 'id' });
        vids.createIndex('threadId', 'threadId', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function putRecords(db, storeName, records) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const rec of records) store.put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function freshModule() {
  return await import(`../lib/db-esm.js?t=${Date.now()}-${Math.random()}`);
}

async function getAllFromStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

test('empty v3 DB upgrades to v4 without errors or partial flag', async () => {
  await deleteDb();
  const calls = installChromeMock();
  try {
    const db0 = await seedV3DB();
    db0.close();

    const mod = await freshModule();
    const db = await mod.openDB();
    try {
      assert.equal(db.version, 4, 'should upgrade to v4');
      assert.ok(db.objectStoreNames.contains('threads'));
      assert.ok(db.objectStoreNames.contains('image_blobs'));
      assert.ok(db.objectStoreNames.contains('video_blobs'));

      const threadStore = db.transaction('threads', 'readonly').objectStore('threads');
      assert.ok(threadStore.indexNames.contains('searchTokens'), 'searchTokens index should exist');

      const imageStore = db.transaction('image_blobs', 'readonly').objectStore('image_blobs');
      assert.ok(imageStore.indexNames.contains('createdAt'), 'image_blobs.createdAt index should exist');

      const videoStore = db.transaction('video_blobs', 'readonly').objectStore('video_blobs');
      assert.ok(videoStore.indexNames.contains('createdAt'), 'video_blobs.createdAt index should exist');

      assert.equal(
        calls.length,
        0,
        'chrome.storage.local.set should NOT be called for an empty DB'
      );
    } finally {
      db.close();
    }
  } finally {
    removeChromeMock();
  }
});

test('v3 → v4 migration backfills searchTokens and summary on existing threads', async () => {
  await deleteDb();
  const calls = installChromeMock();
  try {
    const db0 = await seedV3DB();
    await putRecords(db0, 'threads', [
      {
        id: 't100',
        timestamp: Date.now(),
        tags: ['news'],
        tweets: [{ id: 'tw1', text: 'Hello from Alice', authorHandle: '@alice' }]
      },
      {
        id: 't200',
        timestamp: Date.now(),
        tags: ['tech'],
        tweets: [{ id: 'tw2', text: 'Goodbye from Bob', authorHandle: '@bob' }]
      }
    ]);
    await putRecords(db0, 'video_blobs', [
      { id: 't100:0', threadId: 't100', size: 42, timestamp: 1700000000000 }
    ]);
    await putRecords(db0, 'image_blobs', [
      { key: 't100:0', threadId: 't100', index: 0, size: 10 }
    ]);
    db0.close();

    const mod = await freshModule();
    const db = await mod.openDB();
    try {
      const threads = await getAllFromStore(db, 'threads');
      assert.equal(threads.length, 2);
      for (const rec of threads) {
        assert.ok(
          Array.isArray(rec.searchTokens) && rec.searchTokens.length > 0,
          `${rec.id} should have non-empty searchTokens`
        );
        assert.ok(rec.summary, `${rec.id} should have summary`);
        assert.equal(typeof rec.summary.primaryText, 'string');
        assert.equal(typeof rec.summary.primaryAuthor, 'object');
        assert.equal(typeof rec.summary.primaryAuthor.handle, 'string');
      }

      const videos = await getAllFromStore(db, 'video_blobs');
      assert.equal(videos.length, 1);
      assert.equal(
        videos[0].createdAt,
        1700000000000,
        'video createdAt should be backfilled from timestamp'
      );

      const images = await getAllFromStore(db, 'image_blobs');
      assert.equal(images.length, 1);
      assert.equal(typeof images[0].createdAt, 'number', 'image createdAt should be backfilled');

      assert.equal(
        calls.length,
        0,
        'chrome.storage.local.set should NOT be called when all records migrate successfully'
      );
    } finally {
      db.close();
    }
  } finally {
    removeChromeMock();
  }
});

test('getAllThreadsMeta normalizes legacy summary author info and preserves timestamp for list cards', async () => {
  await deleteDb();
  const calls = installChromeMock();
  try {
    const mod = await freshModule();
    const thread = {
      id: 'legacy-1',
      timestamp: 1710000000000,
      tags: ['saved'],
      tweets: [
        {
          id: 'tweet-1',
          text: 'hello world',
          images: [],
          hasVideo: false,
          author: {
            name: 'Alice',
            handle: 'alice',
            avatarUrl: 'https://pbs.twimg.com/profile_images/example.jpg'
          }
        }
      ],
      summary: {
        primaryAuthor: 'alice',
        primaryText: 'hello world',
        imageCount: 0,
        videoCount: 0
      },
      searchTokens: ['alice', 'hello']
    };

    await mod.addThread(thread);

    const metas = await mod.getAllThreadsMeta();
    assert.equal(metas.length, 1);
    assert.equal(metas[0].timestamp, 1710000000000);
    assert.deepEqual(metas[0].summary.primaryAuthor, {
      name: 'Alice',
      handle: 'alice',
      avatarUrl: 'https://pbs.twimg.com/profile_images/example.jpg'
    });
    assert.equal(calls.length, 0);
  } finally {
    removeChromeMock();
  }
});

test('addVideoBlob persists tweet index for newly saved videos', async () => {
  await deleteDb();
  const calls = installChromeMock();
  try {
    const mod = await freshModule();
    await mod.addVideoBlob(
      'thread-video',
      4,
      new Blob(['video-bytes'], { type: 'video/mp4' }),
      'https://video.twimg.com/ext_tw_video/555/pu/vid/640x360/clip.mp4'
    );

    const rows = await mod.getVideosByThread('thread-video');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].index, 4);
    assert.equal(rows[0].threadId, 'thread-video');
    assert.equal(calls.length, 0);
  } finally {
    removeChromeMock();
  }
});

test('v4 migration records partial flag when cursor.update throws on a single record', async () => {
  await deleteDb();
  const calls = installChromeMock();

  const IDBCursorCtor = globalThis.IDBCursor;
  const originalUpdate = IDBCursorCtor.prototype.update;
  IDBCursorCtor.prototype.update = function (value) {
    if (value?.id === 't-fail') {
      throw new Error('forced update failure');
    }
    return originalUpdate.call(this, value);
  };

  try {
    const db0 = await seedV3DB();
    await putRecords(db0, 'threads', [
      {
        id: 't-fail',
        timestamp: Date.now(),
        tags: [],
        tweets: [{ id: 'tw1', text: 'Will fail', authorHandle: '@x' }]
      },
      {
        id: 't-ok',
        timestamp: Date.now(),
        tags: [],
        tweets: [{ id: 'tw2', text: 'Will succeed', authorHandle: '@y' }]
      }
    ]);
    db0.close();

    const mod = await freshModule();
    const db = await mod.openDB();
    try {
      // tx.oncomplete fires before request.onsuccess, so chrome mock has been
      // populated by the time openDB() resolves, but give the microtask queue
      // a beat anyway.
      await new Promise((r) => setTimeout(r, 10));

      const threads = await getAllFromStore(db, 'threads');
      const ok = threads.find((r) => r.id === 't-ok');
      assert.ok(ok, 't-ok should still exist after partial failure');
      assert.ok(
        Array.isArray(ok.searchTokens) && ok.searchTokens.length > 0,
        't-ok should have been migrated despite t-fail failing'
      );

      const partialCall = calls.find((c) => c.__xoe_migration_v4_partial === true);
      assert.ok(partialCall, 'chrome.storage.local.set should record __xoe_migration_v4_partial');
      assert.ok(
        Array.isArray(partialCall.__xoe_migration_v4_errors),
        '__xoe_migration_v4_errors should be an array'
      );
      assert.ok(
        partialCall.__xoe_migration_v4_errors.length >= 1,
        'should record at least one error'
      );
      assert.equal(typeof partialCall.__xoe_migration_v4_completed_at, 'number');
    } finally {
      db.close();
    }
  } finally {
    IDBCursorCtor.prototype.update = originalUpdate;
    removeChromeMock();
  }
});
