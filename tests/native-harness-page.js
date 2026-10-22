/* Test-only synthetic site. The actual production detector receives real browser gestures. */
const subject=document.body.dataset.subject,url=`https://movie.douban.com/subject/${subject}/`,documentId=crypto.randomUUID();
const stateKey='native-harness-state:'+subject;
let status=sessionStorage.getItem(stateKey)||'';
const region=document.querySelector('#interest_sect_level');
function renderPersonal(){
 region.replaceChildren();
 if(!status){for(const [v,label] of [['wish','想看'],['collect','看过']]){const a=document.createElement('a');a.className='collect_btn colbutt ll';a.name=`pbtn-${subject}-${v}`;a.textContent=label;a.addEventListener('click',()=>openForm(v,true));region.append(a);}return;}
 const div=document.createElement('div');div.className='j a_stars';const span=document.createElement('span');span.className='mr10';span.textContent=`我${status==='collect'?'看过':'想看'}这部电影\n2026-10-22 (私人收藏) `;
 const edit=document.createElement('a');edit.className='collect_btn';edit.name=`pbtn-${subject}`;edit.textContent='修改';edit.addEventListener('click',()=>openForm(status,false));span.append(edit);div.append(span);region.append(div);
 const form=document.createElement('form');form.className='miniform';form.setAttribute('action','remove');form.innerHTML='<input type="submit" class="minisubmit j a_confirm_link" value="删除" title="删除这个收藏">';
 form.addEventListener('submit',event=>{
  event.preventDefault();document.querySelector('#remove-confirm')?.remove();
  const dialog=document.createElement('section');dialog.id='remove-confirm';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-label','合成豆瓣删除确认');
  const text=document.createElement('p');text.textContent='合成豆瓣：删除这个收藏？';dialog.append(text);
  const yes=document.createElement('button');yes.id='confirm-remove';yes.textContent='确认删除收藏';
  const no=document.createElement('button');no.id='cancel-remove';no.textContent='取消删除';
  yes.addEventListener('click',()=>{yes.disabled=true;sessionStorage.removeItem(stateKey);setTimeout(()=>location.reload(),120);});
  no.addEventListener('click',()=>dialog.remove());dialog.append(yes,no);document.body.append(dialog);
 });region.append(form);
}
function openForm(value,first){
 document.querySelector('#modal')?.remove();const modal=document.createElement('div');modal.id='modal';modal.innerHTML='<div class="interest-form-hd"><strong>合成标记表单</strong><div class="gact rr"><a>取消</a></div></div>';
 const form=document.createElement('form');form.className='j a_interest_form movie-sns';form.action=`https://movie.douban.com/j/subject/${subject}/interest`;
 if(first){const input=document.createElement('input');input.type='hidden';input.name='interest';input.value=value;form.append(input);const p=document.createElement('p');p.textContent=value==='wish'?'添加收藏：我想看这部电影':'添加收藏：我看过这部电影';form.append(p);}
 else{for(const [v,label]of[['wish','想看'],['collect','看过']]){const wrap=document.createElement('label');const input=document.createElement('input');input.type='radio';input.name='interest';input.value=v;input.checked=v===value;wrap.append(input,document.createTextNode(label));form.append(wrap);}}
 const save=document.createElement('input');save.type='submit';save.name='save';save.value='保存';form.append(save);modal.append(form);document.body.append(modal);
 modal.querySelector('.gact a').addEventListener('click',()=>modal.remove());
 form.addEventListener('submit',event=>{event.preventDefault();if(document.querySelector('#fail-save').checked)return;const next=(form.querySelector('input:checked')||form.querySelector('input[type=hidden]')).value;setTimeout(()=>{status=next;sessionStorage.setItem(stateKey,status);renderPersonal();modal.remove();},200);});
}
renderPersonal();
const app=AioDoubanAuto.start({document,url,transport:async message=>{const response=await fetch('/__native/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message,documentId}),keepalive:message.type==='DOUBAN_AUTO_REMOVE_ARM'});return response.json();}});
async function stats(){const value=await(await fetch('/__native/stats')).json();document.querySelector('#stats').textContent=JSON.stringify(value,null,2);}
document.querySelector('#refresh-stats').addEventListener('click',stats);stats();
