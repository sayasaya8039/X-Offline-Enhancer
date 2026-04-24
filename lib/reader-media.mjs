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

function createLazyObjectUrlEntry(blob, activeUrls, createObjectURL) {
  let objectUrl = null;
  return () => {
    if (!objectUrl) {
      objectUrl = createObjectURL(blob);
      activeUrls.push(objectUrl);
    }
    return objectUrl;
  };
}

function resolveMapValue(value) {
  if (typeof value === 'function') return value();
  return value;
}

export function buildLazyImageBlobUrlMap(records, createObjectURL = (blob) => URL.createObjectURL(blob), activeUrls = []) {
  const map = new Map();

  for (const record of records || []) {
    if (!record?.blob) continue;
    map.set(Number(record.index), createLazyObjectUrlEntry(record.blob, activeUrls, createObjectURL));
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
    return resolveMapValue(imageBlobMap.get(compositeIndex));
  }
  if (legacyCache && imgUrl && legacyCache[imgUrl]) {
    return legacyCache[imgUrl];
  }
  return imgUrl || '';
}

// アバター画像の解決: thread.avatarIndex (handle -> imgIdx) を使って
// image_blobs から保存済み blob URL を取得する。
// v1.4.2 以降の保存は avatarIndex を含むため、X が後から画像を削除しても
// ローカル blob から表示できる。
export function resolveAvatarSrc({ avatarUrl, avatarIndex, imageBlobMap, legacyCache }) {
  if (!avatarUrl) return '';
  if (avatarIndex && imageBlobMap) {
    const idx = avatarIndex[avatarUrl];
    if (Number.isFinite(Number(idx))) {
      const composite = (-1) * 10000 + Number(idx);
      if (imageBlobMap.has(composite)) return resolveMapValue(imageBlobMap.get(composite));
    }
  }
  if (legacyCache && legacyCache[avatarUrl]) return legacyCache[avatarUrl];
  return avatarUrl;
}

function getVideoRecordIndex(record) {
  const directIndex = Number(record?.index);
  if (Number.isFinite(directIndex)) return directIndex;

  const legacyMatch = String(record?.id || '').match(/:(\d+)$/);
  if (!legacyMatch) return null;

  const parsedIndex = Number(legacyMatch[1]);
  return Number.isFinite(parsedIndex) ? parsedIndex : null;
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
    const index = getVideoRecordIndex(record);
    if (index != null) {
      fallbackByTweetIndex.set(index, objectUrl);
    }
  }

  return { byUrl, fallbackByTweetIndex, activeUrls };
}

export function buildLazyVideoBlobMaps(tweets, videoRecords, createObjectURL = (blob) => URL.createObjectURL(blob), activeUrls = []) {
  const byUrl = new Map();
  const fallbackByTweetIndex = new Map();

  for (const record of videoRecords || []) {
    if (!record?.blob) continue;
    const lazyEntry = createLazyObjectUrlEntry(record.blob, activeUrls, createObjectURL);
    if (record.url) byUrl.set(record.url, lazyEntry);
    const index = getVideoRecordIndex(record);
    if (index != null) {
      fallbackByTweetIndex.set(index, lazyEntry);
    }
  }

  return { byUrl, fallbackByTweetIndex, activeUrls };
}

export function resolveVideoSrc({ tweet, tweetIdx, videoBlobMap, fallbackVideoBlobMap }) {
  if (tweet?.videoUrl && videoBlobMap?.has(tweet.videoUrl)) {
    return resolveMapValue(videoBlobMap.get(tweet.videoUrl));
  }
  if (fallbackVideoBlobMap?.has(tweetIdx)) {
    return resolveMapValue(fallbackVideoBlobMap.get(tweetIdx));
  }
  return null;
}
