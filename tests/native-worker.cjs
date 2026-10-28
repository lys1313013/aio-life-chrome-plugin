// Test-only Chrome service-worker host. Production code is evaluated unchanged.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto,createHash} = require('node:crypto');
const root = path.resolve(__dirname, '..');
function nativeWorker({fetchImpl = fetch, token = 'TEST-ONLY-NOT-A-REAL-TOKEN', base = 'https://api.test.invalid/api', enabled = true} = {}) {
  const storage = {authToken: token, apiBaseUrl: base, doubanAutoEnabled: enabled};
  const listeners = [], notifications = [], calls = [], registrations = [];
  let granted = true;
  const copy = value => structuredClone(value);
  const chrome = {
    runtime: {id:'test-id', getURL:p=>'chrome-extension://test-id/'+p, onMessage:{addListener:fn=>listeners.push(fn)}, onStartup:{addListener(){}}, onInstalled:{addListener(){}}},
    storage:{local:{setAccessLevel:async()=>{}, get:async keys => copy(keys == null ? storage : Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in storage).map(k=>[k,storage[k]]))), set:async update=>Object.assign(storage,copy(update)), remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete storage[key];}}},
    permissions:{contains:async()=>granted,onRemoved:{addListener(){}}},
    tabs:{query:async()=>[],sendMessage:async(tabId,message)=>notifications.push({tabId,message:copy(message)})},
    scripting:{getRegisteredContentScripts:async()=>registrations,registerContentScripts:async data=>registrations.push(...data),unregisterContentScripts:async()=>{registrations.length=0;},executeScript:async()=>{}}
  };
  const ctx = vm.createContext({URL,TextEncoder,crypto:webcrypto,AbortSignal,Blob,FormData,console,chrome,fetch:async(url,options)=>{
    const body=options.body?JSON.parse(options.body):null;
    const entry={path:new URL(url).pathname,status:body?.status,key:body?.idempotencyKey};calls.push(entry);
    const response=await fetchImpl(url,options);entry.httpStatus=response.status;return response;
  }});
  ctx.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),ctx,{filename:file}));
  ctx.importScripts('background.js');
  const sender=(url='https://movie.douban.com/subject/36445098/',tabId=1,documentId='doc-1')=>({id:'test-id',url,frameId:0,tab:{id:tabId},documentId});
  const send=(message,from=sender())=>new Promise(resolve=>{if(message.type!=='DOUBAN_AUTO_PAGE_GET'&&message.type?.startsWith('DOUBAN_AUTO_')&&!('scope' in message))message={...message,scope:createHash('sha256').update(storage.apiBaseUrl+'\n'+storage.authToken).digest('hex')};for(const listener of listeners){const handled=listener(message,from,resolve);if(handled===true)return;}resolve({success:false,error:'Unhandled test message'});});
  return {ctx,storage,send,sender,calls,notifications,setGranted:value=>{granted=value;}};
}
module.exports={nativeWorker};
