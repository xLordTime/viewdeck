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
async function identity(req,env){
 const native=req.headers.get('oai-authenticated-user-id');if(native)return native;
 const id=cookie(req,'__Host-vds');if(!id||!/^[a-f0-9-]{72}$/.test(id))return null;
 const entry=await env.BUCKET.get('session/'+id);if(!entry)return null;
 const s=await entry.json();if(s.until>Date.now())return s.owner;
 await env.BUCKET.delete('session/'+id);return null;
}
async function oauth(req,env,u){
 if(u.pathname==='/auth/logout'){if(req.method!=='POST'||req.headers.get('Origin')!==u.origin)return new Response(null,{status:403});const id=cookie(req,'__Host-vds');if(id&&/^[a-f0-9-]{72}$/.test(id))await env.BUCKET.delete('session/'+id);return jump('/signout-with-chatgpt?return_to=/',setCookie('__Host-vds','',0))}
 const [,a,p,step]=u.pathname.split('/'),provider=Object.hasOwn(providers,p)&&providers[p];if(!provider||!enabled(env,p))return new Response('Anbieter ist noch nicht eingerichtet.',{status:503});
 const redirect=u.origin+'/auth/'+p+'/callback',client_id=env[p.toUpperCase()+'_CLIENT_ID'];
 if(!step){const state=token(),next=new URL(provider.authorize);next.search=new URLSearchParams({client_id,redirect_uri:redirect,state,response_type:'code',scope:provider.scope});return jump(next.href,setCookie('__Host-vdo',p+'.'+state,600))}
 const state=u.searchParams.get('state'),code=u.searchParams.get('code');if(step!=='callback'||!code||!state||cookie(req,'__Host-vdo')!==p+'.'+state)return new Response('Anmeldung abgelaufen. Bitte erneut anmelden.',{status:400});
 const response=await fetch(provider.token,{method:'POST',body:new URLSearchParams({grant_type:'authorization_code',code,client_id,client_secret:env[p.toUpperCase()+'_CLIENT_SECRET'],redirect_uri:redirect})});if(!response.ok)return new Response('Anmeldung fehlgeschlagen.',{status:401});
 const {access_token}=await response.json(),profile=await fetch(provider.profile,{headers:{Authorization:'Bearer '+access_token}});if(!profile.ok)return new Response('Profil nicht verfügbar.',{status:401});
 const sub=(await profile.json())[provider.key];if(typeof sub!=='string'||!sub)return new Response(null,{status:401});
 const id=token();await env.BUCKET.put('session/'+id,JSON.stringify({owner:p+':'+sub,until:Date.now()+86400000}));
 const done=jump('/',setCookie('__Host-vds',id,86400));done.headers.append('Set-Cookie',setCookie('__Host-vdo','',0));return done;
}

const json=(v,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
const code=()=>Array.from(crypto.getRandomValues(new Uint8Array(8)),v=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[v%32]).join('');
const valid=c=>/^[A-Z2-9]{8}$/.test(c);
export default {async fetch(req,env){
 const u=new URL(req.url), p=u.pathname; if(p.startsWith('/auth/'))return oauth(req,env,u); const owner=(p==='/api/me'||req.method==='POST')?await identity(req,env):null;
 const bucket=env.BUCKET;
 if(p==='/api/me')return json({signed:!!owner,providers:Object.keys(providers).filter(p=>enabled(env,p))});
 if(req.method==='POST'){
  if(!owner)return json('Anmeldung erforderlich',401);
  if(req.headers.get('Origin')!==u.origin)return json('Ungültiger Ursprung',403);
  if(p==='/api/upload'){
   const size=Number(req.headers.get('content-length')),name=u.searchParams.get('name')?.slice(0,220);
   if(!name||!size||size>25*1024*1024)return json('Maximal 25 MB pro Datei.',413);
   const id=code();await bucket.put('file/'+id,req.body,{customMetadata:{name,owner}});
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
  if(!f){const g=route==='meta'&&await bucket.get('group/'+id);return g?json(await g.json()):json('View-Code nicht gefunden',404)}
  const name=f.customMetadata.name;
  if(route==='meta')return json({name,id});
  const ext=name.split('.').pop().toLowerCase(),type={pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',txt:'text/plain; charset=utf-8'}[ext];
  return new Response((await bucket.get('file/'+id)).body,{headers:{'Content-Type':type||'application/octet-stream','Content-Disposition':(route==='download'||!type?'attachment':'inline')+"; filename*=UTF-8''"+encodeURIComponent(name),'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
 }
 if(p==='/'||route==='v')return new Response(page,{headers:{'Content-Type':'text/html;charset=utf-8','Referrer-Policy':'no-referrer'}});
 return json('Nicht gefunden',404);
}};

