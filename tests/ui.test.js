const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'..'),id='a'.repeat(64), key='capture:'+id;
const purchase={kind:'purchase',captureVersion:2,scope:'test',warnings:[],draft:{platform:'jd',orderNo:'1234567890123',sourceUrl:'https://details.jd.com/normal/item.action?orderid=1234567890123',shopName:'测试商店',orderStatus:'completed',paidAmount:'10.01',paidAt:'2026-10-22 12:00:00',orderedAt:'2026-10-22 11:00:00',items:[{sourceItemId:'line-1',title:'测试物品',quantity:2,paidAmount:'10.01'}]}};
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw new Error('UI did not settle');}
function setup(seed, handle) {
 const html=fs.readFileSync(path.join(root,'capture.html'),'utf8');const dom=new JSDOM(html,{url:`https://extension.test/capture.html?id=${id}`,runScripts:'outside-only'});const w=dom.window;
 const store={[key]:structuredClone(seed)}, calls=[];w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;Object.defineProperty(w.crypto,'subtle',{value:require('node:crypto').webcrypto.subtle});
 w.chrome={runtime:{sendMessage:async message=>{calls.push(structuredClone(message));if(message.type==='CAPTURE_CONFIG_GET')return {success:true,data:{scope:'test',configured:true}};try{return {success:true,data:await handle(message,calls)}}catch(e){return {success:false,error:e.message};}}},storage:{local:{get:async k=>({[k]:structuredClone(store[k])}),set:async values=>Object.assign(store,structuredClone(values)),remove:async k=>delete store[k]}},permissions:{request:async()=>false,contains:async()=>false}};
 w.eval(fs.readFileSync(path.join(root,'capture/core.js'),'utf8'));w.eval(fs.readFileSync(path.join(root,'capture/ui.js'),'utf8'));
 return {w,store,calls,close:()=>dom.window.close(),document:w.document};
}
function change(ctx, selector, value){const input=ctx.document.querySelector(selector);assert(input,selector);input.value=value;input.dispatchEvent(new ctx.w.Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));}
function submit(ctx){ctx.document.querySelector('form').dispatchEvent(new ctx.w.Event('submit',{bubbles:true,cancelable:true}));}
const opts={deviceTypes:[],deviceStatuses:[],wardrobeCategories:[]};
test('purchase saves only original assets; timeout requires manual same-key retry; success disables repeat',async()=>{
 let attempts=0;const commits=[];
 const ctx=setup(purchase,async message=>{
  if(message.type==='CAPTURE_ASSET_GET')return {id:message.id,name:'测试物品'};
  if(message.path==='/capture/options')return opts;
  if(message.path==='/capture/purchase/preview')return {draft:message.body,warnings:[]};
  if(message.path==='/capture/purchase/commit'){commits.push(message.body);attempts++;if(attempts===1)throw new Error('模拟网络超时');return {assets:message.body.assets.map(a=>({sourceItemId:a.sourceItemId,unitIndex:a.unitIndex,kind:a.kind,id:'9007199254740993888'})),operation:'created',replayExpiresAt:'2026-10-23T00:00:00Z'};}
  throw new Error(message.path);
 });
 try{
  await until(()=>ctx.document.querySelector('[data-field="shopName"]'));
  change(ctx,'[data-field="choice"]','device');
  await until(()=>!ctx.document.querySelector('#commit').disabled);
  submit(ctx);submit(ctx);await until(()=>ctx.document.querySelector('#messages').textContent.includes('模拟网络超时'));
  assert.equal(commits.length,1);assert(ctx.store[key].submission.key);assert.equal(commits[0].order.paidAmount,'10.01');assert.equal(commits[0].assets.length,1);assert.equal(commits[0].assets[0].unitIndex,1);assert.equal(commits[0].expense,undefined);assert.equal(commits[0].version,undefined);assert.equal(commits[0].assets[0].mode,undefined);assert(ctx.document.querySelector('#messages').textContent.includes('先核实'));assert.equal(ctx.document.querySelector('#editor').inert,true);
  submit(ctx);await until(()=>!ctx.document.querySelector('#result').hidden && ctx.document.querySelector('#commit').disabled);
  assert.equal(commits[0].idempotencyKey,commits[1].idempotencyKey);assert.equal(ctx.document.querySelector('#result').hidden,false);
  assert.equal(ctx.document.querySelector('#commit').disabled,true);submit(ctx);await new Promise(r=>setTimeout(r,10));assert.equal(commits.length,2);assert.match(ctx.document.querySelector('#result').textContent,/设备.*9007199254740993888/);assert(!ctx.document.body.textContent.includes('采购记录'));
 }finally{ctx.close();}
});
test('Douban existing record preserves progress, notes and personal rating; markup title rendered as text',async()=>{
 let commit;
 const seed={kind:'douban',scope:'test',warnings:[],draft:{url:'https://movie.douban.com/subject/1234567/',metadata:{title:'来源名称',type:2,totalProgress:12}}};
 const ctx=setup(seed,async message=>{
  if(message.path==='/capture/douban/preview')return {draft:{...message.body.metadata,mediaType:'movie'},existing:{id:'9007199254740993123',version:'v1',fields:{title:'<img src=x onerror=alert(1)>',type:2,totalProgress:12,currentProgress:7,status:'in_progress',remark:'我的原备注',rating:4}},warnings:[]};
  if(message.path==='/capture/douban/commit'){commit=message.body;return {id:'9007199254740993123',mediaType:'movie',operation:'updated',version:'v2'};}
 });
 try{
  await until(()=>!ctx.document.querySelector('#commit').disabled);
  assert.equal(ctx.document.querySelector('[data-field="currentProgress"]').value,'7');assert.equal(ctx.document.querySelector('[data-field="remark"]').value,'我的原备注');assert.equal(ctx.document.querySelector('[onerror]'),null);
  change(ctx,'[data-field="status"]','completed');submit(ctx);await until(()=>commit);
  assert.equal(commit.existingId,'9007199254740993123');assert.equal(commit.version,'v1');assert.equal(commit.fields.remark,undefined);assert.equal(commit.fields.rating,undefined);assert.equal(commit.fields.status,'completed');
 }finally{ctx.close();}
});
test('purchase saves edited values without preview or extra checkbox; errors retain editable draft',async()=>{
 const commits=[];
 const ctx=setup(purchase,async message=>{if(message.type==='CAPTURE_ASSET_GET')return {id:message.id,name:'测试物品'};
  if(message.path==='/capture/options')return opts;commits.push(message.body);throw new Error('锁定的菜单');});
 try{
  await until(()=>ctx.document.querySelector('[data-field="shopName"]'));
  assert.equal(ctx.document.querySelector('#preview').hidden,true);
  assert.equal(ctx.document.querySelector('.check input'),null);
  change(ctx,'[data-field="choice"]','device');
  change(ctx,'[data-field="paidAmount"]','20.00');
  assert.equal(ctx.document.querySelector('#commit').disabled,false);
  submit(ctx);assert.match(ctx.document.querySelector('#messages').textContent,/合计/);assert.equal(commits.length,0);
  const amounts=ctx.document.querySelectorAll('[data-field="paidAmount"]');amounts[1].value='20.00';amounts[1].dispatchEvent(new ctx.w.Event('input'));
  submit(ctx);await until(()=>ctx.document.querySelector('#messages').textContent.includes('锁定的菜单'));
  assert.equal(commits.length,1);assert.equal(commits[0].order.paidAmount,'20.00');assert.equal(commits[0].amountConfirmed,true);
  assert.equal(ctx.calls.some(call=>call.path?.endsWith('/preview')),false);
  assert.equal(ctx.document.querySelector('#editor').inert,false);
  assert.equal(ctx.document.querySelector('[data-field="paidAmount"]').value,'20.00');
 }finally{ctx.close();}
});
test('account scope change prevents requests and editing old private drafts',async()=>{
 const ctx=setup({...purchase,scope:'old-account'},async()=>{throw new Error('must not be called');});
 try{await until(()=>ctx.document.querySelector('#messages').textContent.includes('连接账号或服务已变化'));assert.equal(ctx.calls.filter(c=>c.type==='CAPTURE_API').length,0);assert.equal(ctx.document.querySelector('form').hidden,true);}finally{ctx.close();}
});
test('version-conflict re-preview preserves other-client edits and sends only local dirty fields',async()=>{
 let previews=0;const commits=[];
 const seed={kind:'douban',scope:'test',warnings:[],draft:{url:'https://book.douban.com/subject/1234567/',metadata:{title:'来源图书',type:1}}};
 const ctx=setup(seed,async message=>{
  if(message.path==='/capture/douban/preview'){previews++;return {draft:message.body.metadata,existing:{id:'9007199254740993123',version:`v${previews}`,fields:{title:'已有图书',type:1,currentProgress:previews===1?10:20,totalProgress:100,status:'in_progress',remark:previews===1?'旧备注':'其他客户端的新备注'}},warnings:[]};}
  if(message.path==='/capture/douban/commit'){commits.push(message.body);if(commits.length===1)throw new Error('版本冲突，请重新预览');return {id:'9007199254740993123',mediaType:'book',operation:'updated',version:'v3'};}
 });
 try{
  await until(()=>!ctx.document.querySelector('#commit').disabled);change(ctx,'[data-field="status"]','on_hold');submit(ctx);await until(()=>ctx.document.querySelector('#messages').textContent.includes('版本冲突'));
  ctx.document.querySelector('#preview').click();await until(()=>previews===2&&!ctx.document.querySelector('#commit').disabled);
  assert.equal(ctx.document.querySelector('[data-field="remark"]').value,'其他客户端的新备注');assert.equal(ctx.document.querySelector('[data-field="currentProgress"]').value,'20');assert.equal(ctx.document.querySelector('[data-field="status"]').value,'on_hold');
  submit(ctx);await until(()=>commits.length===2);assert.equal(commits[1].version,'v2');assert.deepEqual(structuredClone(commits[1].fields),{status:'on_hold'});
 }finally{ctx.close();}
});
test('switching Douban subject opens isolated draft, never carries old existingId or notes',async()=>{
 const commits=[];
 const seed={kind:'douban',scope:'test',sourceKey:'book.douban.com:1234567',warnings:[],draft:{url:'https://book.douban.com/subject/1234567/',metadata:{title:'旧图书',type:1}}};
 const ctx=setup(seed,async message=>{
  if(message.path==='/capture/douban/preview')return message.body.url.includes('1234567')?{draft:message.body.metadata,existing:{id:'9007199254740993123',version:'v1',fields:{title:'旧图书',type:1,currentProgress:10,totalProgress:100,status:'in_progress',remark:'旧条目备注'}},warnings:[]}:{draft:{title:'新图书',type:1,status:'not_started',currentProgress:0,totalProgress:200},existing:null,warnings:[]};
  if(message.path==='/capture/douban/commit'){commits.push(message.body);return {id:'9007199254740993124',mediaType:'book',operation:'created',version:'v1'};}
 });
 try{
  await until(()=>!ctx.document.querySelector('#commit').disabled);change(ctx,'[data-field="url"]','https://book.douban.com/subject/7654321/');ctx.document.querySelector('#preview').click();await until(()=>ctx.document.querySelector('[data-field="title"]')?.value==='新图书'&&!ctx.document.querySelector('#commit').disabled);
  assert.notEqual(new URL(ctx.w.location.href).searchParams.get('id'),id);assert.equal(ctx.store[key].draft.url,'https://book.douban.com/subject/1234567/');assert.equal(ctx.document.querySelector('[data-field="remark"]').value,'');
  submit(ctx);await until(()=>commits.length);assert.equal(commits[0].existingId,undefined);assert.equal(commits[0].action,'create');assert.equal(commits[0].url,'https://book.douban.com/subject/7654321/');
 }finally{ctx.close();}
});
test('purchase requires at least one selected item; each chosen unit creates one original asset',async()=>{
 const commits=[];
 const ctx=setup(purchase,async message=>{
  if(message.type==='CAPTURE_ASSET_GET')return {id:message.id,name:'测试物品'};
  if(message.path==='/capture/options')return opts;
  if(message.path.endsWith('/preview'))return {draft:message.body,warnings:[]};
  commits.push(message.body);return {assets:message.body.assets.map((a,i)=>({sourceItemId:a.sourceItemId,unitIndex:a.unitIndex,kind:a.kind,id:String(100+i)})),operation:'created'};
 });
 try{
  await until(()=>ctx.document.querySelector('[data-field="shopName"]'));
  assert.equal(ctx.document.querySelector('[data-field="sourceItemId"]'),null);assert.equal(ctx.document.querySelector('[data-field="mode"]'),null);
  await until(()=>!ctx.document.querySelector('#commit').disabled);
  submit(ctx);await until(()=>ctx.document.querySelector('#messages').textContent.includes('至少选择一件'));assert.equal(commits.length,0);
  change(ctx,'[data-field="choice"]','device');
  const second=ctx.document.querySelectorAll('[data-field="choice"]')[1];second.value='wardrobe';second.dispatchEvent(new ctx.w.Event('change'));
  submit(ctx);await until(()=>commits.length);assert.equal(commits[0].assets.length,2);assert.equal(commits[0].assets[0].kind,'device');assert.equal(commits[0].assets[1].kind,'wardrobe');assert.equal(commits[0].assets[1].unitIndex,2);
 }finally{ctx.close();}
});
test('expired uncertain purchase request is not sent again automatically or manually',async()=>{
 const C=require('../capture/core');const seed=structuredClone(purchase);
 seed.captureVersion=2;seed.preview={draft:seed.draft,warnings:[]};seed.previewFingerprint=C.stableJSON(seed.draft);seed.amountConfirmed=true;seed.assetChoices=[[{choice:'device',fields:{name:'测试物品'}},{choice:'none'}]];seed.uncertain=true;
 const order=structuredClone(seed.draft);const payload={order,amountConfirmed:true,assets:[{sourceItemId:'line-1',unitIndex:1,kind:'device',fields:{name:'测试物品'}}]};
 seed.submission={fingerprint:C.stableJSON(payload),key:'old-key',startedAt:Date.now()-86400001};
 const ctx=setup(seed,async message=>{if(message.type==='CAPTURE_ASSET_GET')return {id:message.id,name:'测试物品'};
  if(message.path==='/capture/options')return opts;throw new Error('No writes expected');});
 try{await until(()=>ctx.document.querySelector('[data-field="shopName"]'));submit(ctx);await until(()=>ctx.document.querySelector('#messages').textContent.includes('24 小时'));assert.equal(ctx.calls.filter(c=>c.path?.endsWith('/commit')).length,0);}finally{ctx.close();}
});
test('purchase with no order number uses local line identity and saves directly to wardrobe',async()=>{
 const seed=structuredClone(purchase);delete seed.draft.orderNo;seed.draft.items[0].sourceItemId='';let payload;
 const ctx=setup(seed,async message=>{
  if(message.type==='CAPTURE_ASSET_GET')return {id:message.id,name:'测试物品'};
  if(message.path==='/capture/options')return opts;
  if(message.path.endsWith('/preview'))return {draft:message.body,warnings:[]};
  payload=message.body;return {assets:[{sourceItemId:message.body.assets[0].sourceItemId,unitIndex:1,kind:'wardrobe',id:'9007199254740993555'}],operation:'created',retryStatus:'unconfirmed',warnings:['记录已保存，但重试结果缓存未确认；勿重新创建']};
 });
 try{
  await until(()=>ctx.document.querySelector('[data-field="shopName"]'));change(ctx,'[data-field="choice"]','wardrobe');await until(()=>!ctx.document.querySelector('#commit').disabled);
  submit(ctx);await until(()=>ctx.document.querySelector('#result').textContent.includes('勿重新创建'));
  assert.equal(payload.order.orderNo,undefined);assert.match(payload.assets[0].sourceItemId,/^local:/);assert.equal(ctx.document.querySelector('#commit').disabled,true);
 }finally{ctx.close();}
});

test('JD product gallery selects and uploads a cover independently of the order image',async()=>{
 const seed=structuredClone(purchase);seed.draft.items[0].sku='9007199254740993123';seed.draft.items[0].imageUrl='https://img10.360buyimg.com/n1/jfs/order.jpg';
 const galleryUrl='https://img10.360buyimg.com/n1/jfs/product.jpg';let releaseImages;const commits=[];
 const ctx=setup(seed,async message=>{
  if(message.type==='CAPTURE_ASSET_GET')return {id:message.id,name:'测试物品'};
  if(message.path==='/capture/options')return opts;
  if(message.type==='CAPTURE_JD_IMAGES'){await new Promise(resolve=>releaseImages=resolve);return {images:[galleryUrl,'https://evil.invalid/x.jpg']};}
  if(message.type==='CAPTURE_UPLOAD'){assert.equal(message.url,galleryUrl);assert.equal(message.bizType,'device');return {id:'9007199254740993999'};}
  commits.push(message.body);return {assets:[{kind:'device',id:'1001'}],operation:'created'};
 });
 ctx.w.chrome.permissions.request=async()=>true;ctx.w.chrome.permissions.contains=async()=>true;
 const button=text=>[...ctx.document.querySelectorAll('button')].find(node=>node.textContent===text);
 try{
  await until(()=>ctx.document.querySelector('[data-field="choice"]'));change(ctx,'[data-field="choice"]','device');
  await until(()=>releaseImages);
  assert.equal(button('选择商品封面'),undefined);assert.equal(button('使用订单图片'),undefined);
  assert.equal(ctx.document.querySelector('.cover-gallery button').getAttribute('aria-label'),'使用订单图');
  assert.equal(ctx.document.querySelector('#commit').disabled,false);assert.match(ctx.document.querySelector('.image-control').textContent,/正在读取/);
  releaseImages();await until(()=>ctx.document.querySelectorAll('.cover-gallery button').length===2);
  assert.equal(ctx.document.querySelectorAll('.cover-gallery button').length,2);
  ctx.document.querySelector('[aria-label="使用商品图 1"]').click();await until(()=>ctx.document.querySelector('[aria-label="使用商品图 1"]').getAttribute('aria-pressed')==='true');
  assert.equal(ctx.document.querySelector('[aria-label="使用订单图"]').getAttribute('aria-pressed'),'false');
  submit(ctx);await until(()=>commits.length);
  assert.equal(commits[0].assets[0].fields.fileId,'9007199254740993999');
  assert.equal(commits[0].assets[0].fields.coverUrl,undefined);assert.equal(commits[0].order.items[0].imageUrl,seed.draft.items[0].imageUrl);
  assert.equal(ctx.calls.some(call=>call.path?.endsWith('/preview')),false);
 }finally{ctx.close();}
});

test('JD image permission denial and read failure allow retry and saving without a cover',async()=>{
 const seed=structuredClone(purchase);seed.draft.items[0].sku='123456';let attempts=0;
 const ctx=setup(seed,async message=>{
  if(message.type==='CAPTURE_ASSET_GET')return {id:message.id,name:'测试物品'};
  if(message.path==='/capture/options')return opts;
  if(message.type==='CAPTURE_JD_IMAGES'){attempts++;throw new Error('未读取到商品主图，请打开商品页后重试');}
  return {assets:[{kind:'device',id:'1001'}],operation:'created'};
 });
 const button=text=>[...ctx.document.querySelectorAll('button')].find(node=>node.textContent===text);
 try{
  await until(()=>ctx.document.querySelector('[data-field="choice"]'));change(ctx,'[data-field="choice"]','device');
  await until(()=>button('允许读取商品图片')&&!button('允许读取商品图片').hidden);
  button('允许读取商品图片').click();await until(()=>!button('允许读取商品图片').disabled);
  assert.equal(attempts,0);assert.equal(ctx.document.querySelector('#commit').disabled,false);
  ctx.w.chrome.permissions.request=async()=>true;button('允许读取商品图片').click();await until(()=>ctx.document.querySelector('.image-control').textContent.includes('未读取到'));
  assert.equal(attempts,1);assert.equal(button('重试读取商品图片').disabled,false);
  button('无图保存').click();submit(ctx);await until(()=>!ctx.document.querySelector('#result').hidden);
 }finally{ctx.close();}
});


test('same SKU automatically shares one gallery request across units and rerenders',async()=>{
 const seed=structuredClone(purchase);seed.draft.items[0].sku='123456';seed.draft.items[0].imageUrl='https://img10.360buyimg.com/order.jpg';
 seed.assetChoices=[[{choice:'device',fields:{name:'第一件'}},{choice:'device',fields:{name:'第二件'}}]];
 let release,requests=0,permissionPrompts=0;
 const ctx=setup(seed,async message=>{
  if(message.type==='CAPTURE_ASSET_GET')return {id:message.id,name:'测试物品'};
  if(message.path==='/capture/options')return opts;
  if(message.type==='CAPTURE_JD_IMAGES'){requests++;await new Promise(resolve=>release=resolve);return {images:['https://img10.360buyimg.com/product.jpg']};}
 });
 ctx.w.chrome.permissions.contains=async()=>true;ctx.w.chrome.permissions.request=async()=>{permissionPrompts++;return true;};
 try{
  await until(()=>release);assert.equal(requests,1);
  assert.equal(ctx.document.querySelectorAll('[aria-label="使用订单图"]').length,2);
  release();await until(()=>ctx.document.querySelectorAll('[aria-label="使用商品图 1"]').length===2);
  assert.equal(requests,1);assert.equal(permissionPrompts,0);
 }finally{ctx.close();}
});

function savedPurchaseSeed() {
 const seed=structuredClone(purchase);
 seed.result={operation:'created',assets:[{id:'9007199254740993123',kind:'device',sourceItemId:'line-1',unitIndex:1}]};
 seed.assetChoices=[[{choice:'device',fields:{name:'old draft name',fileId:'old-cover'}}]];
 return seed;
}
test('saved purchase automatically edits current asset fields and cover using update, never purchase commit',async()=>{
 const seed=savedPurchaseSeed();seed.draft.items[0].imageUrl='https://img10.360buyimg.com/n1/jfs/order.jpg';
 let current={id:'9007199254740993123',name:'current server name',type:'t1',status:'1',remark:'server remark',fileId:'old-cover'},writes=0;
 const ctx=setup(seed,async message=>{
  if(message.path==='/capture/options')return {deviceTypes:[{id:'t1',name:'家电'},{id:'t2',name:'其他'}],deviceStatuses:[{id:'1',name:'使用中'},{id:'4',name:'吃灰中'}]};
  if(message.type==='CAPTURE_ASSET_GET')return current;
  if(message.type==='CAPTURE_UPLOAD')return {id:'new-cover'};
  assert.equal(message.type,'CAPTURE_ASSET_UPDATE');assert.equal(message.id,'9007199254740993123');assert.equal(message.draftId,id);
  assert.deepEqual(structuredClone(message.changes),{name:'edited name',status:'4',fileId:'new-cover'});assert.equal(message.base.remark,'server remark');writes++;current={...current,...message.changes};return current;
 });ctx.w.chrome.permissions.request=async()=>true;
 try{
  await until(()=>!ctx.document.querySelector('#edit-saved').hidden);
  await until(()=>ctx.document.querySelector('[data-field="name"]')?.value==='current server name'&&!ctx.document.querySelector('#editor').inert);
  assert.equal(ctx.document.querySelector('[data-field="choice"]'),null);assert.equal(ctx.document.querySelector('[data-field="paidAmount"]'),null);assert.equal(ctx.document.querySelector('#commit').disabled,true);
  change(ctx,'[data-field="name"]','edited name');change(ctx,'[data-field="status"]','4');
  ctx.document.querySelector('[aria-label="使用订单图"]').click();await until(()=>ctx.document.querySelector('[aria-label="使用订单图"]').getAttribute('aria-pressed')==='true');
  await until(()=>!ctx.document.querySelector('#commit').disabled);
  assert.equal(ctx.document.querySelector('#commit').textContent,'保存修改');submit(ctx);submit(ctx);
  await until(()=>ctx.document.querySelector('#messages').textContent.includes('已更新 1 件'));assert.equal(writes,1);assert.equal(ctx.store[key].result.assets[0].id,'9007199254740993123');assert.equal(ctx.store[key].assetEdits[0].base.fileId,'new-cover');
  assert.equal(ctx.document.querySelector('#editor').inert,false);assert.equal(ctx.document.querySelector('#commit').disabled,true);assert(!ctx.calls.some(c=>c.path?.endsWith('/commit')));
 }finally{ctx.close();}
});
test('saved multi-asset partial failure retains only failed edits for retry and refresh',async()=>{
 const seed=savedPurchaseSeed();seed.result.assets.push({id:'9007199254740993124',kind:'wardrobe',sourceItemId:'line-1',unitIndex:2});
 let fail=true;const writes=[];
 const ctx=setup(seed,async message=>{
  if(message.path==='/capture/options')return opts;
  if(message.type==='CAPTURE_ASSET_GET')return {id:message.id,name:message.kind};
  assert.equal(message.type,'CAPTURE_ASSET_UPDATE');writes.push(message.id);
  if(message.kind==='wardrobe'&&fail)throw new Error('模拟更新超时');
  return {id:message.id,...message.changes};
 });
 try{
  await until(()=>!ctx.document.querySelector('#edit-saved').hidden);
  await until(()=>ctx.document.querySelectorAll('[data-field="name"]').length===2&&!ctx.document.querySelector('#editor').inert&&ctx.document.querySelector('#commit').textContent==='保存修改');
  const names=ctx.document.querySelectorAll('[data-field="name"]');for(const input of names){input.value+=' edited';input.dispatchEvent(new ctx.w.Event('input'));}
  submit(ctx);await until(()=>ctx.document.querySelector('#messages').textContent.includes('模拟更新超时'));
  assert.equal(ctx.store[key].assetEdits[0].base.name,'device edited');assert.equal(ctx.store[key].assetEdits[1].base.name,'wardrobe');assert.equal(ctx.store[key].assetEdits[1].fields.name,'wardrobe edited');
  fail=false;submit(ctx);await until(()=>ctx.document.querySelector('#messages').textContent==='已更新 1 件物品。');
  assert.deepEqual(writes,['9007199254740993123','9007199254740993124','9007199254740993124']);assert(!ctx.calls.some(c=>c.path?.endsWith('/commit')));
 }finally{ctx.close();}
});

test('newly created purchase immediately enters editable original asset without a separate edit click',async()=>{
 let creates=0,reads=0;
 const ctx=setup(purchase,async message=>{
  if(message.path==='/capture/options')return opts;
  if(message.type==='CAPTURE_ASSET_GET'){reads++;return {id:message.id,name:'saved server name',status:'1'};}
  assert.equal(message.path,'/capture/purchase/commit');creates++;
  return {operation:'created',assets:[{kind:'device',id:'9007199254740993123',sourceItemId:'line-1',unitIndex:1}]};
 });
 try{
  await until(()=>ctx.document.querySelector('[data-field="choice"]'));change(ctx,'[data-field="choice"]','device');submit(ctx);
  await until(()=>ctx.document.querySelector('[data-field="name"]')?.value==='saved server name'&&!ctx.document.querySelector('#editor').inert);
  assert.equal(reads,1);assert.equal(creates,1);assert.equal(ctx.document.querySelector('#commit').textContent,'保存修改');
  change(ctx,'[data-field="name"]','another name');assert.equal(ctx.document.querySelector('#commit').disabled,false);
 }finally{ctx.close();}
});

test('saved asset read failure shows an explicit retry instead of a locked creation form',async()=>{
 let failure=true,reads=0;
 const ctx=setup(savedPurchaseSeed(),async message=>{
  if(message.path==='/capture/options')return opts;
  assert.equal(message.type,'CAPTURE_ASSET_GET');reads++;
  if(failure)throw new Error('模拟读取失败');return {id:message.id,name:'recovered'};
 });
 try{
  await until(()=>ctx.document.querySelector('#messages').textContent.includes('模拟读取失败')&&!ctx.document.querySelector('#edit-saved').disabled);
  assert.equal(ctx.document.querySelector('[data-field="choice"]'),null);assert.equal(ctx.document.querySelector('[data-field="name"]'),null);
  assert.equal(ctx.document.querySelector('#edit-saved').textContent,'重试读取物品');failure=false;ctx.document.querySelector('#edit-saved').click();
  await until(()=>ctx.document.querySelector('[data-field="name"]')?.value==='recovered'&&!ctx.document.querySelector('#editor').inert);assert.equal(reads,2);
 }finally{ctx.close();}
});

test('reopened saved edit draft retains unsaved changes and stays editable without overwriting them',async()=>{
 const seed=savedPurchaseSeed();
 seed.assetEdits=[{...seed.result.assets[0],choice:'device',fields:{name:'unsaved',type:'',status:'1',remark:'',fileId:''},base:{name:'server',type:'',status:'1',remark:'',fileId:''}}];
 let reads=0;
 const ctx=setup(seed,async message=>{if(message.path==='/capture/options')return opts;reads++;throw new Error('must preserve unsaved draft');});
 try{
  await until(()=>ctx.document.querySelector('[data-field="name"]')?.value==='unsaved'&&!ctx.document.querySelector('#editor').inert);
  assert.equal(ctx.document.querySelector('#commit').disabled,false);assert.equal(reads,0);
 }finally{ctx.close();}
});
