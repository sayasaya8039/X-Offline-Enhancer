import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildThreadIntegrity,
  getIntegrityMessage,
  pickPrimaryTweet,
  selectThreadTweets,
  validateThreadForStorage
} from '../lib/thread-model.mjs';

test('selectThreadTweets narrows candidates to the contiguous author segment around the clicked tweet', () => {
  const candidates = [
    { id: '101', text: 'first', images: [], hasVideo: false, author: { handle: 'alice' } },
    { id: '102', text: 'second', images: [], hasVideo: false, author: { handle: 'alice' } },
    { id: '103', text: 'someone else', images: [], hasVideo: false, author: { handle: 'bob' } },
    { id: '104', text: 'later unrelated', images: [], hasVideo: false, author: { handle: 'alice' } }
  ];

  const selected = selectThreadTweets(candidates, '102');

  assert.deepEqual(selected.map((tweet) => tweet.id), ['101', '102']);
});

test('selectThreadTweets keeps only the clicked tweet outside a thread detail page', () => {
  const candidates = [
    { id: '101', text: 'first', images: [], hasVideo: false, author: { handle: 'alice' } },
    { id: '102', text: 'second', images: [], hasVideo: false, author: { handle: 'alice' } }
  ];

  const selected = selectThreadTweets(candidates, '102', { isThreadView: false });

  assert.deepEqual(selected.map((tweet) => tweet.id), ['102']);
});

test('pickPrimaryTweet prefers the clicked tweet id when it exists in the saved thread', () => {
  const thread = {
    id: '202',
    tweets: [
      { id: '201', text: 'neighbor', images: [], hasVideo: false, author: { handle: 'alice' } },
      { id: '202', text: 'clicked', images: [], hasVideo: false, author: { handle: 'alice' } }
    ]
  };

  const primary = pickPrimaryTweet(thread);

  assert.equal(primary?.id, '202');
});

test('buildThreadIntegrity reports partial saves when some tweets are missing text', () => {
  const thread = {
    id: '301',
    tweets: [
      { id: '301', text: 'clicked', images: [], hasVideo: false, author: { handle: 'alice' } },
      { id: '302', text: '', images: ['https://pbs.twimg.com/media/example.jpg'], hasVideo: false, author: { handle: 'alice' } }
    ]
  };

  const integrity = buildThreadIntegrity(thread);

  assert.equal(integrity.status, 'partial');
  assert.deepEqual(integrity.missingTextTweetIds, ['302']);
});

test('getIntegrityMessage keeps partial warnings neutral when text is missing', () => {
  const integrity = buildThreadIntegrity({
    id: '501',
    tweets: [
      { id: '501', text: '', textSource: 'missing', images: ['https://pbs.twimg.com/media/example.jpg'], hasVideo: false, author: { handle: 'alice' } }
    ]
  });

  assert.equal(
    getIntegrityMessage(integrity),
    '一部のツイートは本文なし、または画像・動画のみで保存されています。'
  );
});

test('validateThreadForStorage rejects payloads that do not contain the clicked tweet', () => {
  const thread = {
    id: '401',
    tweets: [
      { id: '999', text: 'wrong tweet', images: [], hasVideo: false, author: { handle: 'alice' } }
    ]
  };

  const result = validateThreadForStorage(thread);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'Clicked tweet is missing from the collected thread');
});
