/* Dedicated native-Douban channel. Content scripts never receive a general API proxy or Token. */
importScripts('douban-auto/detector.js');
const DOUBAN_SCRIPT_ID = 'aio-douban-native-mark';
const DOUBAN_ORIGIN = 'https://movie.douban.com/*';
const DOUBAN_FILES = ['capture/core.js', 'capture/adapters/common.js', 'capture/adapters/douban.js', 'douban-auto/detector.js', 'douban-auto/content.js'];
const doubanSubjectLocks = new Map();
function serialDouban(key, task) {
  const next = (doubanSubjectLocks.get(key) || Promise.resolve()).catch(() => {}).then(task);
  doubanSubjectLocks.set(key, next);
  next.finally(() => { if (doubanSubjectLocks.get(key) === next) doubanSubjectLocks.delete(key); }).catch(() => {});
  return next;
}
async function doubanSettings() {
  const [config, stored, granted] = await Promise.all([AioConfig.read(), chrome.storage.local.get(['doubanAutoEnabled']), chrome.permissions.contains({origins: [DOUBAN_ORIGIN]})]);
  return {...config, enabled: Boolean(stored.doubanAutoEnabled && granted), granted};
}
function validateDoubanSender(message, sender) {
  const actual = AioDoubanNative.movieIdentity(sender.url), requested = AioDoubanNative.movieIdentity(message.url);
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !actual || !requested || actual.id !== requested.id) throw new Error('仅当前豆瓣影视详情页的顶层内容脚本可同步该条目');
  return actual;
}
const doubanKey = (scope, id) => `douban-native:${scope}:${id}`;
async function readDoubanQueue(key) { return (await chrome.storage.local.get(key))[key] || {queue: [], last: null}; }
function summaryDouban(data, enabled) {
  const head = data.queue[0];
  return {enabled, state: head ? head.phase : 'idle', pending: data.queue.length, status: head?.status || data.last?.status, message: head?.error || null, result: data.last?.result || null};
}
async function notifyDouban(item, result) {
  if (!Number.isInteger(item.tabId)) return;
  try { await chrome.tabs.sendMessage(item.tabId, {type: 'DOUBAN_AUTO_RESULT', url: item.url, ...result}, {frameId: 0}); } catch { /* Page closed or navigated; queue remains in storage. */ }
}
function safeDoubanMetadata(value) {
  if (!value || typeof value !== 'object') return {};
  const result = {};
  for (const [key, max] of [['title', 255], ['director', 100], ['coverImgUrl', 2048]]) if (typeof value[key] === 'string') result[key] = value[key].slice(0, max);
  if (Number.isInteger(value.type) && value.type >= 1 && value.type <= 5) result.type = value.type;
  if (Number.isInteger(value.totalProgress) && value.totalProgress >= 0 && value.totalProgress <= 1000000) result.totalProgress = value.totalProgress;
  return result;
}
async function drainDouban(key, settings, manual) {
  let data = await readDoubanQueue(key);
  while (data.queue.length) {
    const current = await doubanSettings();
    if (!current.enabled || current.scope !== settings.scope) return {...summaryDouban(data, current.enabled), state: 'paused', message: '自动同步已关闭或账号已切换，待处理请求未发送'};
    const item = data.queue[0];
    if (item.phase !== 'ready' && !manual) return {...summaryDouban(data, true), state: 'blocked', message: item.error || '前一次同步结果待确认，请核实后使用原请求重试'};
    if (Date.now() - item.createdAt >= 86400000) return {...summaryDouban(data, true), state: 'expired', message: '该请求超过 24 小时，请到 AIO Life 核实结果；不会自动重新创建或移除记录'};
    item.phase = 'sending'; delete item.error;
    await chrome.storage.local.set({[key]: data});
    await notifyDouban(item, {state: 'sending', status: item.status});
    try {
      const result = await AioApi.request('/capture/douban/sync', {method: 'POST', scope: settings.scope, uncertainWrite: true, body: {url: item.url, status: item.status, idempotencyKey: item.key, metadata: item.metadata}});
      const removed = item.status === 'removed';
      const validId = typeof result?.id === 'string' && result.id.length > 0;
      const validResult = result?.mediaType === 'movie' && result.status === item.status && (removed ? result.operation === 'deleted' ? validId : result.operation === 'absent' && result.id === null : validId && ['created', 'updated', 'unchanged'].includes(result.operation));
      if (!validResult) { const error = new Error('服务未返回可确认的同步结果，请先核实 AIO Life 记录'); error.uncertain = true; throw error; }
      data.queue.shift(); data.last = {eventId: item.eventId, status: item.status, result, at: Date.now()};
      await chrome.storage.local.set({[key]: data});
      await notifyDouban(item, {state: 'success', status: item.status, result});
      // Each queued action was separately confirmed on Douban. Never skip an earlier action.
      manual = false;
    } catch (error) {
      const uncertain = error.uncertain || /超时|timeout|Network|fetch|无法确认|待确认|不确定|正在处理|处理中/i.test(error.message);
      item.phase = uncertain ? 'uncertain' : 'failed';
      item.error = uncertain ? '同步结果待确认，请先在 AIO Life 核实；不会自动重试。' : error.message;
      await chrome.storage.local.set({[key]: data});
      const summary = {...summaryDouban(data, true), message: item.error};
      await notifyDouban(item, summary); return summary;
    }
  }
  return {...summaryDouban(data, true), state: 'success'};
}
async function handleDoubanPage(message, sender) {
  const identity = validateDoubanSender(message, sender);
  const settings = await doubanSettings();
  const key = doubanKey(settings.scope, identity.id);
  const intentKey = `douban-remove:${settings.scope}:${sender.tab.id}:${identity.id}`;
  if (message.type === 'DOUBAN_AUTO_PAGE_GET') {
    const intent = (await chrome.storage.local.get(intentKey))[intentKey];
    const data = await readDoubanQueue(key);
    if (data.queue[0]?.phase === 'sending' && !doubanSubjectLocks.has(key)) { data.queue[0].phase = 'uncertain'; data.queue[0].error = '上次请求结束前页面或扩展已关闭，结果待确认，请先核实'; await chrome.storage.local.set({[key]: data}); }
    return {...summaryDouban(data, settings.enabled), scope: settings.scope, removeIntent: settings.enabled && intent && intent.expiresAt > Date.now() ? {eventId: intent.eventId, expiresAt: intent.expiresAt} : null};
  }
  if (message.scope !== settings.scope) throw new Error('连接账号或服务已变化，请刷新豆瓣页面后重新操作；旧同步未发送到新账号');
  if (!settings.enabled) throw new Error('豆瓣标记自动同步尚未开启');
  if (!settings.authToken) throw new Error('请先在插件连接设置中配置 Token');
  if (message.type === 'DOUBAN_AUTO_REMOVE_ARM') {
    if (!/^[a-zA-Z0-9-]{20,80}$/.test(message.eventId || '')) throw new Error('删除意图标识无效');
    await chrome.storage.local.set({[intentKey]: {eventId: message.eventId, scope: settings.scope, subjectId: identity.id, tabId: sender.tab.id, documentId: sender.documentId || null, expiresAt: Date.now() + 120000}});
    return {enabled: true, state: 'armed'};
  }
  return serialDouban(key, async () => {
    if (message.type === 'DOUBAN_AUTO_CLEAR') {
      const data = await readDoubanQueue(key); data.queue = []; await chrome.storage.local.set({[key]: data});
      const stored = await chrome.storage.local.get(null);
      const intents = Object.keys(stored).filter(name => name.startsWith(`douban-remove:${settings.scope}:`) && name.endsWith(`:${identity.id}`));
      if (intents.length) await chrome.storage.local.remove(intents);
      return {enabled: true, state: 'cleared', pending: 0, message: '已清除本地待处理同步。核对 AIO Life 后，可重新在豆瓣保存或取消标记。'};
    }
    if (message.type === 'DOUBAN_AUTO_RETRY') return drainDouban(key, settings, true);
    if (message.type !== 'DOUBAN_AUTO_CONFIRMED' || !['not_started', 'completed', 'removed'].includes(message.status) || !/^[a-zA-Z0-9-]{20,80}$/.test(message.eventId || '')) throw new Error('不支持的豆瓣标记同步消息');
    const data = await readDoubanQueue(key);
    if (message.status === 'removed') {
      const intent = (await chrome.storage.local.get(intentKey))[intentKey];
      if (!intent || intent.eventId !== message.eventId || intent.expiresAt < Date.now()) throw new Error('未找到有效的豆瓣删除意图，未自动移除 AIO Life 记录');
    }
    if (data.last?.eventId === message.eventId || data.queue.some(item => item.eventId === message.eventId)) return summaryDouban(data, true);
    if (data.queue.length >= 20) throw new Error('该条目待处理同步过多，请先核实并处理前面的请求');
    data.queue.push({url: identity.url, status: message.status, eventId: message.eventId, metadata: safeDoubanMetadata(message.metadata), key: crypto.randomUUID(), createdAt: Date.now(), phase: 'ready', tabId: sender.tab.id});
    await chrome.storage.local.set({[key]: data});
    if (message.status === 'removed') await chrome.storage.local.remove(intentKey);
    return drainDouban(key, settings, false);
  });
}
async function applyDoubanRegistration(enabled) {
  const registered = await chrome.scripting.getRegisteredContentScripts({ids: [DOUBAN_SCRIPT_ID]});
  if (enabled && !registered.length) await chrome.scripting.registerContentScripts([{id: DOUBAN_SCRIPT_ID, matches: ['https://movie.douban.com/subject/*'], js: DOUBAN_FILES, runAt: 'document_idle', allFrames: false, persistAcrossSessions: true}]);
  if (!enabled && registered.length) await chrome.scripting.unregisterContentScripts({ids: [DOUBAN_SCRIPT_ID]});
  const tabs = await chrome.tabs.query({url: DOUBAN_ORIGIN});
  for (const tab of tabs) {
    if (!AioDoubanNative.movieIdentity(tab.url)) continue;
    try {
      if (enabled) await chrome.scripting.executeScript({target: {tabId: tab.id}, files: DOUBAN_FILES});
      await chrome.tabs.sendMessage(tab.id, {type: 'DOUBAN_AUTO_TOGGLE', enabled}, {frameId: 0});
    } catch { /* Closed/restricted tab; next navigation receives the registered script. */ }
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message.type?.startsWith('DOUBAN_AUTO_')) return;
  let action;
  if (message.type === 'DOUBAN_AUTO_SETTINGS_GET' || message.type === 'DOUBAN_AUTO_SETTINGS_SET') {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) { respond({success: false, error: '仅扩展设置页可更改自动同步'}); return; }
    action = (async () => {
      if (message.type.endsWith('_SET')) {
        if (typeof message.enabled !== 'boolean') throw new Error('无效开关值');
        const current = await doubanSettings();
        if (message.enabled && !current.granted) throw new Error('请先允许访问豆瓣影视详情页');
        if (message.enabled && !current.authToken) throw new Error('请先配置 AIO Life Token');
        await chrome.storage.local.set({doubanAutoEnabled: message.enabled});
        try { await applyDoubanRegistration(message.enabled); } catch (error) { if (message.enabled) { await chrome.storage.local.set({doubanAutoEnabled: false}); try { await applyDoubanRegistration(false); } catch {} } throw error; }
      }
      const settings = await doubanSettings(); return {enabled: settings.enabled, granted: settings.granted};
    })();
  } else action = handleDoubanPage(message, sender);
  action.then(data => respond({success: true, data})).catch(error => respond({success: false, error: error.message}));
  return true;
});
// Permissions may be revoked from the browser settings outside this popup.
chrome.permissions.onRemoved?.addListener(async () => { const settings = await doubanSettings(); if (!settings.enabled) { await chrome.storage.local.set({doubanAutoEnabled: false}); await applyDoubanRegistration(false); } });

async function restoreDoubanRegistration() { try { const settings = await doubanSettings(); await applyDoubanRegistration(settings.enabled); } catch { /* A later explicit settings action can retry registration. */ } }
chrome.runtime.onStartup?.addListener(restoreDoubanRegistration);
chrome.runtime.onInstalled?.addListener(restoreDoubanRegistration);
