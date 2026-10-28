/* Privileged capture transport. Only extension pages may call these messages. */
importScripts('capture/core.js');
importScripts('capture/jd-images.js');
const captureRequests = new Map();
// One-time transfer to the editor, never a persistent draft or saved-record cache.
const captureTransfers = new Map();
const captureCleanup = (async () => {
  const stored = await chrome.storage.local.get(null);
  const keys = Object.keys(stored).filter(key => key.startsWith('capture:'));
  if (keys.length) await chrome.storage.local.remove(keys);
})();
const CAPTURE_PATHS = /^\/capture\/(?:options|(?:douban|purchase)\/(?:preview|commit))$/;
const IMAGE_HOSTS = ['doubanio.com', '360buyimg.com', 'alicdn.com', 'taobaocdn.com'];
const jdImageRequests = new Map();
const jdImageCache = new Map();
function jdRedirectError(tab, expected) {
  if (!tab.url) return new Error('京东商品页已跳转，暂时无法读取图片；已登录也可能需要安全验证，请打开商品页查看后重试');
  const current = new URL(tab.url);
  if (current.origin + current.pathname === expected) return null;
  if (current.hostname === 'cfe.m.jd.com') return new Error('京东要求额外安全验证，与是否已登录无关；请打开商品页完成验证后重试');
  if (current.hostname === 'passport.jd.com' || current.hostname === 'plogin.m.jd.com') return new Error('商品页跳转到了京东登录页，请打开商品页确认登录后重试');
  return new Error('京东商品页发生跳转，暂时无法读取图片，请打开商品页查看后重试');
}
async function readJdProductTab(tabId, url, waitMs = 8000) {
  await chrome.scripting.executeScript({target: {tabId}, files: ['capture/jd-images.js']});
  const results = await chrome.scripting.executeScript({target: {tabId}, func: async (expected, timeout) => {
    if (location.origin + location.pathname !== expected) return [];
    const read = () => AioJdImages.fromDocument(document);
    // The current JD page renders its gallery after the document itself has loaded.
    const hasGallery = () => document.querySelector('#spec-list img, .spec-list img, .preview-list img, .preview-wrap .image-carousel.thumbnails img, #spec-img');
    if (hasGallery() && read().length) return read();
    return new Promise(resolve => {
      let timer;
      const finish = () => { observer.disconnect(); clearTimeout(timer); resolve(read()); };
      const observer = new MutationObserver(() => { if (hasGallery() && read().length) finish(); });
      observer.observe(document.documentElement, {childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-src', 'data-url', 'data-lazy-img']});
      timer = setTimeout(finish, timeout);
    });
  }, args: [url, waitMs]});
  return AioJdImages.unique(results[0]?.result || []);
}
async function waitForJdTab(tabId, url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') {
      const error = jdRedirectError(tab, url);
      if (error) throw error;
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('京东商品页加载超时，请稍后重试');
}
async function loadJdImages(sku, url) {
  if (!await chrome.permissions.contains({origins: ['https://item.jd.com/*']})) throw new Error('请允许读取京东商品页');
  const tabs = await chrome.tabs.query({url: `https://item.jd.com/${sku}.html*`});
  for (const tab of tabs) {
    try {
      const images = await readJdProductTab(tab.id, url);
      if (images.length) return {images};
    } catch { /* A closed or navigating tab can fall back to a temporary product tab. */ }
  }
  // Use the browser's existing JD session; an extra anonymous HTML fetch cannot
  // render the dynamic gallery and needlessly repeats the product request.
  let temporaryTab;
  try {
    temporaryTab = await chrome.tabs.create({url, active: false});
    await waitForJdTab(temporaryTab.id, url);
    let images;
    try { images = await readJdProductTab(temporaryTab.id, url); }
    catch (error) { throw jdRedirectError(await chrome.tabs.get(temporaryTab.id), url) || error; }
    if (!images.length) throw jdRedirectError(await chrome.tabs.get(temporaryTab.id), url) || new Error('京东商品图片暂未加载，请打开商品页完成加载后重试');
    return {images};
  } catch (error) {
    if (/^(京东|商品页跳转)/.test(error.message)) throw error;
    throw new Error('商品页读取失败，请打开商品页查看后重试');
  } finally {
    // Only close the tab this request created; never close an existing user tab.
    if (temporaryTab?.id != null) await chrome.tabs.remove(temporaryTab.id).catch(() => {});
  }
}
async function captureJdImages(sku) {
  const url = AioJdImages.productUrl(sku);
  if (!await chrome.permissions.contains({origins: ['https://item.jd.com/*']})) throw new Error('请允许读取京东商品页');
  const cached = jdImageCache.get(sku);
  if (cached && Date.now() - cached.time < 10 * 60 * 1000) return cached.data;
  jdImageCache.delete(sku);
  if (jdImageRequests.has(sku)) return jdImageRequests.get(sku);
  const request = loadJdImages(sku, url);
  jdImageRequests.set(sku, request);
  try {
    const data = await request;
    if (jdImageCache.size >= 100) jdImageCache.delete(jdImageCache.keys().next().value);
    jdImageCache.set(sku, {time: Date.now(), data});
    return data;
  } finally { jdImageRequests.delete(sku); }
}
async function captureUpload(data) {
  if (!['read', 'movie', 'device', 'wardrobe_item'].includes(data.bizType)) throw new Error('无效图片业务类型');
  let blob;
  if (data.url) {
    const url = new URL(AioJdImages.normalize(data.url) || data.url);
    if (url.protocol !== 'https:' || !IMAGE_HOSTS.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error('图片域名不支持自动读取，请选择本地图片或无图保存');
    const response = await fetch(url.href, {credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000)});
    if (!response.ok) throw new Error('图片下载失败，可改用本地图片或无图保存');
    if (Number(response.headers.get('content-length')) > 10 * 1024 * 1024) throw new Error('图片超过 10 MB');
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 10 * 1024 * 1024) { await reader.cancel(); throw new Error('图片超过 10 MB'); }
      chunks.push(value);
    }
    blob = new Blob(chunks, {type: (response.headers.get('content-type') || '').split(';')[0]});
  } else if (/^data:image\/(?:png|jpeg|webp|gif);base64,/.test(data.dataUrl || '') && data.dataUrl.length < 14 * 1024 * 1024) {
    blob = await (await fetch(data.dataUrl)).blob();
  } else throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片');
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type) || blob.size > 10 * 1024 * 1024) throw new Error('仅支持 10 MB 以内的 PNG、JPEG、WebP、GIF 图片');
  const form = new FormData(); form.append('file', blob, `capture.${{'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'}[blob.type]}`); form.append('bizType', data.bizType);
  return AioApi.request('/file/upload', {method: 'POST', body: form, scope: data.scope});
}
const ASSET_EDIT_FIELDS = {
  device: ['name', 'type', 'status', 'remark', 'fileId'],
  wardrobe: ['name', 'categoryId', 'brand', 'color', 'size', 'remark', 'fileId'],
};
async function captureAsset(message) {
  const {kind, id, scope} = message;
  if (!ASSET_EDIT_FIELDS[kind] || typeof id !== 'string' || !/^\d{1,30}$/.test(id) || !scope) throw new Error('无效物品参数');
  // Ownership is checked by the server under the current account.
  const path = kind === 'device' ? `/device/${id}` : `/wardrobe/items/${id}`;
  const current = await AioApi.request(path, {scope});
  if (!current || String(current.id) !== id) throw new Error('物品已删除或无权访问，请到设备／衣柜核实');
  if (message.type === 'CAPTURE_ASSET_GET') return current;
  const changes = message.changes;
  if (!changes || !Object.keys(changes).length || Object.entries(changes).some(([key, value]) => !ASSET_EDIT_FIELDS[kind].includes(key) || typeof value !== 'string')) throw new Error('无效修改字段');
  if ('name' in changes && !changes.name.trim()) throw new Error('请填写物品名称');
  if ('categoryId' in changes && !/^\d{1,30}$/.test(changes.categoryId)) throw new Error('请选择衣物分类');
  const text = value => value == null ? '' : String(value);
  for (const key of Object.keys(changes)) {
    if (text(current[key]) !== text(message.base?.[key]) && text(current[key]) !== changes[key]) throw new Error('物品已在其他页面修改，请重新读取后再编辑');
  }
  // A retry after a lost response can already be applied; do not write it again.
  if (Object.entries(changes).every(([key, value]) => text(current[key]) === value)) return current;
  let body = changes;
  if (kind === 'wardrobe') {
    // Wardrobe saves a full form; retain fields outside this editor, especially season.
    const keys = [...ASSET_EDIT_FIELDS.wardrobe, 'season', 'purchaseDate', 'price'];
    body = Object.fromEntries(keys.filter(key => current[key] != null).map(key => [key, current[key]]));
    if (typeof body.season === 'string') body.season = body.season.split(',').filter(Boolean);
    Object.assign(body, changes);
  }
  const updated = await AioApi.request(path, {method: 'PUT', body, scope});
  if (kind === 'device' && updated !== true) throw new Error('设备未更新，请核实是否已删除或无权访问');
  const saved = await AioApi.request(path, {scope});
  if (!saved || Object.entries(changes).some(([key, value]) => text(saved[key]) !== value)) throw new Error('修改结果未确认，请核实后重试');
  return saved;
}
async function captureMessage(message) {
  await captureCleanup;
  if (message.type === 'CAPTURE_CONFIG_GET') {
    const config = await AioConfig.read(); return {base: config.base, configured: Boolean(config.authToken), scope: config.scope, handoffProtocol: AioCapture.HANDOFF_PROTOCOL};
  }
  if (message.type === 'CAPTURE_CONFIG_SET') {
    await AioConfig.write(message); return captureMessage({type: 'CAPTURE_CONFIG_GET'});
  }
  if (message.type === 'CAPTURE_OPEN') {
    const config = await AioConfig.read();
    const data = message.capture;
    if (!data || !['douban', 'purchase'].includes(data.kind) || !data.sourceKey) throw new Error('页面采集结果无效');
    const now = Date.now();
    for (const [key, transfer] of captureTransfers) if (transfer.expiresAt <= now) captureTransfers.delete(key);
    if (captureTransfers.size >= 20) throw new Error('待打开页面过多，请稍后重试');
    const id = crypto.randomUUID();
    captureTransfers.set(id, {data: {kind: data.kind, draft: data.draft, warnings: data.warnings || [], scope: config.scope}, expiresAt: now + 60000});
    try { await chrome.tabs.create({url: chrome.runtime.getURL(`capture.html?transfer=${id}`)}); }
    catch (error) { captureTransfers.delete(id); throw error; }
    return {id};
  }
  if (message.type === 'CAPTURE_TAKE') {
    const transfer = captureTransfers.get(message.id);
    captureTransfers.delete(message.id);
    if (!transfer || transfer.expiresAt <= Date.now()) throw new Error('采集页面已失效，请回到来源页面重新采集；如刚提交过，请先到 AIO Life 核实结果');
    const config = await AioConfig.read();
    if (transfer.data.scope !== config.scope) throw new Error('连接账号或服务已变化，请重新采集页面');
    return transfer.data;
  }
  if (message.type === 'CAPTURE_API') {
    if (!CAPTURE_PATHS.test(message.path) || !['GET', 'POST'].includes(message.method || 'GET')) throw new Error('不支持的接口');
    const key = message.body?.idempotencyKey && `${message.scope}:${message.path}:${message.body.idempotencyKey}`;
    if (key && captureRequests.has(key)) return captureRequests.get(key);
    const request = AioApi.request(message.path, {method: message.method, body: message.body, scope: message.scope, uncertainWrite: message.path.endsWith('/commit')});
    if (key) captureRequests.set(key, request);
    try { return await request; } finally { if (key) captureRequests.delete(key); }
  }
  if (message.type === 'CAPTURE_UPLOAD') return captureUpload(message);
  if (['CAPTURE_ASSET_GET', 'CAPTURE_ASSET_UPDATE'].includes(message.type)) return captureAsset(message);
  if (message.type === 'CAPTURE_JD_IMAGES') return captureJdImages(message.sku);
  throw new Error('不支持的操作');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message.type?.startsWith('CAPTURE_')) return;
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) { respond({success: false, error: '仅扩展页面可执行此操作'}); return; }
  captureMessage(message).then(data => respond({success: true, data})).catch(error => respond({success: false, uncertain: Boolean(error.uncertain), error: error.name === 'TimeoutError' ? '请求超时。写入结果可能不确定，请先到 AIO Life 核实；不会自动重试' : error.message}));
  return true;
});
