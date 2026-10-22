(function (root) {
  root.AioAdapters.taobao = (doc, url) => root.AioAdapters.order(doc, url, 'taobao', ['[data-sub-order-id]', '[data-suborderid]', '.order-item', '.item-list .item', 'table tbody tr', '[class*="suborder"]', '[class*="orderItem"]']);
  if (typeof module !== 'undefined') module.exports = root.AioAdapters.taobao;
})(globalThis);
