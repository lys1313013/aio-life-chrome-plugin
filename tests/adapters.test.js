const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {JSDOM}=require('jsdom');
require('../capture/core');const A=require('../capture/adapters/common');require('../capture/adapters/douban');require('../capture/adapters/jd');require('../capture/adapters/taobao');
function doc(name,url){return new JSDOM(fs.readFileSync(path.join(__dirname,'fixtures',name),'utf8'),{url}).window.document;}
test('JD observed DOM selectors: paid differs from price; completed footer is not refund; strips secret query',()=>{
  const url='https://details.jd.com/normal/item.action?orderid=12345678901234&PassKey=DO-NOT-RETAIN';const r=A.jd(doc('jd-order.html',url),url);
  assert.equal(r.draft.orderNo,'12345678901234');assert.equal(r.draft.paidAmount,'189.04');assert.equal(r.draft.orderStatus,'completed');assert.equal(r.draft.paidAt,'2026-10-20 18:31:00');assert.equal(r.draft.orderedAt,'2026-10-20 18:30:15');
  assert.equal(r.draft.items[0].quantity,1);assert.equal(r.draft.items[0].paidAmount,'189.04');assert.match(r.draft.items[0].sourceItemId,/^sku:100000001/);assert.equal(r.draft.items[0].imageUrl,'https://img10.360buyimg.com/test.png');
  assert(!JSON.stringify(r).includes('DO-NOT-RETAIN'));assert(!r.warnings.some(w=>w.includes('未确认已支付')));
});
test('duplicate SKU/spec rows remain separate stable order lines, never merge quantities',()=>{
  const url='https://details.jd.com/normal/item.action?orderid=12345678901234';const d=doc('jd-order.html',url);const row=d.querySelector('tr');row.parentElement.append(row.cloneNode(true));const r=A.jd(d,url);
  assert.equal(r.draft.items.length,2);assert.deepEqual(r.draft.items.map(i=>i.sourceItemId),['sku:100000001|spec:黑色 27英寸|row:1','sku:100000001|spec:黑色 27英寸|row:2']);assert(r.draft.items.every(i=>i.paidAmount===undefined));
});
test('Taobao fixture preserves large IDs and line totals for multi-quantity items',()=>{
  const url='https://trade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId=8888888888888888888&token=PRIVATE';const r=A.taobao(doc('taobao-order.html',url),url);
  assert.equal(r.draft.orderNo,'8888888888888888888');assert.equal(r.draft.items.length,2);assert.equal(r.draft.items[0].sourceItemId,'8888888888888888889');assert.equal(r.draft.items[0].quantity,2);assert.equal(r.draft.items[0].paidAmount,'80.05');assert.equal(r.draft.paidAmount,'100.00');assert(!r.draft.sourceUrl.includes('PRIVATE'));
});
test('Douban captures source metadata but never public rating as personal rating',()=>{
  const url='https://book.douban.com/subject/1234567/?from=share';const r=A.douban(doc('douban-book.html',url),url);
  assert.equal(r.draft.url,'https://book.douban.com/subject/1234567/');assert.equal(r.draft.metadata.totalProgress,320);assert.equal(r.draft.metadata.author,'测试作者');assert.equal(r.draft.metadata.rating,undefined);assert.equal(r.draft.metadata.title,'测试图书 <script>');
});
test('missing quantities/prices stay missing; unpaid is not mistaken for purchase',()=>{
  const url='https://trade.taobao.com/trade/detail/order.htm?bizOrderId=12345678';const d=new JSDOM('<body><div class="order-status">待付款</div><div data-sub-order-id="x"><a href="https://item.taobao.com/item.htm?id=123">测试商品</a><span>¥999</span></div><div>应付总额：999</div></body>',{url}).window.document;
  const r=A.taobao(d,url);assert.equal(r.draft.orderStatus,'unpaid');assert.equal(r.draft.paidAmount,undefined);assert.equal(r.draft.items[0].quantity,null);assert.equal(r.draft.items[0].paidAmount,undefined);
});
test('Taobao standard biz_order_id query fallback is retained without unrelated query secrets',()=>{
 const url='https://trade.taobao.com/trade/detail/trade_item_detail.htm?biz_order_id=8888888888888888888&token=PRIVATE';
 const d=doc('taobao-order.html',url);d.body.innerHTML=d.body.innerHTML.replace('订单编号：8888888888888888888','订单详情');const r=A.taobao(d,url);
 assert.equal(r.draft.orderNo,'8888888888888888888');assert.equal(new URL(r.draft.sourceUrl).searchParams.get('biz_order_id'),'8888888888888888888');assert(!r.draft.sourceUrl.includes('PRIVATE'));
});

test('fallback order line identity survives unrelated row reordering and missing quantity',()=>{
 const url='https://details.jd.com/normal/item.action?orderid=12345678901234';
 const d=doc('jd-order.html',url), first=A.jd(d,url).draft.items[0];
 const row=d.querySelector('tr'), other=row.cloneNode(true);
 for(const link of other.querySelectorAll('a[href]'))link.href=link.href.replace('100000001','200000002');
 other.removeAttribute('data-sku');other.removeAttribute('productid');
 row.parentElement.prepend(other);
 const repeated=A.jd(d,url).draft.items.find(item=>item.sku===first.sku);
 assert.equal(repeated.sourceItemId,first.sourceItemId);
 const qty=row.querySelector('.goods-number,.p-num,.quantity');if(qty)qty.textContent='';
 assert.equal(A.jd(d,url).draft.items.find(item=>item.sku===first.sku).sourceItemId,first.sourceItemId);
});
