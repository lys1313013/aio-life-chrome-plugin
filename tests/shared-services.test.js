const test = require('node:test');
const assert = require('node:assert/strict');
const Config = require('../shared/config.js');
const Api = require('../shared/api.js');
test('business errors over HTTP 200 do not count as success',async()=>{
  await assert.rejects(Api.unwrap(new Response(JSON.stringify({code:1,message:'拒绝入库'}))),/拒绝入库/);
  await assert.rejects(Api.unwrap(new Response(JSON.stringify({code:'0',data:{id:'1'}}))),/请求失败/);
  await assert.rejects(Api.unwrap(new Response(JSON.stringify({code:0,data:false}))),/请求失败/);
  assert.deepEqual(await Api.unwrap(new Response(JSON.stringify({code:0,data:{id:'9007199254740993123'}}))),{id:'9007199254740993123'});
});
test('connection URLs normalize without accepting embedded credentials or query data', () => {
  assert.equal(Config.apiBase(), 'https://aiolife.top/api');
  assert.equal(Config.apiBase('https://example.com/api///'), 'https://example.com/api');
  for (const url of ['https://user:secret@example.com/api', 'https://example.com/api?token=x', 'https://example.com/api#token', 'file:///tmp/api']) assert.throws(() => Config.apiBase(url));
});
