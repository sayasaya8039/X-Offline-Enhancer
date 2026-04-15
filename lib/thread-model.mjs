function normalizeLines(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeTweetText(value) {
  return normalizeLines(value);
}

export function tweetHasMedia(tweet) {
  return (Array.isArray(tweet?.images) && tweet.images.length > 0) || Boolean(tweet?.hasVideo);
}

export function tweetHasMeaningfulText(tweet) {
  return normalizeTweetText(tweet?.text).length > 0;
}

export function tweetHasContent(tweet) {
  return tweetHasMeaningfulText(tweet) || tweetHasMedia(tweet);
}

function normalizeHandle(tweet) {
  return String(tweet?.author?.handle || '').trim().toLowerCase();
}

function dedupeTweets(candidates) {
  const seen = new Set();
  const tweets = [];

  for (const candidate of candidates || []) {
    const id = String(candidate?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    tweets.push({
      ...candidate,
      id,
      text: normalizeTweetText(candidate?.text),
      author: {
        ...(candidate?.author || {}),
        handle: String(candidate?.author?.handle || '').trim()
      }
    });
  }

  return tweets;
}

export function selectThreadTweets(candidates, clickedTweetId, options = {}) {
  const tweets = dedupeTweets(candidates);
  const clickedId = String(clickedTweetId || '').trim();
  const clickedIndex = tweets.findIndex((tweet) => tweet.id === clickedId);

  if (clickedIndex < 0) return [];

  const clickedTweet = tweets[clickedIndex];
  if (options.isThreadView === false) return [clickedTweet];

  const clickedHandle = normalizeHandle(clickedTweet);
  if (!clickedHandle) return [clickedTweet];

  let start = clickedIndex;
  let end = clickedIndex;

  while (start > 0) {
    const prevTweet = tweets[start - 1];
    if (normalizeHandle(prevTweet) !== clickedHandle || !tweetHasContent(prevTweet)) break;
    start--;
  }

  while (end < tweets.length - 1) {
    const nextTweet = tweets[end + 1];
    if (normalizeHandle(nextTweet) !== clickedHandle || !tweetHasContent(nextTweet)) break;
    end++;
  }

  return tweets.slice(start, end + 1);
}

export function pickPrimaryTweet(thread) {
  const tweets = Array.isArray(thread?.tweets) ? thread.tweets : [];
  const clickedId = String(thread?.id || '').trim();
  return tweets.find((tweet) => String(tweet?.id || '').trim() === clickedId) || tweets[0] || null;
}

export function buildThreadIntegrity(thread) {
  const tweets = Array.isArray(thread?.tweets) ? dedupeTweets(thread.tweets) : [];
  const clickedId = String(thread?.id || '').trim();
  const clickedTweet = tweets.find((tweet) => tweet.id === clickedId) || null;

  const extractionIssueTweetIds = tweets
    .filter((tweet) => tweet?.textSource === 'missing')
    .map((tweet) => tweet.id);

  const missingTextTweetIds = tweets
    .filter((tweet) => !tweetHasMeaningfulText(tweet) && tweetHasMedia(tweet))
    .map((tweet) => tweet.id);

  const warnings = [];
  let status = 'complete';

  if (!clickedTweet) {
    status = 'invalid';
    warnings.push('Clicked tweet is missing from the collected thread');
  }

  if (tweets.length === 0) {
    status = 'invalid';
    warnings.push('No tweets were collected for this save');
  }

  if (extractionIssueTweetIds.length > 0) {
    if (status !== 'invalid') status = 'partial';
    warnings.push('Some tweets were missing text containers during extraction');
  }

  if (missingTextTweetIds.length > 0) {
    if (status !== 'invalid') status = 'partial';
    warnings.push('Some saved tweets contain media without extracted text');
  }

  return {
    status,
    clickedTweetPresent: Boolean(clickedTweet),
    totalTweets: tweets.length,
    missingTextTweetIds,
    extractionIssueTweetIds,
    warnings
  };
}

export function validateThreadForStorage(thread) {
  const integrity = buildThreadIntegrity(thread);

  if (!integrity.clickedTweetPresent) {
    return {
      ok: false,
      error: 'Clicked tweet is missing from the collected thread',
      integrity
    };
  }

  if (integrity.totalTweets === 0) {
    return {
      ok: false,
      error: 'No tweets were collected for this save',
      integrity
    };
  }

  const clickedTweet = pickPrimaryTweet(thread);
  if (clickedTweet && !tweetHasContent(clickedTweet) && clickedTweet.textSource === 'missing') {
    return {
      ok: false,
      error: 'Clicked tweet text could not be extracted',
      integrity
    };
  }

  return { ok: true, integrity };
}

export function getIntegrityMessage(integrity) {
  if (!integrity || integrity.status === 'complete') return '';
  if (integrity.status === 'invalid') return 'この保存データは不正です。削除して再保存してください。';
  return '一部のツイートは本文なし、または画像・動画のみで保存されています。';
}
