/* Authenticated server transport shared by independent background features. */
(function (root) {
  'use strict';
  async function envelope(response, errorMessage) {
    let result;
    try { result = await response.json(); }
    catch { throw new Error(`服务返回的不是 JSON（HTTP ${response.status}），请检查 API 地址`); }
    if (!response.ok || result?.code !== 0 || result.data === false) throw new Error(result?.message || errorMessage || `请求失败（HTTP ${response.status}）`);
    return result;
  }
  async function unwrap(response) { return (await envelope(response)).data; }
  async function request(path, {method = 'GET', body, scope, headers: suppliedHeaders, fullResponse = false, errorMessage, uncertainWrite = false, requireToken = true, transport = {}} = {}) {
    const config = await root.AioConfig.read();
    if (scope && config.scope !== scope) throw new Error('连接账号或服务已变化，请重新采集页面，避免混用账号');
    if (requireToken && !config.authToken) throw new Error('请先在插件连接设置中保存 Token');
    const headers = suppliedHeaders ? {...suppliedHeaders} : {};
    if (!suppliedHeaders && config.authToken) headers.Authorization = config.authToken;
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const options = {
      method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      credentials: transport.credentials ?? 'omit', redirect: transport.redirect ?? 'error'
    };
    const timeoutMs = transport.timeoutMs === undefined ? 30000 : transport.timeoutMs;
    if (timeoutMs !== null) options.signal = AbortSignal.timeout(timeoutMs);
    let response;
    try { response = await fetch(config.base + path, options); }
    catch (error) { error.uncertain = uncertainWrite; throw error; }
    try {
      const result = await envelope(response, errorMessage);
      return fullResponse ? result : result.data;
    } catch (error) {
      error.uncertain = uncertainWrite && (response.status >= 500 || /JSON|结果不确定|无法确认.*提交|结果待确认|正在处理|处理中/.test(error.message));
      throw error;
    }
  }
  root.AioApi = Object.freeze({request, unwrap});
  if (typeof module !== 'undefined') module.exports = root.AioApi;
})(globalThis);
