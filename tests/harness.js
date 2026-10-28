// Local manual UI harness. Never part of the extension; API tokens remain server-side.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {HANDOFF_PROTOCOL} = require('../capture/core.js');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.CAPTURE_UI_PORT || 48763);
const apiBase = process.env.CAPTURE_API_BASE;
const id = crypto.createHash('sha256').update('aio-capture-ui-test-v2').digest('hex');
const scope = 'local-ui-test';
let doubanSaved;
const purchaseResults = new Map();
const savedAssets = new Map();
let assetSequence = 9000;
const order = {platform: 'jd', orderNo: 'UI-TEST-20261022', sourceUrl: 'https://details.jd.com/normal/item.action?orderid=UI-TEST-20261022', shopName: '测试商店', orderStatus: 'completed', paidAmount: '300.00', paidAt: '2026-10-22 10:30:00', orderedAt: '2026-10-21 20:15:00', freight: '0.00', items: [{sourceItemId: 'sku:test-mouse', title: '测试鼠标', sku: '100000001', quantity: 1, paidAmount: '100.00'}, {sourceItemId: 'sku:test-shirt', title: '测试衬衫', sku: '100000002', quantity: 2, paidAmount: '200.00'}]};
function fixture(kind) {
  return {kind, scope, captureVersion: 2, sourceKey: kind + ':ui-test', sourceTitle: 'UI 测试页面', adapterVersion: 'fixture-1', warnings: ['这是合成测试数据，不是真实个人订单。'], draft: kind === 'douban' ? {url: 'https://book.douban.com/subject/1084336/', metadata: {title: 'UI 测试图书', author: '测试作者', type: 1, totalProgress: 200}} : order};
}
async function fakeApi(message) {
  const b = message.body, p = message.path.split('?')[0];
  if (p === '/capture/options') return {deviceTypes:[{id:'103',name:'电脑外设'}],deviceStatuses:[{id:'104',name:'使用中'}],wardrobeCategories:[{id:'105',name:'上装'}]};
  if (p === '/capture/douban/preview') return {draft:{...b.metadata,url:b.url,mediaType:'book',subjectId:'1084336',status:'not_started',currentProgress:0},existing:doubanSaved,warnings:[]};
  if (p === '/capture/douban/commit') { doubanSaved={id:'9007199254740993101',version:'v1',fields:b.fields}; return {id:doubanSaved.id,mediaType:'book',operation:b.action==='update'?'updated':'created',version:'v1'}; }
  if (p === '/capture/purchase/preview') {
    const counts=new Map(),existingAssets=[];
    for(const item of b.items){
      const rows=[...savedAssets.values()].filter(asset=>asset.sourcePlatform===b.platform&&asset.sourceOrderId===b.orderNo&&asset.sourceProductId===item.sku);
      for(let unit=1;unit<=item.quantity;unit++){
        const index=counts.get(item.sku)||0;counts.set(item.sku,index+1);
        if(rows[index])existingAssets.push({kind:rows[index].kind,id:rows[index].id,sourceItemId:item.sourceItemId,unitIndex:unit});
      }
    }
    return {draft:b,warnings:[],existingAssets};
  }
  if (p === '/capture/purchase/commit') {
    if (!b.assets?.length) throw new Error('请至少选择一件商品');
    if (purchaseResults.has(b.idempotencyKey)) return purchaseResults.get(b.idempotencyKey);
    let createdCount=0;
    const reserved=new Set(b.assets.map(asset=>asset.existingId).filter(Boolean)),claimed=new Set();
    const assets=b.assets.map(a=>{
      const item=b.order.items.find(item=>item.sourceItemId===a.sourceItemId);
      const existing=[...savedAssets.values()].find(asset=>asset.sourcePlatform===b.order.platform&&asset.sourceOrderId===b.order.orderNo&&asset.sourceProductId===item.sku&&(a.existingId?asset.id===a.existingId:!reserved.has(asset.id)&&!claimed.has(asset.id)));
      if(a.existingId&&!existing)throw new Error('已保存物品不存在');
      if(existing){claimed.add(existing.id);return {sourceItemId:a.sourceItemId,unitIndex:a.unitIndex,kind:existing.kind,id:existing.id};}
      const asset={sourceItemId:a.sourceItemId,unitIndex:a.unitIndex,kind:a.kind,id:String(assetSequence++)};
      savedAssets.set(`${asset.kind}:${asset.id}`, {...a.fields,kind:asset.kind,id:asset.id,sourcePlatform:b.order.platform,sourceOrderId:b.order.orderNo,sourceProductId:item.sku});createdCount++;return asset;
    });
    const result={assets,createdCount,existingCount:assets.length-createdCount,operation:createdCount===0?'existing':createdCount===assets.length?'created':'mixed',replayExpiresAt:new Date(Date.now()+86400000).toISOString()};
    purchaseResults.set(b.idempotencyKey,result);return result;
  }
  throw new Error('Test endpoint not implemented: '+p);
}
function send(res, status, value, mime = 'application/json') { res.writeHead(status, {'Content-Type':mime,'Cache-Control':'no-store'});res.end(mime==='application/json'?JSON.stringify(value):value); }
http.createServer(async (req,res)=>{
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') { res.writeHead(302,{Location:`/capture.html?transfer=${id}&fixture=${url.searchParams.get('kind')||'purchase'}`});res.end();return; }
    if (url.pathname === '/__capture/seed') return send(res,200,{id,scope,state:fixture(url.searchParams.get('kind')==='douban'?'douban':'purchase'),live:Boolean(apiBase)});
    if (url.pathname === '/__capture/message') {
      if (req.method !== 'POST' || !(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, {success:false,error:'JSON POST required'});
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) return send(res,403,{success:false,error:'Origin rejected'});
      const chunks=[]; let bytes=0; for await(const chunk of req) { bytes+=chunk.length; if(bytes>1024*1024) throw new Error('Request too large'); chunks.push(chunk); }
      const message=JSON.parse(Buffer.concat(chunks).toString());
      if(message.type==='CAPTURE_CONFIG_GET') return send(res,200,{success:true,data:{base:apiBase||'http://test.invalid/api',scope,configured:true,handoffProtocol:HANDOFF_PROTOCOL}});
      if (['CAPTURE_ASSET_GET','CAPTURE_ASSET_UPDATE'].includes(message.type)) {
        if (!['device','wardrobe'].includes(message.kind) || !/^\d{1,30}$/.test(message.id)) throw new Error('Invalid asset');
        if (!apiBase) {
          const asset=savedAssets.get(`${message.kind}:${message.id}`);
          if (!asset) throw new Error('物品不存在');
          if (message.type==='CAPTURE_ASSET_UPDATE') Object.assign(asset,message.changes);
          return send(res,200,{success:true,data:asset});
        }
        // Live harness only reads saved assets; mutations require the real extension.
        if (message.type==='CAPTURE_ASSET_UPDATE') throw new Error('真实物品修改请使用插件');
        const assetPath=message.kind==='device'?`/device/${message.id}`:`/wardrobe/items/${message.id}`;
        const response=await fetch(apiBase.replace(/\/$/,'')+assetPath,{headers:{Authorization:process.env.CAPTURE_TEST_TOKEN||''}});
        const result=await response.json();
        return send(res,200,{success:response.ok&&result.code===0,data:result.data,error:result.message});
      }
      if(message.type!=='CAPTURE_API') return send(res,200,{success:false,error:'该UI harness未模拟图片上传；请用扩展或无图保存'});
      if(!/^\/capture\//.test(message.path)) throw new Error('Unsupported endpoint');
      if(!apiBase) return send(res,200,{success:true,data:await fakeApi(message)});
      const response=await fetch(apiBase.replace(/\/$/,'')+message.path,{method:message.method,headers:{'Content-Type':'application/json',Authorization:process.env.CAPTURE_TEST_TOKEN||''},body:message.body?JSON.stringify(message.body):undefined});
      const result=await response.json();
      return send(res,200,result.code===0&&response.ok?{success:true,data:result.data}:{success:false,error:result.message||`HTTP ${response.status}`,uncertain:response.status>=500||/结果不确定|无法确认.*提交|结果待确认|正在处理|处理中/.test(result.message||'')});
    }
    const filename=path.resolve(root,'.'+url.pathname);
    if(!filename.startsWith(root+path.sep)||!fs.existsSync(filename)||!fs.statSync(filename).isFile()||/node_modules|\.git|package-lock/.test(filename)) return send(res,404,{message:'Not found'});
    let data=fs.readFileSync(filename);
    if(url.pathname==='/capture.html') data=data.toString().replace('<script src="capture/core.js">','<script src="tests/chrome-shim.js"></script><script src="capture/core.js">');
    const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[path.extname(filename)]||'text/plain';
    send(res,200,data,mime);
  } catch(error) { send(res,200,{success:false,error:error.message}); }
}).listen(port,'127.0.0.1',()=>console.log(`Capture UI harness: http://127.0.0.1:${port}/ (${apiBase?'live API':'mock API'}; synthetic data only)`));
