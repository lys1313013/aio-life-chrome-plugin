/* Bilibili background feature; shared services are injected by the worker entry. */
(function () {
  'use strict';
/**
 * aiolife for Chrome - Background Service Worker
 */

// Keep the Bilibili feature's existing browser-default request policy explicit.
const videoTransport = Object.freeze({credentials: 'same-origin', redirect: 'follow', timeoutMs: null});

const videoTagStatuses = new Map([
  ['待看', 'not_started'],
  ['已看', 'completed'],
  ['学习中', 'in_progress'],
  ['暂停', 'on_hold']
]);

// 简单的内存缓存，避免频繁请求 B 站 API
const videoInfoCache = new Map();

/**
 * 获取视频详情（优先从缓存获取）
 */
async function fetchVideoInfo(bvid) {
  if (videoInfoCache.has(bvid)) {
    return videoInfoCache.get(bvid);
  }

  const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  const data = await response.json();

  if (data.code !== 0) {
    throw new Error(`Bilibili API Error: ${data.message}`);
  }

  videoInfoCache.set(bvid, data.data);
  return data.data;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Capture messages are handled separately; never log credentials or captured order data.

  if (message.type === 'SYNC_TAG') {
    syncTag(message.data)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // 保持通道开启
  }

  if (message.type === 'SYNC_PROGRESS') {
    syncProgress(message.data)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_PROGRESS') {
    getProgress(message.bvid)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

/**
 * 调用同步打标接口 (更新后：先获取 B 站信息再调用 /tagVideo)
 */
async function syncTag(data) {
  const status = videoTagStatuses.get(data.tag);
  if (!status) throw new Error('不支持的视频标记');

  console.log('Background: Fetching video info from Bilibili for', data.bvid);

  try {
    const videoInfo = await fetchVideoInfo(data.bvid);
    const currentEpisode = parseInt(data.p) || 1;
    const currentTime = data.currentTime || 0;
    const watchedDuration = calculateWatchedDuration(videoInfo.pages, currentEpisode, currentTime);
    const progress = videoInfo.duration > 0 ? Math.round((watchedDuration / videoInfo.duration) * 100) : 0;

    const payload = {
      bvid: data.bvid,
      title: videoInfo.title,
      url: `https://bilibili.com/video/${data.bvid}?p=${currentEpisode}`,
      cover: videoInfo.pic,
      duration: videoInfo.duration,
      episodes: videoInfo.videos,
      currentEpisode: currentEpisode,
      status: status,
      notes: "",
      ownerName: videoInfo.owner.name,
      watchedDuration: watchedDuration
    };

    console.log('Background: Syncing to /tagVideo...', payload);

    const headers = await AioConfig.authHeaders();
    const result = await AioApi.request('/b-video/tagVideo', {
      method: 'POST', body: payload, headers, transport: videoTransport, fullResponse: true,
      errorMessage: '标记视频失败', requireToken: false
    });
    return { ...result, totalProgress: progress };
  } catch (error) {
    console.error('Background: syncTag failed', error);
    throw error;
  }
}

/**
 * 调用同步进度接口
 */
async function syncProgress(data) {
  console.log('Background: Syncing progress to server...', data);

  try {
    const headers = await AioConfig.authHeaders();
    // 未配置授权或视频不在用户的记录中时，静默跳过，避免自动创建未标记的视频。
    if (!headers.Authorization || !await getProgress(data.bvid, headers)) {
      return { code: 0, skipped: true };
    }

    const videoInfo = await fetchVideoInfo(data.bvid);
    const currentEpisode = parseInt(data.p) || 1;
    const currentTime = data.currentTime || 0;
    const watchedDuration = calculateWatchedDuration(videoInfo.pages, currentEpisode, currentTime);
    const progress = videoInfo.duration > 0 ? Math.round((watchedDuration / videoInfo.duration) * 100) : 0;

    const result = await AioApi.request('/b-video/syncProgress', {
      method: 'POST', headers, transport: videoTransport, requireToken: false, fullResponse: true, errorMessage: '同步进度失败',
      body: {bvid: data.bvid, currentEpisode, watchedDuration}
    });
    return { ...result, skipped: false, totalProgress: progress };
  } catch (error) {
    console.error('Background: syncProgress failed', error);
    throw error;
  }
}


/**
 * 计算已观看时长（包含本集当前进度）
 */
function calculateWatchedDuration(pages, currentEpisode, currentTime = 0) {
  if (!pages || !Array.isArray(pages)) return 0;
  const previousDuration = pages
    .filter(page => page.page < currentEpisode)
    .reduce((sum, page) => sum + (page.duration || 0), 0);
  return previousDuration + currentTime;
}

/**
 * 按 BV 号精确查询当前用户已标记的视频，只发起一次读取请求。
 * 直接读取服务端记录，避免仅凭本地标记缓存漏掉其他设备添加的视频。
 */
async function getProgress(bvid, headers) {
  headers = headers || await AioConfig.authHeaders();
  if (!headers.Authorization) return null;
  if (typeof bvid !== 'string' || !/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new Error('BV 号格式错误');

  const result = await AioApi.request(`/b-video/by-bvid?bvid=${encodeURIComponent(bvid)}`, {
    headers, transport: videoTransport, requireToken: false, fullResponse: true, errorMessage: '查询视频标记失败'
  });
  if (result.data === null) return null;
  if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)
      || result.data.bvid !== bvid) throw new Error(result.message || '查询视频标记失败');
  return result.data;
}

})();
