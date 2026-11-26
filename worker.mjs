import page from './page.mjs';
const providers={
 google:{authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',profile:'https://openidconnect.googleapis.com/v1/userinfo',scope:'openid',key:'sub'},
 discord:{authorize:'https://discord.com/oauth2/authorize',token:'https://discord.com/api/oauth2/token',profile:'https://discord.com/api/users/@me',scope:'identify',key:'id'}
};
const cookie=(req,name)=>(req.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);
const token=()=>crypto.randomUUID()+crypto.randomUUID();
const setCookie=(key,value,seconds)=>key+'='+value+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age='+seconds;
const jump=(url,c)=>new Response(null,{status:303,headers:{Location:url,'Set-Cookie':c,'Cache-Control':'no-store'}});
function enabled(env,p){return !!(env[p.toUpperCase()+'_CLIENT_ID']&&env[p.toUpperCase()+'_CLIENT_SECRET'])}
export async function identity(req,env){
 const native=req.headers.get('oai-authenticated-user-id');if(native&&!env.ACCOUNTS&&env.GATEWAY_SHARED_SECRET){
  const supplied=req.headers.get('x-viewdeck-gateway-secret')||'';
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.GATEWAY_SHARED_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
  const message=new TextEncoder().encode('viewdeck gateway');
  if(supplied.length && supplied.length<=512){
   const providedKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(supplied),{name:'HMAC',hash:'SHA-256'},false,['sign']);
   if(await crypto.subtle.verify('HMAC',key,await crypto.subtle.sign('HMAC',providedKey,message),message))return native;
  }
 }
 const id=cookie(req,'__Host-vds');if(!id||!/^[a-f0-9-]{72}$/.test(id))return null;
 const entry=await env.BUCKET.get('session/'+id);if(!entry)return null;
 const s=await entry.json();if(s.until>Date.now())return s.owner;
 await env.BUCKET.delete('session/'+id);return null;
}
async function session(env,owner,req){
 const id=token();
 await env.BUCKET.put('session/'+id,JSON.stringify({owner,device:(req.headers.get('user-agent')||'Browser').slice(0,180),until:Date.now()+86400000}));
 return setCookie('__Host-vds',id,86400);
}
async function oauth(req,env,u){
 if(u.pathname.startsWith('/auth/local/')){
  if(!env.ACCOUNTS||req.method!=='POST'||req.headers.get('Origin')!==u.origin)return json('Ungültige Anfrage',403);
  const action=u.pathname.slice('/auth/local/'.length), owner=await identity(req,env);
  if(!['register','login','update','recover'].includes(action)||(action==='update'?!owner:!!owner))return json('Aktion nicht verfügbar.',400);
  try{
   const data=await req.json();const canonical=action==='recover'?await env.ACCOUNTS.recover(data):await env.ACCOUNTS.local(action,owner,data);
   return Response.json(action==='register'?{codes:env.ACCOUNTS.codes(canonical)}:true,{headers:{'Set-Cookie':await session(env,canonical,req),'Cache-Control':'no-store'}});
  }catch(e){return json(e.status?e.message:'Anfrage fehlgeschlagen.',e.status||400)}
 }
 if (u.pathname === '/auth/logout' && req.method === 'GET') {
  const html = '<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Viewdeck · Abmelden</title><main><h1>Von Viewdeck abmelden?</h1><form method="post" action="/auth/logout"><button>Abmelden</button></form><p><a href="/">Zurück zu Viewdeck</a></p></main></html>';
  return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'same-origin','Content-Security-Policy':"frame-ancestors 'none'; form-action 'self'"}});
 }
 if(u.pathname==='/auth/logout'){if(req.method!=='POST'||req.headers.get('Origin')!==u.origin)return new Response(null,{status:403});const id=cookie(req,'__Host-vds');if(id&&/^[a-f0-9-]{72}$/.test(id))await env.BUCKET.delete('session/'+id);return jump('/signout-with-chatgpt?return_to=/',setCookie('__Host-vds','',0))}
 const [,a,p,step]=u.pathname.split('/'),provider=Object.hasOwn(providers,p)&&providers[p];if(!provider||!enabled(env,p))return new Response('Anbieter ist noch nicht eingerichtet.',{status:503});
 const redirect=u.origin+'/auth/'+p+'/callback',client_id=env[p.toUpperCase()+'_CLIENT_ID'];
 if(!step||step==='link'){
 const linking=step==='link';
 if(linking&&(!env.ACCOUNTS||req.method!=='POST'||req.headers.get('Origin')!==u.origin||!await identity(req,env)||!cookie(req,'__Host-vds')))return json('Anmeldung erforderlich',403);
 const state=token(),next=new URL(provider.authorize);next.search=new URLSearchParams({client_id,redirect_uri:redirect,state,response_type:'code',scope:provider.scope});return jump(next.href,setCookie('__Host-vdo',p+'.'+state+(linking?'.'+cookie(req,'__Host-vds'):''),600))}
 const state=u.searchParams.get('state'),code=u.searchParams.get('code');const expected=p+'.'+state, saved=cookie(req,'__Host-vdo'), linking=saved?.startsWith(expected+'.');
 if(step!=='callback'||!code||!state||(saved!==expected&&!(linking&&saved===expected+'.'+cookie(req,'__Host-vds'))))return new Response('Anmeldung abgelaufen. Bitte erneut anmelden.',{status:400});
 const response=await fetch(provider.token,{method:'POST',body:new URLSearchParams({grant_type:'authorization_code',code,client_id,client_secret:env[p.toUpperCase()+'_CLIENT_SECRET'],redirect_uri:redirect})});if(!response.ok)return new Response('Anmeldung fehlgeschlagen.',{status:401});
 const {access_token}=await response.json(),profile=await fetch(provider.profile,{headers:{Authorization:'Bearer '+access_token}});if(!profile.ok)return new Response('Profil nicht verfügbar.',{status:401});
 const data=await profile.json(), sub=data[provider.key];if(typeof sub!=='string'||!sub)return new Response(null,{status:401});
 const target=linking?await identity(req,env):null;
 if(linking&&!target)return json('Verknüpfung abgelaufen',403);
 const subject=p+':'+sub;
 const name=String(data.global_name||data.name||data.username||subject).slice(0,80);
 const avatar=p==='discord'&&data.avatar?'https://cdn.discordapp.com/avatars/'+encodeURIComponent(sub)+'/'+encodeURIComponent(data.avatar)+'.png':p==='google'&&/^https:\/\//.test(data.picture||'')?data.picture:'';
 let owner;
 try{owner=env.ACCOUNTS?env.ACCOUNTS.oauth(subject,target,name,avatar):subject}catch(e){return json(e.status?e.message:'Anmeldung fehlgeschlagen',e.status||500)}
 const done=jump('/',await session(env,owner,req));done.headers.append('Set-Cookie',setCookie('__Host-vdo','',0));return done;
}

const json=(v,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
const code=()=>Array.from(crypto.getRandomValues(new Uint8Array(8)),v=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[v%32]).join('');
const valid=c=>/^[A-Z2-9]{8}$/.test(c);
export default {async fetch(req,env){
 const u=new URL(req.url), p=u.pathname; if(p.startsWith('/auth/'))return oauth(req,env,u); const owner=(p==='/api/me'||p==='/api/library'||req.method==='POST')?await identity(req,env):null;
 const bucket=env.BUCKET;
 if(p==='/api/me')return json({local:!!env.ACCOUNTS,signed:!!owner,profile:owner&&env.ACCOUNTS?env.ACCOUNTS.profile(owner):null,providers:Object.keys(providers).filter(p=>enabled(env,p))});
 if(p==='/api/library' && env.ACCOUNTS) return owner?json(env.ACCOUNTS.list(owner)):json('Anmeldung erforderlich',401);
 if(req.method==='POST'){
  if(!owner)return json('Anmeldung erforderlich',401);
  if(req.headers.get('Origin')!==u.origin)return json('Ungültiger Ursprung',403);
  if(p==='/api/manage'&&env.ACCOUNTS){
   try{
    const {action,id,enabled}=await req.json();
    switch(action){
     case 'security':return json(env.ACCOUNTS.security(owner,cookie(req,'__Host-vds')));
     case 'end':env.ACCOUNTS.endSession(owner,id);break;
     case 'unlink':env.ACCOUNTS.unlink(owner,id);break;
     case 'codes':return json(env.ACCOUNTS.codes(owner));
     case 'retention':env.ACCOUNTS.retention(owner,enabled);break;
     case 'delete':if(!valid(id))return json('Ungültiger Code',400);env.ACCOUNTS.erase(owner,id);break;
     default:return json('Unbekannte Aktion',400);
    }
    return json(true);
   }catch(e){return json(e.status?e.message:'Aktion fehlgeschlagen',e.status||400)}
  }
  if(p==='/api/profile'&&env.ACCOUNTS){
   try{env.ACCOUNTS.edit(owner,await req.json());return json(true)}catch(e){return json(e.status?e.message:'Ungültige Profildaten',e.status||400)}
  }
  if(p==='/api/settings' && env.ACCOUNTS){
   const settings=await req.json().catch(()=>null);
   if(!settings || !['newest','name'].includes(settings.sorting) || !['all','file','group'].includes(settings.filter))return json('Ungültige Einstellung',400);
   env.ACCOUNTS.save(owner,settings.sorting,settings.filter);return json(true);
  }
  if(p==='/api/share' && env.ACCOUNTS){
   const {id,action}=await req.json();
   if(!valid(id)||!['rotate','revoke'].includes(action))return json('Ungültige Freigabe',400);
   const next=code();
   return env.ACCOUNTS.share(owner,id,action,next)?json({id:action==='rotate'?next:id}):json('Freigabe nicht gefunden',404);
  }
  if(p==='/api/upload'){
   const size=Number(req.headers.get('content-length')),name=u.searchParams.get('name')?.slice(0,220);
   const maxMiB=env.ACCOUNTS ? env.ACCOUNTS.profile(owner).maxMiB : 25;
   if(!name||!size)return json('Dateiname oder Inhalt fehlt.',400);
   if(maxMiB!==null && size>maxMiB*1024*1024)return json('Maximal '+maxMiB+' MiB pro Datei.',413);
   const replace=u.searchParams.get('replace');
   if(replace&&(!env.ACCOUNTS||!valid(replace)||(await bucket.head('file/'+replace))?.customMetadata.owner!==owner))return json('Datei nicht gefunden',404);
   const id=replace||code();await bucket.put('file/'+id,req.body,{replace:!!replace,customMetadata:{name,owner}});
   return json({id,name});
  }
  if(p==='/api/group'){
   const {ids,title}=await req.json();if(!Array.isArray(ids)||!ids.length||ids.length>40||!ids.every(valid))return json('Ungültige Gruppe',400);
   for(const id of ids)if((await bucket.head('file/'+id))?.customMetadata.owner!==owner)return json('Zugriff verweigert',403);
   const id=code();await bucket.put('group/'+id,JSON.stringify({ids,title:String(title||'Dateigruppe').slice(0,160)}),{customMetadata:{owner}});return json({id});
  }
 }
 const [_,route,id]=p.split('/');
 if(valid(id)&&['meta','file','download'].includes(route)){
  const f=await bucket.head('file/'+id);
  if(f?.customMetadata.revoked)return json('Freigabe deaktiviert',404);
  if(!f){const g=route==='meta'&&await bucket.get('group/'+id);return g&&!g.customMetadata.revoked?json(await g.json()):json('View-Code nicht gefunden',404)}
  const name=f.customMetadata.name;
  if(route==='meta')return json({name,id});
  const ext=name.split('.').pop().toLowerCase(),type={pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',txt:'text/plain; charset=utf-8'}[ext];
  return new Response((await bucket.get('file/'+id)).body,{headers:{'Content-Type':type||'application/octet-stream','Content-Disposition':(route==='download'||!type?'attachment':'inline')+"; filename*=UTF-8''"+encodeURIComponent(name),'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
 }
 if(p==='/'||route==='v')return new Response(page,{headers:{'Content-Type':'text/html;charset=utf-8','Referrer-Policy':'same-origin'}});
 return json('Nicht gefunden',404);
}};

