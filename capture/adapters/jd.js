(function (root) {
  root.AioAdapters.jd = (doc, url) => {
    const A = root.AioAdapters;
    const result = A.order(doc, url, 'jd', ['table.tb-order tr[productid]', '.goods-table tbody tr', '.tb-void tbody tr', '.goods-list .goods-item', '.order-goods .goods-item', '[data-order-item-id]', '[data-sku]']);
    const draft = result.draft;
    for (const li of doc.querySelectorAll('li')) {
      if (/^实付款[:：]?$/.test(A.text(li.querySelector('.label')))) {
        draft.paidAmount = A.text(li.querySelector('.txt.count')).replace(/[¥￥,\s]/g, '');
      }
    }
    for (const item of doc.querySelectorAll('#pay-info-nozero .item')) {
      if (/^付款时间[:：]?$/.test(A.text(item.querySelector('.label')))) draft.paidAt = A.date('付款时间：' + A.text(item.querySelector('.info-rcol')), ['付款时间']);
    }
    const ordered = A.text(doc.querySelector('#track_time_0')).replace(/\s+/g, ' ');
    if (ordered) draft.orderedAt = A.date('下单时间：' + ordered, ['下单时间']);
    if (A.text(doc.querySelector('.state-txt')) === '完成') draft.orderStatus = 'completed';
    if (['paid', 'completed'].includes(draft.orderStatus)) result.warnings = result.warnings.filter(value => !value.startsWith('订单未确认已支付'));
    if (draft.items.length === 1 && draft.paidAmount && !draft.items[0].paidAmount) {
      draft.items[0].paidAmount = draft.paidAmount;
      result.warnings.push('该订单只有一行商品，行实付使用整单实付（含运费／优惠）；请确认。');
    }
    return result;
  };
  if (typeof module !== 'undefined') module.exports = root.AioAdapters.jd;
})(globalThis);
