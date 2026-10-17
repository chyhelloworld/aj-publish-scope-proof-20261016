import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createPublicationService, PublicationError } from './publication-service.js';

const API='/api/author';
const OWNER='103913273';
const IMAGE_LIMIT=2*1024*1024;
const SESSION_COOKIE='__Host-author_probe_session';
const STATE_COOKIE='__Host-author_probe_state';
const ID=/^[a-f0-9-]{36}$/;
const TOKEN=/^[a-f0-9]{64}$/;
const PRIVATE_HEADERS={'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'};
class RequestError extends Error { constructor(status,message){super(message);this.status=status;} }
const fail=(status,message)=>{throw new RequestError(status,message);};
const json=(status,data)=>new Response(JSON.stringify(data),{status,headers:{...PRIVATE_HEADERS,'Content-Type':'application/json; charset=utf-8'}});
const cookie=(name,value,age)=>`${name}=${value}; Max-Age=${age}; Path=/; HttpOnly; Secure; SameSite=Lax`;
const cookies=request=>Object.fromEntries((request.headers.get('cookie')||'').split(';').map(part=>part.trim().split(/=(.*)/s).slice(0,2)).filter(pair=>pair.length===2));
const equal=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const left=Buffer.from(a);const right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};
const writes={cacheControl:'private, no-store'};

// Dependency injection is for local contract tests. The deployed wrapper always
// uses the project-managed Blob SDK and the real GitHub endpoints.
export function createAuthorHandler({getStore,env,fetchImpl=fetch,now=()=>Date.now()}){
  const database=()=>getStore();
  const read=key=>database().get(key,{type:'json',consistency:'strong'});
  const write=(key,value)=>database().setJSON(key,value,writes);
  const remove=key=>database().delete(key);
  const config=()=>({origin:env.AUTH_ORIGIN||'',clientId:env.GITHUB_CLIENT_ID||'',clientSecret:env.GITHUB_CLIENT_SECRET||''});
  const ready=()=>{const c=config();return /^https:\/\/[^/]+$/.test(c.origin)&&c.clientId&&c.clientSecret;};
  function redirect(location,cookieValues=[]){const headers=new Headers({...PRIVATE_HEADERS,Location:location});for(const value of cookieValues)headers.append('Set-Cookie',value);return new Response(null,{status:303,headers});}
  function mutation(request){
    if(request.headers.get('origin')!==config().origin||request.headers.get('x-author-probe')!=='1')fail(403,'请从测试写作页面操作。');
  }
  async function session(request){
    const value=cookies(request)[SESSION_COOKIE];
    if(!value||!TOKEN.test(value))fail(401,'请先使用 GitHub 登录。');
    const stored=await read(`sessions/${value}.json`);
    if(!stored||stored.expiresAt<=now()||String(stored.userId)!==OWNER)fail(401,'登录已失效，请重新登录。');
    return {...stored,sessionKey:`sessions/${value}.json`};
  }
  async function bodyJson(request){
    const text=await request.text();if(Buffer.byteLength(text)>250000)fail(413,'本次测试的正文请控制在 250 KB 以内。');
    try{return JSON.parse(text);}catch{fail(400,'请求格式不正确。');}
  }
  async function versions(id){
    const result=await database().list({prefix:`drafts/${id}/`,limit:200,consistency:'strong'});
    return result.blobs.map(blob=>blob.key).filter(key=>key.endsWith('.json')).sort();
  }
  async function latest(id){const keys=await versions(id);return keys.length?read(keys.at(-1)):null;}
  async function unsignedReadMustFail(key){
    const signed=await database().createUploadUrl(key,{expireSeconds:60});
    const unsigned=new URL(signed.url);unsigned.search='';
    const response=await fetchImpl(unsigned.href,{method:'GET',signal:AbortSignal.timeout(10000)});
    await response.arrayBuffer();
    if(![401,403,404].includes(response.status)){await remove(key);fail(503,'存储隔离检查未通过，已停止保存测试数据。');}
    return response.status;
  }
  const publication=createPublicationService({read,write,readDraft:latest,env,fetchImpl,now,ownerId:OWNER});
  return async function handle(request){
    try{
      const url=new URL(request.url);const route=url.pathname.slice(API.length).replace(/\/$/,'')||'/';
      if(!url.pathname.startsWith(API+'/'))return json(404,{error:'接口不存在。'});
      if(route==='/public-snapshot'&&request.method==='GET')return json(200,await publication.publicSnapshot());
      if(route==='/status'&&request.method==='GET'){
        let storageReady=false;
        try{await database().list({prefix:'__health-empty-prefix/',limit:1,consistency:'strong'});storageReady=true;}catch{}
        return json(200,{testOnly:true,authConfigured:!!ready(),storageReady,maxImageBytes:IMAGE_LIMIT,requestedGitHubScopes:[],publicationConfigured:publication.configured(),publicationConfiguration:publication.configuration()});
      }
      if(route==='/login'&&request.method==='GET'){
        if(!ready())fail(503,'GitHub 测试登录尚未配置。');
        const state=randomBytes(32).toString('hex');const verifier=randomBytes(32).toString('base64url');
        await write(`oauth/${state}.json`,{verifier,expiresAt:now()+10*60*1000});
        const target=new URL('https://github.com/login/oauth/authorize');
        target.search=new URLSearchParams({client_id:config().clientId,redirect_uri:config().origin+API+'/callback',scope:'',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',allow_signup:'false'}).toString();
        return redirect(target.href,[cookie(STATE_COOKIE,state,600)]);
      }
      if(route==='/callback'&&request.method==='GET'){
        if(!ready())fail(503,'GitHub 测试登录尚未配置。');
        const state=url.searchParams.get('state');const stateCookie=cookies(request)[STATE_COOKIE];
        if(!state||!TOKEN.test(state)||!equal(state,stateCookie))fail(400,'登录校验失败，请从写作页面重新开始。');
        const pending=await read(`oauth/${state}.json`);await remove(`oauth/${state}.json`);
        if(!pending||pending.expiresAt<=now())fail(400,'登录请求已过期，请重新开始。');
        if(!url.searchParams.get('code'))return redirect(config().origin+'/author-probe/?login=cancelled',[cookie(STATE_COOKIE,'',0)]);
        const tokenResponse=await fetchImpl('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:config().clientId,client_secret:config().clientSecret,code:url.searchParams.get('code'),redirect_uri:config().origin+API+'/callback',code_verifier:pending.verifier}),signal:AbortSignal.timeout(15000)});
        const token=await tokenResponse.json();
        if(!tokenResponse.ok||!token.access_token||String(token.scope||'').trim())fail(403,'GitHub 登录权限不符合测试范围。');
        const profileResponse=await fetchImpl('https://api.github.com/user',{headers:{Authorization:`Bearer ${token.access_token}`,Accept:'application/vnd.github+json','User-Agent':'AdventureJournalAuthorProbe'},signal:AbortSignal.timeout(15000)});
        const profile=await profileResponse.json();
        if(!profileResponse.ok||String(profile.id)!==OWNER)return redirect(config().origin+'/author-probe/?login=denied',[cookie(STATE_COOKIE,'',0),cookie(SESSION_COOKIE,'',0)]);
        const sessionId=randomBytes(32).toString('hex');
        await write(`sessions/${sessionId}.json`,{userId:profile.id,login:profile.login,expiresAt:now()+60*60*1000});
        // The GitHub access token is deliberately not persisted or returned.
        return redirect(config().origin+'/author-probe/',[cookie(STATE_COOKIE,'',0),cookie(SESSION_COOKIE,sessionId,3600)]);
      }
      const user=await session(request);
      if(request.method!=='GET')mutation(request);
      if(route==='/me'&&request.method==='GET')return json(200,{login:user.login,expiresAt:user.expiresAt,testOnly:true});
      if(route==='/publication-status'&&request.method==='GET')return json(200,await publication.status());
      if(route==='/publication'&&request.method==='POST')return json(202,await publication.change(await bodyJson(request)));
      if(route==='/logout'&&request.method==='POST'){await remove(user.sessionKey);return redirect('/author-probe/',[cookie(SESSION_COOKIE,'',0)]);}
      if(route==='/drafts'&&request.method==='GET'){
        const listed=await database().list({prefix:'drafts/',limit:200,consistency:'strong'});
        const latestKeys=new Map();
        for(const {key}of listed.blobs){const parts=key.split('/');if(parts.length===3&&ID.test(parts[1])&&key.endsWith('.json')&&(!latestKeys.has(parts[1])||key>latestKeys.get(parts[1])))latestKeys.set(parts[1],key);}
        const records=await Promise.all([...latestKeys.values()].map(read));
        const items=records.filter(record=>record&&String(record.ownerId)===OWNER).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(({id,title,tags,revision,updatedAt})=>({id,title,tags,revision,updatedAt}));
        return json(200,{items});
      }
      const draftMatch=route.match(/^\/drafts\/([a-f0-9-]{36})$/);
      if(draftMatch&&request.method==='GET'){const record=await latest(draftMatch[1]);if(!record||String(record.ownerId)!==OWNER)fail(404,'草稿不存在。');return json(200,record);}
      if(route==='/drafts'&&request.method==='POST'){
        const input=await bodyJson(request);
        if(input.draft===false)fail(400,'这个验证入口只保存草稿，不执行发表。');
        const id=input.id||randomUUID();if(!ID.test(id))fail(400,'草稿标识不正确。');
        const current=await latest(id);
        if(current&&input.revision!==current.revision)fail(409,'草稿已有新版本，请重新打开后再保存。');
        if(!current&&input.revision)fail(409,'原版本不存在，请重新打开草稿。');
        const title=String(input.title||'').trim();const body=String(input.body||'');
        if(!title||title.length>120||body.length>120000)fail(400,'请填写标题，并将正文控制在测试长度内。');
        const tags=[...new Set((Array.isArray(input.tags)?input.tags:[]).map(tag=>String(tag).trim()).filter(Boolean))];
        if(tags.length>8||tags.some(tag=>tag.length>30))fail(400,'最多使用 8 个标签，每个不超过 30 字。');
        const revision=randomUUID();const updatedAt=new Date(now()).toISOString();
        const record={id,revision,ownerId:user.userId,title,body,tags,draft:true,updatedAt,previousRevision:current?.revision||null};
        const key=`drafts/${id}/${String(now()).padStart(13,'0')}-${revision}.json`;
        await write(key,record);
        const confirmed=await read(key);if(confirmed?.revision!==revision)fail(503,'保存后的读取检查未通过，请保留正文并重试。');
        const storageAnonymousStatus=await unsignedReadMustFail(key);
        return json(current?200:201,{...record,storageAnonymousStatus});
      }
      if(route==='/images'&&request.method==='POST'){
        const declared=Number(request.headers.get('content-length')||0);if(declared>IMAGE_LIMIT)fail(413,'测试图片上限为 2 MiB，请选择较小的测试图片。');
        const bytes=Buffer.from(await request.arrayBuffer());if(bytes.length>IMAGE_LIMIT)fail(413,'测试图片上限为 2 MiB，请选择较小的测试图片。');
        const mime=(request.headers.get('content-type')||'').split(';')[0];
        const valid=(mime==='image/png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(mime==='image/jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)||(mime==='image/webp'&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP');
        if(!valid)fail(415,'请选择内容有效的 PNG、JPEG 或 WebP 测试图片。');
        const id=randomUUID();const key=`images/${id}.json`;
        await write(key,{ownerId:user.userId,mime,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64')});
        const confirmed=await read(key);if(confirmed?.sha256!==createHash('sha256').update(bytes).digest('hex'))fail(503,'图片保存后的读取检查未通过。');
        const storageAnonymousStatus=await unsignedReadMustFail(key);
        return json(201,{id,url:API+'/images/'+id,bytes:bytes.length,storageAnonymousStatus});
      }
      const imageMatch=route.match(/^\/images\/([a-f0-9-]{36})$/);
      if(imageMatch&&request.method==='GET'){
        const image=await read(`images/${imageMatch[1]}.json`);if(!image||String(image.ownerId)!==OWNER)fail(404,'图片不存在。');
        return new Response(Buffer.from(image.data,'base64'),{headers:{...PRIVATE_HEADERS,'Content-Type':image.mime}});
      }
      return json(404,{error:'接口不存在。'});
    }catch(error){
      if(error instanceof RequestError||error instanceof PublicationError)return json(error.status,{error:error.message});
      console.error('Author probe request failed',error.name);
      return json(503,{error:'测试服务暂时不可用，正文没有被清空，请稍后重试。'});
    }
  };
}
