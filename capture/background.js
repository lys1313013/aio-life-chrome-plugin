/* Privileged capture transport. Only extension pages may call these messages. */
importScripts('capture/core.js');
chrome.storage.local.setAccessLevel?.({accessLevel: 'TRUSTED_CONTEXTS'});
const captureRequests = new Map();
const CAPTURE_PATHS = /^\/capture\/(?:options|(?:douban|purchase)\/(?:preview|commit))$/;
const IMAGE_HOSTS = ['doubanio.com', '360buyimg.com', 'alicdn.com', 'taobaocdn.com'];
async function captureConfig() {
  const config = await chrome.storage.local.get(['authToken', 'apiBaseUrl']);
  const base = AioCapture.apiBase(config.apiBaseUrl || AioCapture.DEFAULT_API);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${base}\n${config.authToken || ''}`));
  const scope = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
  return {...config, base, scope};
}
async function captureFetch(path, {method = 'GET', body, scope} = {}) {
  const config = await captureConfig();
  if (scope && config.scope !== scope) throw new Error('连接账号或服务已变化，请重新采集页面，避免混用草稿');
  if (!config.authToken) throw new Error('请先在插件连接设置中保存 Token');
  const headers = {Authorization: config.authToken};
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  let response;
  try { response = await fetch(config.base + path, {method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000)}); }
  catch (error) { error.uncertain = /\/(?:commit|sync)$/.test(path); throw error; }
  try { return await AioCapture.unwrap(response); }
  catch (error) { error.uncertain = /\/(?:commit|sync)$/.test(path) && (response.status >= 500 || /JSON|结果不确定|无法确认.*提交|结果待确认|正在处理|处理中/.test(error.message)); throw error; }
}
async function captureUpload(data) {
  if (!['read', 'movie', 'device', 'wardrobe_item'].includes(data.bizType)) throw new Error('无效图片业务类型');
  let blob;
  if (data.url) {
    const url = new URL(data.url);
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
  return captureFetch('/file/upload', {method: 'POST', body: form, scope: data.scope});
}
async function captureMessage(message) {
  if (message.type === 'CAPTURE_CONFIG_GET') {
    const config = await captureConfig(); return {base: config.base, configured: Boolean(config.authToken), scope: config.scope};
  }
  if (message.type === 'CAPTURE_CONFIG_SET') {
    const update = {apiBaseUrl: AioCapture.apiBase(message.base)};
    if (typeof message.token === 'string' && message.token.trim()) update.authToken = message.token.trim();
    if (message.clearToken) update.authToken = '';
    await chrome.storage.local.set(update); return captureMessage({type: 'CAPTURE_CONFIG_GET'});
  }
  if (message.type === 'CAPTURE_OPEN') {
    const config = await captureConfig();
    const data = message.capture;
    if (!data || !['douban', 'purchase'].includes(data.kind) || !data.sourceKey) throw new Error('页面采集结果无效');
    const keyData = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${config.scope}:${data.sourceKey}`));
    const id = [...new Uint8Array(keyData)].map(x => x.toString(16).padStart(2, '0')).join('');
    const key = `capture:${id}`;
    const saved = (await chrome.storage.local.get(key))[key];
    if (!saved) await chrome.storage.local.set({[key]: {...data, scope: config.scope, createdAt: Date.now()}});
    await chrome.tabs.create({url: chrome.runtime.getURL(`capture.html?id=${id}`)});
    return {id, restored: Boolean(saved)};
  }
  if (message.type === 'CAPTURE_API') {
    if (!CAPTURE_PATHS.test(message.path) || !['GET', 'POST'].includes(message.method || 'GET')) throw new Error('不支持的接口');
    const key = message.body?.idempotencyKey && `${message.scope}:${message.path}:${message.body.idempotencyKey}`;
    if (key && captureRequests.has(key)) return captureRequests.get(key);
    const request = captureFetch(message.path, {method: message.method, body: message.body, scope: message.scope});
    if (key) captureRequests.set(key, request);
    try { return await request; } finally { if (key) captureRequests.delete(key); }
  }
  if (message.type === 'CAPTURE_UPLOAD') return captureUpload(message);
  throw new Error('不支持的操作');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message.type?.startsWith('CAPTURE_')) return;
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) { respond({success: false, error: '仅扩展页面可执行此操作'}); return; }
  captureMessage(message).then(data => respond({success: true, data})).catch(error => respond({success: false, uncertain: Boolean(error.uncertain), error: error.name === 'TimeoutError' ? '请求超时，草稿已保留。写入结果可能不确定，请先到 AIO Life 核实；不会自动重试' : error.message}));
  return true;
});
