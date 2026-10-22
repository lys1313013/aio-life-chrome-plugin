const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');const {webcrypto}=require('node:crypto');
const root=path.resolve(__dirname,'..');
function worker(fetchImpl){
 const listeners=[],storage={authToken:'TEST-ONLY-NOT-A-REAL-TOKEN',apiBaseUrl:'https://api.test.invalid/api'};
 const ctx=vm.createContext({URL,TextEncoder,crypto:webcrypto,AbortSignal,Blob,FormData,fetch:fetchImpl,console,chrome:{runtime:{id:'test-id',getURL:p=>'chrome-extension://test-id/'+p,onMessage:{addListener:fn=>listeners.push(fn)}},storage:{local:{setAccessLevel:async()=>{},get:async()=>storage,set:async update=>Object.assign(storage,update)}}}});
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
