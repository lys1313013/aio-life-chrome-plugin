const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../capture/core.js');
test('money is exact decimal, allocation preserves every cent and deterministic tails', () => {
  assert.equal(C.money('000001.5'), '1.50');
  assert.equal(C.cents('999999999999.99'), 99999999999999n);
  assert.deepEqual(C.allocate('100.00',['1','1','1']), ['33.34','33.33','33.33']);
  assert.deepEqual(C.allocate('0.01',['0','0']), ['0.01','0.00']);
  for (const invalid of ['-1','NaN','1e3','0.001','1,000','']) assert.throws(()=>C.money(invalid));
});
test('same semantic submission keeps key after timeout; editing creates new key',()=>{
  let index=0; const uuid=()=>`key-${++index}`;
  const first=C.submission(null,{fields:{id:'9007199254740993123',title:'a'}},uuid);
  assert.equal(C.submission(first,{fields:{title:'a',id:'9007199254740993123'}},uuid).key,first.key);
  assert.notEqual(C.submission(first,{fields:{title:'b',id:'9007199254740993123'}},uuid).key,first.key);
});
test('business errors over HTTP 200 do not count as success',async()=>{
  await assert.rejects(C.unwrap(new Response(JSON.stringify({code:1,message:'拒绝入库'}))),/拒绝入库/);
  await assert.rejects(C.unwrap(new Response(JSON.stringify({code:'0',data:{id:'1'}}))),/请求失败/);
  await assert.rejects(C.unwrap(new Response(JSON.stringify({code:0,data:false}))),/请求失败/);
  assert.deepEqual(await C.unwrap(new Response(JSON.stringify({code:0,data:{id:'9007199254740993123'}}))),{id:'9007199254740993123'});
});
test('order validation rejects ambiguous lines and mismatched allocation',()=>{
  const item={sourceItemId:'a',title:'测试',quantity:1,paidAmount:'1.00'};
  const o={orderNo:'123456789',paidAmount:'1.00',items:[item]};
  C.validateOrder(o);
  assert.throws(()=>C.validateOrder({...o,items:[item,item]}),/重复/);
  assert.throws(()=>C.validateOrder({...o,paidAmount:'2.00'}),/合计/);
  assert.throws(()=>C.validateOrder({...o,items:[{...item,quantity:0}]}),/数量/);
});
test('only supported detail pages identified, no lookalike domains',()=>{
  assert.equal(C.identify('https://book.douban.com/subject/123/?from=home').url,'https://book.douban.com/subject/123/');
  assert.equal(C.identify('https://evil-douban.com/subject/123'),null);
  assert.equal(C.identify('https://item.jd.com/123.html'),null);
  assert.equal(C.identify('https://details.jd.com/normal/item.action?orderid=1234567').platform,'jd');
  assert.throws(()=>C.apiBase('https://user:secret@example.com/api'));
});
