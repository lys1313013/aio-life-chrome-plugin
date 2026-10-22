importScripts('capture/background.js');
importScripts('douban-auto/background.js');
/**
 * aiolife for Chrome - Background Service Worker
 */

async function bVideoBase() { return (await captureConfig()).base + '/b-video'; }

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
 * 获取带 Auth 的 Headers
 */
async function getHeaders() {
  const result = await chrome.storage.local.get(['authToken']);
  const headers = { 'Content-Type': 'application/json' };
  if (result.authToken) {
    headers['Authorization'] = result.authToken; // 或者根据需要加 'Bearer ' 前缀
  }
  return headers;
}

/**
 * 调用同步打标接口 (更新后：先获取 B 站信息再调用 /tagVideo)
 */
async function syncTag(data) {
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
      progress: progress,
      status: 2,
      notes: "",
      ownerName: videoInfo.owner.name,
      watchedDuration: watchedDuration
    };

    console.log('Background: Syncing to /tagVideo...', payload);

    const headers = await getHeaders();
    const response = await fetch(`${await bVideoBase()}/tagVideo`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });
    
    const result = await response.json();
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
    const headers = await getHeaders();
    // 未配置授权或视频不在用户的记录中时，静默跳过，避免自动创建未标记的视频。
    if (!headers.Authorization || !await getProgress(data.bvid, headers)) {
      return { code: 0, skipped: true };
    }

    const videoInfo = await fetchVideoInfo(data.bvid);
    const currentEpisode = parseInt(data.p) || 1;
    const currentTime = data.currentTime || 0;
    const watchedDuration = calculateWatchedDuration(videoInfo.pages, currentEpisode, currentTime);
    const progress = videoInfo.duration > 0 ? Math.round((watchedDuration / videoInfo.duration) * 100) : 0;
    
    const response = await fetch(`${await bVideoBase()}/syncProgress`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
         bvid: data.bvid,
         currentEpisode: currentEpisode,
         watchedDuration: watchedDuration
       })
    });
    const result = await response.json();
    if (!response.ok || result.code !== 0 || result.data === false) {
      throw new Error(result.message || '同步进度失败');
    }
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
 * 查询当前用户已标记的视频。现有查询接口不支持按 BVID 筛选，需逐页匹配。
 * 直接读取服务端记录，避免仅凭本地标记缓存漏掉其他设备添加的视频。
 */
async function getProgress(bvid, headers) {
  headers = headers || await getHeaders();
  if (!headers.Authorization) return null;

  const pageSize = 100;
  let received = 0;
  for (let page = 1; ; page++) {
    const response = await fetch(`${await bVideoBase()}/query?page=${page}&pageSize=${pageSize}`, { headers });
    const result = await response.json();
    if (!response.ok || result.code !== 0 || !Array.isArray(result.data?.items)) {
      throw new Error(result.message || '查询视频标记失败');
    }

    const { items, total } = result.data;
    const video = items.find(item => item.bvid === bvid);
    if (video) return video;

    received += items.length;
    if (items.length === 0 || (total != null ? received >= Number(total) : items.length < pageSize)) {
      return null;
    }
  }
}
