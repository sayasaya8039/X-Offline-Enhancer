export function buildImageBlobUrlMap(records, createObjectURL = (blob) => URL.createObjectURL(blob)) {
  const map = new Map();
  const activeUrls = [];

  for (const record of records || []) {
    if (!record?.blob) continue;
    const objectUrl = createObjectURL(record.blob);
    activeUrls.push(objectUrl);
    map.set(Number(record.index), objectUrl);
  }

  return { map, activeUrls };
}

export function resolveImageSrc({ tweetIdx, imgIdx, imgUrl, imageBlobMap, legacyCache }) {
  const tIdx = Number(tweetIdx);
  const iIdx = Number(imgIdx);
  const compositeIndex = (Number.isFinite(tIdx) && Number.isFinite(iIdx))
    ? (tIdx * 10000) + iIdx
    : null;

  if (compositeIndex != null && imageBlobMap?.has(compositeIndex)) {
    return imageBlobMap.get(compositeIndex);
  }
  if (legacyCache && imgUrl && legacyCache[imgUrl]) {
    return legacyCache[imgUrl];
  }
  return imgUrl || '';
}

export function buildVideoBlobMaps(tweets, videoRecords, createObjectURL = (blob) => URL.createObjectURL(blob)) {
  const byUrl = new Map();
  const fallbackByTweetIndex = new Map();
  const activeUrls = [];

  for (const record of videoRecords || []) {
    if (!record?.blob) continue;
    const objectUrl = createObjectURL(record.blob);
    activeUrls.push(objectUrl);
    if (record.url) byUrl.set(record.url, objectUrl);
    if (Number.isFinite(Number(record.index))) {
      fallbackByTweetIndex.set(Number(record.index), objectUrl);
    }
  }

  return { byUrl, fallbackByTweetIndex, activeUrls };
}

export function resolveVideoSrc({ tweet, tweetIdx, videoBlobMap, fallbackVideoBlobMap }) {
  if (tweet?.videoUrl && videoBlobMap?.has(tweet.videoUrl)) {
    return videoBlobMap.get(tweet.videoUrl);
  }
  if (fallbackVideoBlobMap?.has(tweetIdx)) {
    return fallbackVideoBlobMap.get(tweetIdx);
  }
  return null;
}
