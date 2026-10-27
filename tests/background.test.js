const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');const {webcrypto}=require('node:crypto');
const root=path.resolve(__dirname,'..');
function worker(fetchImpl){
 const listeners=[],storage={authToken:'TEST-ONLY-NOT-A-REAL-TOKEN',apiBaseUrl:'https://api.test.invalid/api'};
 const ctx=vm.createContext({URL,TextEncoder,TextDecoder,crypto:webcrypto,AbortSignal,Blob,FormData,setTimeout,clearTimeout,fetch:fetchImpl,console,chrome:{permissions:{contains:async()=>true},tabs:{query:async()=>[]},runtime:{id:'test-id',getURL:p=>'chrome-extension://test-id/'+p,onMessage:{addListener:fn=>listeners.push(fn)}},storage:{local:{setAccessLevel:async()=>{},get:async()=>storage,set:async update=>Object.assign(storage,update)}}}});
 ctx.importScripts=file=>vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),ctx);
 vm.runInContext(fs.readFileSync(path.join(root,'capture/background.js'),'utf8'),ctx);
 const send=(message,sender={id:'test-id',url:'chrome-extension://test-id/capture.html'})=>new Promise(resolve=>listeners[0](message,sender,resolve));
 return {ctx,storage,send};
}
test('page content cannot access capture transport/config, token never returned to editor',async()=>{
 let count=0;const w=worker(async()=>{count++;});
 const denied=await w.send({type:'CAPTURE_CONFIG_GET'},{id:'test-id',url:'https://details.jd.com/normal/item.action'});
 assert.equal(denied.success,false);assert.equal(count,0);
 const config=await w.send({type:'CAPTURE_CONFIG_GET'});assert.equal(config.data.configured,true);assert.equal(config.data.authToken,undefined);assert(!JSON.stringify(config).includes(w.storage.authToken));
});
test('duplicate in-flight logical commit sends once and backend business failure remains failure',async()=>{
 let count=0,release;const w=worker(async(url,options)=>{count++;assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');await new Promise(r=>release=r);return new Response(JSON.stringify({code:9,message:'业务拒绝'}));});
 const config=(await w.send({type:'CAPTURE_CONFIG_GET'})).data;
 const message={type:'CAPTURE_API',scope:config.scope,path:'/capture/purchase/commit',method:'POST',body:{idempotencyKey:'same-key'}};
 const first=w.send(message),second=w.send(message);for(let i=0;i<50&&!release;i++)await new Promise(r=>setTimeout(r,2));
 assert.equal(count,1);release();assert.equal((await first).success,false);assert.match((await second).error,/业务拒绝/);
});
test('changed account fails before network; arbitrary paths and image domains denied',async()=>{
 let count=0;const w=worker(async()=>{count++;});const config=(await w.send({type:'CAPTURE_CONFIG_GET'})).data;
 w.storage.authToken='OTHER-TEST-ACCOUNT';
 assert.equal((await w.send({type:'CAPTURE_API',scope:config.scope,path:'/capture/options'})).success,false);
 assert.equal((await w.send({type:'CAPTURE_API',path:'/sso/admin'})).success,false);
 assert.equal((await w.send({type:'CAPTURE_UPLOAD',url:'https://private.invalid/image.jpg',bizType:'read'})).success,false);
 assert.equal(count,0);
});


test('JD images validate SKU and permission before any page or network access',async()=>{
 const w=worker(async()=>{throw new Error('must not fetch anonymously');});let tabs=0;
 w.ctx.chrome.tabs.create=async()=>{tabs++;};
 assert.equal((await w.send({type:'CAPTURE_JD_IMAGES',sku:'123/../../admin'})).success,false);
 w.ctx.chrome.permissions.contains=async()=>false;
 assert.equal((await w.send({type:'CAPTURE_JD_IMAGES',sku:'123'})).success,false);assert.equal(tabs,0);
});

test('JD images prefer the matching rendered product tab and report inaccessible galleries',async()=>{
 let fetches=0;const w=worker(async()=>{fetches++;return new Response('<html>登录后访问</html>');});
 w.ctx.chrome.tabs.query=async query=>{assert.equal(query.url,'https://item.jd.com/123.html*');return [{id:9}];};
 w.ctx.chrome.scripting={executeScript:async details=>details.files?[]:[{result:['https://img12.360buyimg.com/n5/jfs/t1/a.jpg']}]};
 const result=await w.send({type:'CAPTURE_JD_IMAGES',sku:'123'});
 assert.equal(result.success,true);assert.equal(result.data.images[0],'https://img12.360buyimg.com/n1/jfs/t1/a.jpg');assert.equal(fetches,0);
 vm.runInContext('jdImageCache.clear()',w.ctx);
 w.ctx.chrome.scripting.executeScript=async()=>{throw new Error('tab closed');};
 const failure=await w.send({type:'CAPTURE_JD_IMAGES',sku:'123'});assert.equal(failure.success,false);assert.match(failure.error,/打开商品页/);assert.equal(fetches,0);
});

test('JD AVIF delivery URLs upload the original JPEG with its actual MIME type',async()=>{
 let uploads=0;
 const w=worker(async(url,options)=>{
  if(String(url).startsWith('https://img10.360buyimg.com/')){
   assert.equal(String(url),'https://img10.360buyimg.com/n1/jfs/t1/cover.jpg');
   return new Response(new Uint8Array([255,216,255]),{headers:{'content-type':'image/jpeg'}});
  }
  assert.equal(url,'https://api.test.invalid/api/file/upload');assert.equal(options.body.get('file').type,'image/jpeg');assert.equal(options.body.get('file').name,'capture.jpg');uploads++;
  return new Response(JSON.stringify({code:0,data:{id:'9007199254740993999'}}));
 });
 const result=await w.send({type:'CAPTURE_UPLOAD',url:'https://img10.360buyimg.com/pcpubliccms/s228x228_jfs/t1/cover.jpg.avif',bizType:'device'});
 assert.equal(result.success,true);assert.equal(result.data.id,'9007199254740993999');assert.equal(uploads,1);
});


test('JD dynamic page automatically loads in one inactive tab and closes only that temporary tab',async()=>{
 const w=worker(async()=>new Response('<html><div id="root"></div></html>'));
 let created=0,release;const removed=[];
 w.ctx.chrome.tabs.create=async options=>{created++;assert.equal(options.active,false);assert.equal(options.url,'https://item.jd.com/123.html');return {id:88};};
 w.ctx.chrome.tabs.get=async id=>({id,status:'complete',url:'https://item.jd.com/123.html?tracking=test'});
 w.ctx.chrome.tabs.remove=async id=>removed.push(id);
 w.ctx.chrome.scripting={executeScript:async details=>{assert.equal(details.target.tabId,88);if(details.files)return [];await new Promise(resolve=>release=resolve);return [{result:['https://img10.360buyimg.com/n1/jfs/cover.jpg']}];}};
 const first=w.send({type:'CAPTURE_JD_IMAGES',sku:'123'}), second=w.send({type:'CAPTURE_JD_IMAGES',sku:'123'});
 for(let i=0;i<100&&!release;i++)await new Promise(resolve=>setTimeout(resolve,2));
 assert.equal(created,1);release();assert.equal((await first).success,true);assert.equal((await second).success,true);assert.deepEqual(removed,[88]);
});

test('JD login redirect cleans up the temporary tab and retains a useful retry error',async()=>{
 const w=worker(async()=>new Response('<html>login</html>'));const removed=[];
 w.ctx.chrome.tabs.create=async()=>({id:89});
 w.ctx.chrome.tabs.get=async()=>({status:'complete',url:'https://passport.jd.com/login'});
 w.ctx.chrome.tabs.remove=async id=>removed.push(id);
 const result=await w.send({type:'CAPTURE_JD_IMAGES',sku:'123'});
 assert.equal(result.success,false);assert.match(result.error,/跳转到了京东登录页/);assert.deepEqual(removed,[89]);
});

test('JD product reader waits for the rendered gallery instead of accepting an early metadata image',async()=>{
 const {JSDOM}=require('jsdom');
 const dom=new JSDOM('<meta property="og:image" content="https://img10.360buyimg.com/n1/jfs/first.jpg"><div id="root"></div>',{url:'https://item.jd.com/123.html',runScripts:'outside-only'});
 const w=worker(async()=>{throw new Error('network should not be needed');});
 w.ctx.chrome.tabs.query=async()=>[{id:9}];
 w.ctx.chrome.scripting={executeScript:async details=>{
  if(details.files){dom.window.eval(fs.readFileSync(path.join(root,'capture/jd-images.js'),'utf8'));return [];}
  const fn=dom.window.eval('('+details.func.toString()+')');
  const pending=fn(...details.args);
  setTimeout(()=>{dom.window.document.querySelector('#root').innerHTML='<div class="preview-wrap"><div class="image-carousel thumbnails"><img src="https://img10.360buyimg.com/n1/jfs/first.jpg"><img src="https://img10.360buyimg.com/n1/jfs/second.jpg"></div></div>';},10);
  return [{result:await pending}];
 }};
 try{const result=await w.send({type:'CAPTURE_JD_IMAGES',sku:'123'});assert.equal(result.success,true);assert.equal(result.data.images.length,2);}finally{dom.window.close();}
});

for(const [url,pattern] of [
 ['https://cfe.m.jd.com/privatedomain/risk_handler/03101900/',/额外安全验证，与是否已登录无关/],
 [undefined,/已跳转.*已登录也可能需要安全验证/],
 ['https://www.jd.com/',/发生跳转/],
])test(`JD redirect classification: ${url || 'URL hidden by Chrome permission'}`,async()=>{
 const w=worker(async()=>{throw new Error('must not fetch anonymously');});
 w.ctx.chrome.tabs.create=async()=>({id:90});
 w.ctx.chrome.tabs.get=async()=>({status:'complete',url});
 w.ctx.chrome.tabs.remove=async()=>{};
 const result=await w.send({type:'CAPTURE_JD_IMAGES',sku:'123'});
 assert.equal(result.success,false);assert.match(result.error,pattern);
});

test('JD successful gallery is reused briefly across editor reloads; errors are not cached',async()=>{
 const w=worker(async()=>{throw new Error('must not fetch anonymously');});let reads=0;
 w.ctx.chrome.tabs.query=async()=>[{id:9}];
 w.ctx.chrome.scripting={executeScript:async details=>{if(details.files)return [];reads++;return [{result:['https://img10.360buyimg.com/n1/jfs/a.jpg']}];}};
 assert.equal((await w.send({type:'CAPTURE_JD_IMAGES',sku:'123'})).success,true);
 assert.equal((await w.send({type:'CAPTURE_JD_IMAGES',sku:'123'})).success,true);assert.equal(reads,1);
 w.ctx.chrome.permissions.contains=async()=>false;
 assert.equal((await w.send({type:'CAPTURE_JD_IMAGES',sku:'123'})).success,false);
 w.ctx.chrome.permissions.contains=async()=>true;
 vm.runInContext('jdImageCache.get("123").time -= 11 * 60 * 1000',w.ctx);
 assert.equal((await w.send({type:'CAPTURE_JD_IMAGES',sku:'123'})).success,true);assert.equal(reads,2);
});

async function savedAssetWorker(kind, fetchImpl) {
 const w=worker(fetchImpl), draftId='b'.repeat(64), id='9007199254740993123';
 const scope=(await w.send({type:'CAPTURE_CONFIG_GET'})).data.scope;
 w.storage['capture:'+draftId]={scope,result:{assets:[{kind,id}]}};
 return {...w,message:{type:'CAPTURE_ASSET_UPDATE',draftId,scope,kind,id}};
}
test('saved device updates only edited fields under original string ID and verifies the result',async()=>{
 let current={id:'9007199254740993123',name:'old',remark:'server remark',purchasePrice:'189.04'},puts=0;
 const w=await savedAssetWorker('device',async(url,options)=>{
  assert.equal(url,'https://api.test.invalid/api/device/9007199254740993123');
  if(options.method==='PUT'){puts++;assert.deepEqual(JSON.parse(options.body),{name:'new',fileId:'9007199254740993999'});Object.assign(current,JSON.parse(options.body));return new Response(JSON.stringify({code:0,data:true}));}
  return new Response(JSON.stringify({code:0,data:current}));
 });
 const message={...w.message,base:{name:'old',fileId:''},changes:{name:'new',fileId:'9007199254740993999'}};
 const result=await w.send(message);assert.equal(result.success,true);assert.equal(result.data.remark,'server remark');assert.equal(result.data.purchasePrice,'189.04');assert.equal(puts,1);
 assert.equal((await w.send(message)).success,true);assert.equal(puts,1,'retry reads already applied fields without another write');
});
test('saved wardrobe update preserves season and purchase fields outside the editor',async()=>{
 let current={id:'9007199254740993123',name:'shirt',season:'春,秋',price:189.04,purchaseDate:'2026-10-27',categoryId:'9007199254740993555'};
 const w=await savedAssetWorker('wardrobe',async(url,options)=>{
  assert.match(url,/\/wardrobe\/items\/9007199254740993123$/);
  if(options.method==='PUT'){const body=JSON.parse(options.body);assert.deepEqual(body.season,['春','秋']);assert.equal(body.price,189.04);assert.equal(body.purchaseDate,'2026-10-27');assert.equal(body.categoryId,'9007199254740993555');assert.equal(body.id,undefined);Object.assign(current,body,{season:'春,秋'});return new Response(JSON.stringify({code:0,data:null}));}
  return new Response(JSON.stringify({code:0,data:current}));
 });
 const result=await w.send({...w.message,base:{name:'shirt'},changes:{name:'updated shirt'}});assert.equal(result.success,true);assert.equal(result.data.name,'updated shirt');
});
test('saved asset rejects stale edits, foreign draft assets, unsafe fields and account changes',async()=>{
 let gets=0,puts=0;
 const w=await savedAssetWorker('device',async(url,options)=>{if(options.method==='PUT')puts++;else gets++;return new Response(JSON.stringify({code:0,data:{id:'9007199254740993123',name:'changed elsewhere'}}));});
 assert.match((await w.send({...w.message,base:{name:'old'},changes:{name:'mine'}})).error,/其他页面修改/);
 assert.equal((await w.send({...w.message,id:'123',changes:{name:'mine'}})).success,false);
 assert.equal((await w.send({...w.message,changes:{userId:'123'}})).success,false);
 assert.equal((await w.send({...w.message,changes:{name:''}})).success,false);
 assert.equal(puts,0);
 const before=gets;w.storage.authToken='CHANGED-TEST-ACCOUNT';assert.equal((await w.send({...w.message,type:'CAPTURE_ASSET_GET'})).success,false);assert.equal(gets,before);
});
test('saved device false update result and unconfirmed readback never report success',async()=>{
 for(const mode of ['false','unchanged']){
  const w=await savedAssetWorker('device',async(url,options)=>new Response(JSON.stringify({code:0,data:options.method==='PUT'?mode!=='false':{id:'9007199254740993123',name:'old'}})));
  const result=await w.send({...w.message,base:{name:'old'},changes:{name:'new'}});assert.equal(result.success,false);assert.match(result.error,/未更新|未确认|请求失败/);
 }
});
