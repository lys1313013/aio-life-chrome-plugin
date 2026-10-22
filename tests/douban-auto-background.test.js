const test=require('node:test'),assert=require('node:assert/strict');
const {nativeWorker}=require('./native-worker.cjs');
const url='https://movie.douban.com/subject/36445098/';
let sequence=0;
const confirmed=(status='not_started',extra={})=>({type:'DOUBAN_AUTO_CONFIRMED',url,status,eventId:`test-event-${String(++sequence).padStart(25,'0')}`,metadata:{title:'Synthetic movie',director:'Synthetic director',type:1,notes:'never send',rating:5},...extra});
const success=body=>new Response(JSON.stringify({code:0,data:{id:body.status==='removed'?null:'9007199254740993001',mediaType:'movie',operation:body.status==='removed'?'absent':'updated',status:body.status}}));
const queues=w=>Object.entries(w.storage).filter(([key])=>key.startsWith('douban-native:'));
test('native channel rejects foreign sender, iframe, other subject, nondefault port and disabled sync; never exposes Token',async()=>{
 const w=nativeWorker({fetchImpl:async(u,o)=>success(JSON.parse(o.body))});
 for(const sender of [{...w.sender(),frameId:1},{...w.sender(),id:'evil'},w.sender('https://movie.douban.com/subject/999/'),w.sender('https://movie.douban.com:8443/subject/36445098/')]) assert.equal((await w.send(confirmed(),sender)).success,false);
 assert.equal(w.calls.length,0);
 assert.equal((await w.send({type:'CAPTURE_API',path:'/capture/douban/sync'},w.sender())).success,false);
 const state=await w.send({type:'DOUBAN_AUTO_PAGE_GET',url});assert.equal(state.success,true);assert(!JSON.stringify(state).includes(w.storage.authToken));
 w.storage.doubanAutoEnabled=false;assert.equal((await w.send(confirmed())).success,false);assert.equal(w.calls.length,0);
});
test('confirmed same-subject changes serialize, deduplicate event and whitelist metadata',async()=>{
 const order=[];let release;const w=nativeWorker({fetchImpl:async(u,o)=>{const body=JSON.parse(o.body);order.push(body.status);assert.equal(body.metadata.notes,undefined);assert.equal(body.metadata.rating,undefined);if(order.length===1)await new Promise(r=>release=r);return success(body);}});
 const first=confirmed(),second=confirmed('completed');const p1=w.send(first),p2=w.send(second);
 for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,2));assert.equal(w.calls.length,1);release();await Promise.all([p1,p2]);assert.deepEqual(order,['not_started','completed']);
 await w.send(second);assert.equal(w.calls.length,2);assert.equal(queues(w)[0][1].queue.length,0);
});
test('HTTP 500 and malformed success are uncertain; retry keeps original key and later action stays behind',async()=>{
 let failure=true;const w=nativeWorker({fetchImpl:async(u,o)=>failure?new Response(JSON.stringify({code:500,message:'server error'}),{status:500}):success(JSON.parse(o.body))});
 const first=await w.send(confirmed());assert.equal(first.data.state,'uncertain');const oldKey=w.calls[0].key;
 await w.send(confirmed('completed'));assert.equal(w.calls.length,1);assert.equal(queues(w)[0][1].queue.length,2);
 failure=false;const retried=await w.send({type:'DOUBAN_AUTO_RETRY',url});assert.equal(retried.data.state,'success');assert.equal(w.calls[1].key,oldKey);assert.deepEqual(w.calls.map(x=>x.status),['not_started','not_started','completed']);
 const bad=nativeWorker({fetchImpl:async()=>new Response(JSON.stringify({code:0,data:{id:3,mediaType:'movie',status:'completed',operation:'created'}}))});
 assert.equal((await bad.send(confirmed())).data.state,'uncertain');
});
test('removal requires matching unexpired persisted intent across documents',async()=>{
 const w=nativeWorker({fetchImpl:async(u,o)=>success(JSON.parse(o.body))});const remove=confirmed('removed');
 assert.equal((await w.send(remove)).success,false);assert.equal(w.calls.length,0);
 await w.send({type:'DOUBAN_AUTO_REMOVE_ARM',url,eventId:remove.eventId});
 const page=await w.send({type:'DOUBAN_AUTO_PAGE_GET',url},w.sender(url,1,'doc-after-navigation'));assert.equal(page.data.removeIntent.eventId,remove.eventId);assert(page.data.removeIntent.expiresAt>Date.now());
 const result=await w.send(remove,w.sender(url,1,'doc-after-navigation'));assert.equal(result.data.state,'success');assert.equal(result.data.result.operation,'absent');
 const expired=confirmed('removed');await w.send({type:'DOUBAN_AUTO_REMOVE_ARM',url,eventId:expired.eventId});Object.entries(w.storage).filter(([k])=>k.startsWith('douban-remove:')).forEach(([,v])=>v.expiresAt=Date.now()-1);
 assert.equal((await w.send(expired)).success,false);assert.equal(w.calls.length,1);
});
test('expired queue cannot write; clear only removes current account and subject pending state without API call',async()=>{
 const w=nativeWorker({fetchImpl:async()=>{throw new TypeError('Failed to fetch');}});
 await w.send(confirmed());const [key,data]=queues(w)[0];data.queue[0].createdAt=Date.now()-86400001;
 const otherUrl='https://movie.douban.com/subject/888/';await w.send(confirmed('completed',{url:otherUrl}),w.sender(otherUrl,2));
 const token=w.storage.authToken;const oldScope=(await w.send({type:'DOUBAN_AUTO_PAGE_GET',url})).data.scope;w.storage.authToken='OTHER-TEST-ACCOUNT';assert.equal((await w.send({...confirmed(),scope:oldScope})).success,false);await w.send(confirmed());w.storage.authToken=token;
 const before=w.calls.length;const retry=await w.send({type:'DOUBAN_AUTO_RETRY',url});assert.equal(retry.data.state,'expired');assert.equal(w.calls.length,before);
 const clear=await w.send({type:'DOUBAN_AUTO_CLEAR',url});assert.equal(clear.data.state,'cleared');assert.equal(w.calls.length,before);assert.equal(w.storage[key].queue.length,0);
 assert.equal(queues(w).filter(([,d])=>d.queue.length).length,2,'other account and other movie retained');
});
test('worker restart surfaces sending as uncertain, and fresh account cannot drain old queue',async()=>{
 const w=nativeWorker({fetchImpl:async()=>{throw new TypeError('Network disconnected');}});await w.send(confirmed());const [key,data]=queues(w)[0];data.queue[0].phase='sending';
 const state=await w.send({type:'DOUBAN_AUTO_PAGE_GET',url});assert.equal(state.data.state,'uncertain');const before=w.calls.length;w.storage.authToken='NEW-ACCOUNT';
 const fresh=await w.send({type:'DOUBAN_AUTO_PAGE_GET',url});assert.equal(fresh.data.pending,0);await w.send({type:'DOUBAN_AUTO_RETRY',url});assert.equal(w.calls.length,before);assert.equal(w.storage[key].queue.length,1);
});
