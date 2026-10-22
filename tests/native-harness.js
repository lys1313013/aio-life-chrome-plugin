// Synthetic Douban DOM -> real detector -> real background -> isolated real API.
// Deliberately has no mock-success mode. Token never leaves this server.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {nativeWorker}=require('./native-worker.cjs');
const port=Number(process.env.NATIVE_UI_PORT||48765),base=process.env.CAPTURE_API_BASE||'http://127.0.0.1:45688/api';
const tokenFile=process.env.CAPTURE_TEST_AUTH_FILE;
const auth=tokenFile?JSON.parse(fs.readFileSync(tokenFile,'utf8')):{};
const token=process.env.CAPTURE_TEST_TOKEN||auth.token||auth.authToken||auth.data?.token||auth.users?.[0]?.token;
if(!token)throw new Error('Set CAPTURE_TEST_TOKEN or CAPTURE_TEST_AUTH_FILE for an isolated test account');
const worker=nativeWorker({base,token});
const subject=process.env.NATIVE_SUBJECT_ID||'99000036445098';
if(!/^\d+$/.test(subject))throw new Error('Invalid synthetic subject');
const movieUrl=`https://movie.douban.com/subject/${subject}/`;
const root=path.resolve(__dirname,'..');
const scripts=new Set(['/capture/core.js','/capture/adapters/common.js','/capture/adapters/douban.js','/douban-auto/detector.js','/douban-auto/content.js','/tests/native-harness-page.js']);
function send(res,status,value,mime='application/json'){res.writeHead(status,{'Content-Type':mime,'Cache-Control':'no-store'});res.end(mime==='application/json'?JSON.stringify(value):value);}
http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,`http://127.0.0.1:${port}`);
 if(req.headers.host!==`127.0.0.1:${port}`)return send(res,403,{error:'Host rejected'});
 if(url.pathname==='/')return send(res,200,fs.readFileSync(path.join(__dirname,'native-harness.html'),'utf8').replace('__SUBJECT__',subject),'text/html; charset=utf-8');
 if(scripts.has(url.pathname))return send(res,200,fs.readFileSync(path.join(root,url.pathname)),'text/javascript; charset=utf-8');
 if(url.pathname==='/__native/stats')return send(res,200,{mode:'real API / synthetic DOM',subject,calls:worker.calls.map(({path,status,httpStatus})=>({path,status,httpStatus})),notifications:worker.notifications.map(n=>n.message)});
 if(url.pathname!=='/__native/message')return send(res,404,{error:'Not found'});
 if(req.method!=='POST'||!(req.headers['content-type']||'').startsWith('application/json'))return send(res,415,{error:'JSON POST required'});
 if(req.headers.origin&&req.headers.origin!==`http://127.0.0.1:${port}`)return send(res,403,{error:'Origin rejected'});
 const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>16384)throw new Error('Request too large');chunks.push(c);}
 const body=JSON.parse(Buffer.concat(chunks).toString()),message=body.message;
 if(!['DOUBAN_AUTO_PAGE_GET','DOUBAN_AUTO_REMOVE_ARM','DOUBAN_AUTO_CONFIRMED','DOUBAN_AUTO_RETRY','DOUBAN_AUTO_CLEAR'].includes(message?.type)||message.url!==movieUrl)throw new Error('Unsupported test message');
 const result=await worker.send(message,worker.sender(movieUrl,1,String(body.documentId||'harness').slice(0,80)));
 send(res,200,result);
 }catch(error){send(res,200,{success:false,error:error.message});}
}).listen(port,'127.0.0.1',()=>console.log(`Native Douban synthetic harness: http://127.0.0.1:${port}/ (real isolated API; subject ${subject})`));
