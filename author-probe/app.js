const $=id=>document.getElementById(id);
let current={};let busy=false;
function notify(text,error=false){$('notice').textContent=text;$('notice').className='notice'+(error?' error':'');}
async function api(path,options={}){
  const response=await fetch('/api/author'+path,{credentials:'same-origin',...options,headers:{'X-Author-Probe':'1',...(options.body instanceof File?{}:{'Content-Type':'application/json'}),...options.headers}});
  const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'请求没有完成，请稍后重试。');return data;
}
function setEditor(record={}){current=record;$('title').value=record.title||'';$('tags').value=(record.tags||[]).join('，');$('body').value=record.body||'';$('save-state').textContent=record.updatedAt?'已保存 '+new Date(record.updatedAt).toLocaleTimeString():'新草稿';$('preview').hidden=true;}
function renderPreview(){
  const target=$('preview-content');target.replaceChildren();
  for(const line of $('body').value.split('\n')){
    const image=line.match(/^!\[[^\]]*\]\((\/api\/author\/images\/[a-f0-9-]{36})\)$/);
    if(image){const element=document.createElement('img');element.src=image[1];element.alt='已上传的测试图片';target.append(element);}else{const element=document.createElement('p');element.textContent=line;target.append(element);}
  }
}
async function refreshList(){
  const {items}=await api('/drafts');const list=$('draft-list');list.replaceChildren();
  if(!items.length){const p=document.createElement('p');p.className='empty';p.textContent='还没有测试草稿，从右侧开始写一段吧。';list.append(p);return;}
  for(const item of items){const button=document.createElement('button');button.className='draft-item'+(current.id===item.id?' active':'');const title=document.createElement('strong');title.textContent=item.title;const time=document.createElement('small');time.textContent=new Date(item.updatedAt).toLocaleString();button.append(title,time);button.onclick=async()=>{try{setEditor(await api('/drafts/'+item.id));notify('已从云端重新打开草稿。');await refreshList();}catch(error){notify(error.message,true);}};list.append(button);}
}
async function init(){
  try{
    const status=await api('/status');
    if(!status.authConfigured){$('account').textContent='测试入口已准备好';$('login-detail').textContent='等待配置 GitHub 测试登录。当前草稿接口拒绝未登录访问。';return;}
    if(!status.storageReady){$('account').textContent='测试存储尚未就绪';$('login-detail').textContent='暂时不能保存，请等待验证完成。';return;}
    $('login').setAttribute('aria-disabled','false');
    try{const me=await api('/me');$('account').textContent='已登录 · '+me.login;$('login-detail').textContent='只保存测试草稿，不会更新公开博客。';$('login').hidden=true;$('logout').hidden=false;$('editor').disabled=false;$('new-draft').disabled=false;$('save-state').textContent='可以开始写作';await refreshList();}
    catch{$('account').textContent='用 GitHub 开始写作';$('login-detail').textContent='只读取公开身份信息，不申请仓库读写权限。';}
    if(new URLSearchParams(location.search).get('login')==='denied')notify('这个测试入口仅允许已绑定的作者账号。',true);
    if(new URLSearchParams(location.search).get('login')==='cancelled')notify('登录未完成，可以再次使用 GitHub 登录。');
  }catch(error){$('account').textContent='测试服务暂时不可用';notify(error.message,true);}
}
$('login').onclick=event=>{if($('login').getAttribute('aria-disabled')==='true')event.preventDefault();};
$('new-draft').onclick=()=>{if($('body').value&&current.body!==$('body').value&&!confirm('当前测试文字尚未保存，仍要新建吗？'))return;setEditor();notify('新草稿不会自动发表。');};
$('save').onclick=async()=>{
  if(busy)return;busy=true;$('save').disabled=true;$('save-state').textContent='正在保存…';
  try{const saved=await api('/drafts',{method:'POST',body:JSON.stringify({id:current.id,revision:current.revision,title:$('title').value,body:$('body').value,tags:$('tags').value.split(/[,，]/).map(tag=>tag.trim()).filter(Boolean)})});setEditor(saved);await refreshList();notify('草稿已保存。可以重新打开，核对文字和图片。');}
  catch(error){$('save-state').textContent='尚未保存';notify(error.message,true);}finally{busy=false;$('save').disabled=false;}
};
$('image').onchange=async()=>{
  const file=$('image').files[0];if(!file)return;
  if(file.size>2*1024*1024){notify('测试图片上限为 2 MiB，请选择较小的测试图片。',true);$('image').value='';return;}
  $('image').disabled=true;notify('正在上传测试图片…');
  try{const image=await api('/images',{method:'POST',headers:{'Content-Type':file.type},body:file});$('body').value+='\n\n![测试图片]('+image.url+')\n';$('save-state').textContent='有未保存修改';notify('图片已私有保存。请再保存草稿，保留正文中的图片引用。');}
  catch(error){notify(error.message,true);}finally{$('image').disabled=false;$('image').value='';}
};
$('preview-toggle').onclick=()=>{renderPreview();$('preview').hidden=!$('preview').hidden;};
$('logout').onclick=async()=>{try{const response=await fetch('/api/author/logout',{method:'POST',credentials:'same-origin',headers:{'X-Author-Probe':'1','Content-Type':'application/json'},body:'{}'});if(!response.ok)throw new Error('logout failed');location.replace('/author-probe/');}catch(error){notify('退出未完成，请重试。',true);}};
for(const id of ['title','tags','body'])$(id).addEventListener('input',()=>{$('save-state').textContent='有未保存修改';});
init();
