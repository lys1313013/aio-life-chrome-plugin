const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const url='https://movie.douban.com/subject/36445098/';
const tick=()=>new Promise(r=>setTimeout(r,8));
function setup(transport){const dom=new JSDOM('<body><div id="interest_sect_level"></div></body>',{url,runScripts:'outside-only'});dom.window.eval(fs.readFileSync(path.join(__dirname,'../douban-auto/detector.js'),'utf8'));dom.window.eval(fs.readFileSync(path.join(__dirname,'../douban-auto/content.js'),'utf8'));const app=dom.window.AioDoubanAuto.start({document:dom.window.document,url,transport,requireTrusted:false});return{dom,app,close:()=>{app.stop();dom.window.close();}};}
test('uncertain native notice offers original retry and confirmed local clear; carries captured account scope',async()=>{
 const calls=[];const ctx=setup(async m=>{calls.push(m);return{success:true,data:m.type==='DOUBAN_AUTO_PAGE_GET'?{enabled:true,scope:'first-account-scope',state:'uncertain',pending:1,message:'结果待确认'}:{state:'cleared',pending:0,message:'已清除本地待处理同步'}};});
 try{await tick();const buttons=[...ctx.dom.window.document.querySelectorAll('#aio-douban-native-status button')];assert.equal(buttons.length,2);ctx.dom.window.confirm=()=>false;buttons[1].click();await tick();assert.equal(calls.length,1);ctx.dom.window.confirm=()=>true;buttons[1].click();await tick();assert.equal(calls[1].type,'DOUBAN_AUTO_CLEAR');assert.equal(calls[1].scope,'first-account-scope');assert.equal(calls.filter(m=>m.type==='DOUBAN_AUTO_CONFIRMED').length,0);assert.match(ctx.dom.window.document.querySelector('[role=status]').textContent,/已清除/);}finally{ctx.close();}
});
test('expired pending shows only local recovery, with no automatic retry on opening',async()=>{
 const calls=[];const ctx=setup(async m=>{calls.push(m);return{success:true,data:{enabled:true,scope:'account',state:'expired',pending:1,message:'已超过24小时'}};});
 try{await tick();const notice=ctx.dom.window.document.querySelector('[role=status]');assert.match(notice.textContent,/核实后清除待处理同步/);assert(!notice.textContent.includes('原请求重试'));assert.equal(calls.length,1);}finally{ctx.close();}
});
