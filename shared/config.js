/* Extension connection settings. Storage methods run only in trusted extension contexts. */
(function (root) {
  'use strict';
  const DEFAULT_API = 'https://aiolife.top/api';
  function apiBase(value = DEFAULT_API) {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务地址必须是 HTTP(S) 地址，不能包含账号、查询参数或片段');
    return url.href.replace(/\/+$/, '');
  }
  async function read() {
    const config = await chrome.storage.local.get(['authToken', 'apiBaseUrl']);
    const base = apiBase(config.apiBaseUrl || DEFAULT_API);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${base}\n${config.authToken || ''}`));
    const scope = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
    return {...config, base, scope};
  }
  async function authHeaders() {
    const {authToken} = await chrome.storage.local.get(['authToken']);
    const headers = {'Content-Type': 'application/json'};
    if (authToken) headers.Authorization = authToken;
    return headers;
  }
  async function write({base, token, clearToken}) {
    const update = {apiBaseUrl: apiBase(base)};
    if (typeof token === 'string' && token.trim()) update.authToken = token.trim();
    if (clearToken) update.authToken = '';
    await chrome.storage.local.set(update);
  }
  root.AioConfig = Object.freeze({DEFAULT_API, apiBase, read, authHeaders, write});
  if (typeof module !== 'undefined') module.exports = root.AioConfig;
})(globalThis);
