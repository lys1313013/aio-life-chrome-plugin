/* Shared capture primitives. No cookies or page credentials leave the content script. */
(function (root) {
  'use strict';
  const DEFAULT_API = 'https://aiolife.top/api';
  function apiBase(value = DEFAULT_API) {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务地址必须是 HTTP(S) 地址，不能包含账号、查询参数或片段');
    return url.href.replace(/\/+$/, '');
  }
  function identify(value) {
    let url; try { url = new URL(value); } catch { return null; }
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const subject = url.pathname.match(/^\/subject\/(\d+)\/?$/);
    if (subject && ['book.douban.com', 'movie.douban.com'].includes(url.hostname)) return {kind: 'douban', mediaType: url.hostname.startsWith('book.') ? 'book' : 'movie', key: `${url.hostname}:${subject[1]}`, url: `https://${url.hostname}/subject/${subject[1]}/`};
    if ((url.hostname === 'jd.com' || url.hostname.endsWith('.jd.com')) && (/(?:order|detail)/i.test(url.pathname) || (url.hostname === 'details.jd.com' && url.pathname === '/normal/item.action'))) return {kind: 'purchase', platform: 'jd', key: url.origin + url.pathname + url.search, url: url.href};
    if ((url.hostname === 'taobao.com' || url.hostname.endsWith('.taobao.com') || url.hostname.endsWith('.tmall.com')) && /(?:order|detail)/i.test(url.pathname)) return {kind: 'purchase', platform: 'taobao', key: url.origin + url.pathname + url.search, url: url.href};
    return null;
  }
  function money(value, optional = false) {
    if ((value === '' || value == null) && optional) return undefined;
    const raw = String(value ?? '').trim();
    if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(raw)) throw new Error('金额须为非负数，最多 2 位小数，不支持科学计数法');
    const [whole, part = ''] = raw.split('.');
    return `${BigInt(whole)}.${part.padEnd(2, '0')}`;
  }
  function cents(value) { return BigInt(money(value).replace('.', '')); }
  function fromCents(value) { return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`; }
  function allocate(total, weights) {
    const amount = cents(total), values = weights.map(value => cents(value || '0'));
    let sum = values.reduce((a, b) => a + b, 0n);
    if (!sum) { values.fill(1n); sum = BigInt(values.length); }
    if (!sum) throw new Error('请先添加商品');
    const allocations = values.map(value => amount * value / sum);
    let rest = amount - allocations.reduce((a, b) => a + b, 0n);
    const ranks = values.map((value, index) => ({index, remainder: amount * value % sum})).sort((a, b) => a.remainder > b.remainder ? -1 : a.remainder < b.remainder ? 1 : a.index - b.index);
    for (const row of ranks) { if (rest-- <= 0n) break; allocations[row.index]++; }
    return allocations.map(fromCents);
  }
  function stableJSON(value) {
    if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }
  function submission(previous, payload, uuid = () => crypto.randomUUID()) {
    const fingerprint = stableJSON(payload);
    return previous?.fingerprint === fingerprint ? previous : {fingerprint, key: uuid()};
  }
  async function unwrap(response) {
    let result; try { result = await response.json(); } catch { throw new Error(`服务返回的不是 JSON（HTTP ${response.status}），请检查 API 地址`); }
    if (!response.ok || result?.code !== 0 || result.data === false) throw new Error(result?.message || `请求失败（HTTP ${response.status}）`);
    return result.data;
  }
  function validateOrder(order) {
    if (!order.items?.length) throw new Error('请至少添加一件商品');
    const keys = new Set();
    for (const item of order.items) {
      if (!item.sourceItemId?.trim() || keys.has(item.sourceItemId)) throw new Error('商品行标识重复或缺失，请重新采集商品');
      keys.add(item.sourceItemId);
      if (!item.title?.trim()) throw new Error('请填写商品名称');
      if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) throw new Error('商品数量必须为 1～100 的整数');
      money(item.paidAmount);
    }
    if (order.items.reduce((sum, item) => sum + cents(item.paidAmount), 0n) !== cents(order.paidAmount)) throw new Error('各商品行实付合计须等于订单实付（请计入优惠、运费分摊）');
  }
  root.AioCapture = {DEFAULT_API, apiBase, identify, money, cents, fromCents, allocate, stableJSON, submission, unwrap, validateOrder};
  if (typeof module !== 'undefined') module.exports = root.AioCapture;
})(globalThis);
