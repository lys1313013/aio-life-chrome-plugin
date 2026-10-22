(function (root) {
  'use strict';
  function plainText(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeName === 'BR') return '\n';
    const value = [...(node.childNodes || [])].map(plainText).join('');
    return /^(?:DIV|P|LI|TR|BODY|SECTION|FOOTER)$/.test(node.nodeName) ? '\n' + value + '\n' : value;
  }
  const text = node => (node?.innerText ?? plainText(node)).replace(/\u00a0/g, ' ').trim();
  const first = (doc, selectors) => { for (const selector of selectors) { const node = doc.querySelector(selector); if (text(node)) return text(node); } return ''; };
  const body = doc => text(doc.body);
  const label = (value, names, pattern) => {
    const match = value.match(new RegExp(`(?:^|[\\n\\r\\s])(?:${names.join('|')})\\s*[:：]?\\s*(${pattern})`, 'm'));
    return match?.[1]?.trim();
  };
  function amount(value, names) { return label(value, names, '[¥￥]?\\s*[0-9][0-9,]*(?:\\.[0-9]{1,2})?(?![0-9.])')?.replace(/[¥￥,\s]/g, ''); }
  function date(value, names) { return label(value, names, '\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}\\s+\\d{1,2}:\\d{2}(?::\\d{2})?')?.replace(/\//g, '-').replace(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/, (_, y, m, d, h, min, s) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')} ${h.padStart(2, '0')}:${min}:${s || '00'}`); }
  function image(node, base) {
    const img = node?.querySelector('img');
    const src = ['data-src', 'data-lazy-img', 'src'].map(key => img?.getAttribute(key)).find(value => value && /^(?:https?:)?\/\//.test(value));
    try { const url = new URL(src, base); return src && ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
  }
  function status(value) {
    // A refund link alone is not evidence that a refund happened.
    if (/部分退款(?:成功|完成)|部分商品已退款/.test(value)) return 'partial_refund';
    if (/退款成功|已全额退款|交易关闭|订单取消|已取消/.test(value)) return 'refunded';
    if (/待付尾款|定金已付|预售订单|合并付款|合并支付/.test(value)) return 'presale';
    if (/等待付款|待付款|待支付|尚未付款/.test(value)) return 'unpaid';
    if (/交易成功|订单完成|已完成/.test(value)) return 'completed';
    if (/等待卖家发货|等待买家收货|待发货|待收货|已支付|付款成功/.test(value)) return 'paid';
    return 'unknown';
  }
  function order(doc, url, platform, selectors) {
    const content = body(doc), parsed = new URL(url);
    const stateText = first(doc, ['.state-txt', '.order-status', '[class*="tradeStatus"]', '[class*="orderStatus"]']);
    const orderNo = label(content, ['订单编号', '订单号'], '[A-Za-z0-9-]{6,80}');
    const queryOrder = ['orderid', 'orderId', 'bizOrderId', 'biz_order_id', 'mainOrderId'].map(key => parsed.searchParams.get(key)).find(value => /^[A-Za-z0-9-]{6,80}$/.test(value || ''));
    const items = [], visited = new Set();
    for (const selector of selectors) {
      for (const row of doc.querySelectorAll(selector)) {
        const link = [...row.querySelectorAll('a[href]')].find(a => /(?:item\.jd\.com\/\d+|(?:item\.taobao|detail\.tmall)\.com\/item\.htm)/.test(a.href || ''));
        if (!link || visited.has(link) || [...visited].some(old => row.contains(old))) continue;
        visited.add(link);
        const rowText = text(row), itemUrl = new URL(link.href, url);
        const sku = row.getAttribute('data-sku') || row.getAttribute('productid') || itemUrl.pathname.match(/\/(\d+)\.html/)?.[1] || itemUrl.searchParams.get('id') || undefined;
        const spec = first(row, ['.p-extra .txt', '.p-extra', '.props', '.sku', '[class*="sku"]', '[class*="prop"]']) || undefined;
        const title = first(row, ['.p-name', '[class*="item-title"]', '[class*="itemTitle"]', '[class*="goods-name"]']) || text(link) || row.querySelector('img')?.alt || '';
        const qtyText = first(row, ['.goods-number', '.p-num', '.quantity', '[class*="quantity"]']);
        const quantityMatch = qtyText.match(/^(?:x|×)?\s*(\d+)\s*(?:件)?$/i) || rowText.match(/(?:数量[:：]?\s*|[×x]\s*)(\d+)(?:\s|$)/);
        let sourceItemId = row.getAttribute('data-order-item-id') || row.getAttribute('data-sub-order-id') || row.getAttribute('data-suborderid') || row.querySelector('[data-sub-order-id]')?.getAttribute('data-sub-order-id') || '';
        if (!sourceItemId && sku && quantityMatch) sourceItemId = `sku:${sku}|spec:${spec || ''}`;
        items.push({sourceItemId, title, sku, spec, quantity: quantityMatch ? Number(quantityMatch[1]) : null, paidAmount: amount(rowText, ['商品实付', '实付金额', '实付款']), imageUrl: image(row, url)});
      }
      if (items.length) break;
    }
    const canonical = new URL(parsed.origin + parsed.pathname);
    if (orderNo || queryOrder) canonical.searchParams.set(platform === 'jd' ? 'orderid' : 'biz_order_id', orderNo || queryOrder);
    const draft = {platform, orderNo: orderNo || queryOrder || '', sourceUrl: canonical.href, shopName: first(doc, ['.shop-name', '.seller-name', '[class*="shopName"]', '[class*="shop-name"]']) || undefined,
      orderStatus: status(stateText || content.split(/退款说明|猜你喜欢|为你推荐/)[0]), paidAmount: amount(content, ['实付款', '实付金额', '应付总额', '付款金额']), paidAt: date(content, ['支付时间', '付款时间']), orderedAt: date(content, ['下单时间', '创建时间', '成交时间']), freight: amount(content, ['运费']), discount: amount(content, ['优惠金额', '优惠总额']), items};
    // 应付 is not evidence of actual payment: never turn unpaid amounts into a paid value.
    if (!amount(content, ['实付款', '实付金额', '付款金额'])) delete draft.paidAmount;
    const warnings = [];
    const counts = new Map();
    for (const item of items) counts.set(item.sourceItemId, (counts.get(item.sourceItemId) || 0) + 1);
    items.forEach((item, index) => { if (!item.sourceItemId || counts.get(item.sourceItemId) > 1) item.sourceItemId = `line:${index + 1}`; });
    if (!items.length) warnings.push('未识别到商品明细。请确认打开的是订单详情页；可手动添加，不能使用商品标价代替实付。');
    if (items.some(item => !item.quantity)) warnings.push('部分商品数量未识别，请逐行确认。');
    if (!['paid', 'completed'].includes(draft.orderStatus)) warnings.push('订单未确认已支付，或包含退款／预售／合并支付；请核对实际购买金额及物品是否需要加入设备／衣柜。');
    return {kind: 'purchase', draft, warnings, adapterVersion: `${platform}-1`};
  }
  root.AioAdapters = {text, first, body, label, amount, date, image, status, order};
  if (typeof module !== 'undefined') module.exports = root.AioAdapters;
})(globalThis);
