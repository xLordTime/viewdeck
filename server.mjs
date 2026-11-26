import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { randomUUID, scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, createReadStream, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import worker, {identity} from './worker.mjs';

const origin = new URL(process.env.PUBLIC_ORIGIN);
if (origin.protocol !== 'https:' || origin.href !== origin.origin + '/') {
  throw Error('PUBLIC_ORIGIN muss eine HTTPS-Adresse ohne Pfad sein.');
}
const directory = process.env.DATA_DIR || '/data';
mkdirSync(directory, {recursive:true});
const db = new DatabaseSync(join(directory, 'viewdeck.sqlite'));
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY, metadata TEXT NOT NULL, body BLOB NOT NULL)');
const metadata = db.prepare('SELECT metadata FROM objects WHERE key=?');
const read = db.prepare('SELECT metadata, body FROM objects WHERE key=?');
const insert = db.prepare('INSERT INTO objects VALUES (?,?,?)');
const remove = db.prepare('DELETE FROM objects WHERE key=?');
// Keep upload payloads on disk. Immutable random names decouple storage from share codes.
const filesDir = join(directory,'files');
mkdirSync(filesDir,{recursive:true});
const bucket = {
  head(key) {
    const row = metadata.get(key);
    return row && {customMetadata:JSON.parse(row.metadata)};
  },
  get(key) {
    if(key.startsWith('file/')){
      const meta=this.head(key)?.customMetadata;
      if(!meta)return null;
      if(meta.disk)return {body:Readable.toWeb(createReadStream(join(filesDir,meta.disk)))};
      const size=db.prepare('SELECT length(body) AS n FROM objects WHERE key=?').get(key).n;
      const part=db.prepare('SELECT substr(body,?,?) AS bytes FROM objects WHERE key=?');
      async function* legacy(){for(let offset=0;offset<size;offset+=65536)yield part.get(offset+1,65536,key).bytes}
      return {body:Readable.toWeb(Readable.from(legacy()))};
    }
    const row = read.get(key);
    return row && {body:row.body, customMetadata:JSON.parse(row.metadata), json:()=>JSON.parse(Buffer.from(row.body).toString())};
  },
  async put(key, value, options={}) {
    if(key.startsWith('file/')){
      const disk=randomUUID(), path=join(filesDir,disk);
      try{
        await pipeline(Readable.fromWeb(value),createWriteStream(path,{flags:'wx'}));
        insert.run(key,JSON.stringify({...options.customMetadata,disk}),Buffer.alloc(0));
      }catch(error){await unlink(path).catch(()=>{});throw error}
      return;
    }
    const body = Buffer.from(await new Response(value).arrayBuffer());
    insert.run(key, JSON.stringify(options.customMetadata || {}), body);
  },
  delete(key) { remove.run(key); }
};

db.exec(`CREATE TABLE IF NOT EXISTS accounts (
  owner TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'standard',
  sorting TEXT NOT NULL DEFAULT 'newest', filter TEXT NOT NULL DEFAULT 'all'
);
CREATE INDEX IF NOT EXISTS objects_owner ON objects(json_extract(metadata,'$.owner'));`);
const limits = {standard:25, plus:50, pro:100, admin:null};
db.exec(`CREATE TABLE IF NOT EXISTS identities (subject TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, avatar TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS identities_owner ON identities(owner);
CREATE TABLE IF NOT EXISTS credentials (owner TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profiles (owner TEXT PRIMARY KEY, nickname TEXT NOT NULL, email TEXT NOT NULL, picture TEXT NOT NULL);`);
const invalid=(message,status=400)=>Object.assign(Error(message),{status});
const derive=promisify(scrypt);
let hashing=0;
async function passwordHash(password,salt){
 if(hashing>=2)throw invalid('Bitte gleich erneut versuchen.',429);
 hashing++;
 try{return await derive(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024})}finally{hashing--}
}
function details(owner){
 const prefs=db.prepare('SELECT nickname,email,picture FROM profiles WHERE owner=?').get(owner)||{nickname:'',email:'',picture:'login'};
 const providers=db.prepare('SELECT subject,name,avatar FROM identities WHERE owner=? ORDER BY rowid').all(owner);
 const username=db.prepare('SELECT username FROM credentials WHERE owner=?').get(owner)?.username||'';
 const nickname=prefs.nickname||(owner.startsWith('local:')?username:'')||providers.find(p=>p.subject===owner)?.name||providers[0]?.name||username||owner;
 const avatar=prefs.picture==='gravatar'&&prefs.email?'https://www.gravatar.com/avatar/'+createHash('sha256').update(prefs.email.trim().toLowerCase()).digest('hex')+'?s=96&d=identicon':providers.find(p=>p.avatar)?.avatar||'';
 return {...prefs,nickname,avatar,username,methods:providers.map(p=>p.subject.split(':')[0])};
}
const accounts = {
 oauth(subject,target,name,avatar){
  const existing=db.prepare('SELECT owner FROM identities WHERE subject=?').get(subject)?.owner ||
   (db.prepare('SELECT owner FROM accounts WHERE owner=?').get(subject)?.owner);
  if(target&&existing&&target!==existing)throw invalid('Diese Anmeldung gehört bereits zu einem anderen Konto.',409);
  const owner=target||existing||subject;
  db.prepare('INSERT INTO identities VALUES (?,?,?,?) ON CONFLICT(subject) DO UPDATE SET name=excluded.name,avatar=excluded.avatar').run(subject,owner,name,avatar);
  this.profile(owner);return owner;
 },
 edit(owner,{nickname,email,picture}){
  if(typeof nickname!=='string'||nickname.length>80||typeof email!=='string'||email.length>254||!['login','gravatar'].includes(picture)||(picture==='gravatar'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))throw invalid('Bitte prüfe Nickname und Gravatar-Adresse.');
  db.prepare('INSERT OR REPLACE INTO profiles VALUES (?,?,?,?)').run(owner,nickname.trim(),email.trim(),picture);
 },
 async local(action,owner,{username,password,current}){
  if(typeof username!=='string'||!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)||typeof password!=='string'||password.length>256)throw invalid('Username: 3–40 Buchstaben, Zahlen oder . _ -');
  const entry=action==='login'?db.prepare('SELECT * FROM credentials WHERE username=?').get(username):owner&&db.prepare('SELECT * FROM credentials WHERE owner=?').get(owner);
  if(action==='login'||entry){
   const input=action==='login'?password:current;
   if(typeof input!=='string'||input.length>256)throw invalid('Aktuelles Passwort erforderlich.');
   const actual=await passwordHash(input,entry?.salt||'viewdeck-dummy-salt');
   if(!entry||!timingSafeEqual(actual,Buffer.from(entry.hash,'hex')))throw invalid('Anmeldedaten ungültig.',401);
   if(action==='login')return entry.owner;
  }
  if(password.length<12)throw invalid('Bitte mindestens 12 Zeichen als Passwort verwenden.');
  owner=owner||'local:'+randomUUID();
  const salt=randomBytes(16).toString('hex'),hash=(await passwordHash(password,salt)).toString('hex');
  try{
   if(entry){
    const changed=db.prepare('UPDATE credentials SET username=?,salt=?,hash=? WHERE owner=? AND hash=?').run(username,salt,hash,owner,entry.hash);
    if(!changed.changes)throw invalid('Profil wurde zwischenzeitlich geändert.',409);
    db.prepare("DELETE FROM objects WHERE key LIKE 'session/%' AND json_extract(CAST(body AS TEXT),'$.owner')=?").run(owner);
   }else db.prepare('INSERT INTO credentials VALUES (?,?,?,?)').run(owner,username,salt,hash);
  }catch(e){if(String(e.message).includes('UNIQUE'))throw invalid('Username oder Zugang bereits belegt.',409);throw e}
  this.profile(owner);return owner;
 },
  profile(owner) {
    db.prepare('INSERT OR IGNORE INTO accounts(owner) VALUES (?)').run(owner);
    const profile = db.prepare('SELECT * FROM accounts WHERE owner=?').get(owner);
    return {...profile,...details(owner), maxMiB:limits[profile.role]};
  },
  list(owner) {
    return db.prepare(`SELECT substr(key,instr(key,'/')+1) AS code,json_extract(metadata,'$.revoked') AS revoked,
      CASE WHEN key LIKE 'file/%' THEN 'file' ELSE 'group' END AS kind,
      CASE WHEN key LIKE 'file/%' THEN json_extract(metadata,'$.name')
           ELSE json_extract(CAST(body AS TEXT),'$.title') END AS name
      FROM objects WHERE json_extract(metadata,'$.owner')=? AND
      (key LIKE 'file/%' OR key LIKE 'group/%') ORDER BY rowid DESC`).all(owner);
  },
  share(owner,id,action,newId){
    db.exec('BEGIN IMMEDIATE');
    try{
      let key='file/'+id;
      if(!metadata.get(key))key='group/'+id;
      const meta=bucket.head(key)?.customMetadata;
      if(meta?.owner!==owner){db.exec('ROLLBACK');return false}
      const group=key.startsWith('group/');
      if(action==='rotate'&&(metadata.get('file/'+newId)||metadata.get('group/'+newId)))throw Error('Code collision');
      meta.revoked=action==='revoke';
      db.prepare('UPDATE objects SET key=?,metadata=? WHERE key=?').run(action==='rotate'?key.split('/')[0]+'/'+newId:key,JSON.stringify(meta),key);
      if(!group && action==='rotate'){
        const groups=db.prepare("SELECT key,body FROM objects WHERE key LIKE 'group/%' AND json_extract(metadata,'$.owner')=?").all(owner);
        for(const row of groups){
          const data=JSON.parse(Buffer.from(row.body));
          if(!data.ids.includes(id))continue;
          data.ids=data.ids.map(code=>code===id?newId:code);
          db.prepare('UPDATE objects SET body=? WHERE key=?').run(Buffer.from(JSON.stringify(data)),row.key);
        }
      }
      db.exec('COMMIT');return true;
    }catch(error){db.exec('ROLLBACK');throw error}
  },
  save(owner, sorting, filter) {
    this.profile(owner);
    db.prepare('UPDATE accounts SET sorting=?, filter=? WHERE owner=?').run(sorting,filter,owner);
  }
};
if (process.argv[2] === 'roles') {
  const [command, owner, role] = process.argv.slice(3);
  if (command === 'list') {
    console.table(db.prepare('SELECT owner,role FROM accounts ORDER BY owner').all().map(row=>({...row,nickname:details(row.owner).nickname})));
  } else if (command === 'set' && owner && Object.hasOwn(limits,role)) {
    const result=db.prepare('UPDATE accounts SET role=? WHERE owner=?').run(role, owner);
    if (!result.changes) { console.error('Unbekannte Konto-ID. Einmal in Viewdeck anmelden.'); process.exit(1); }
    console.log(owner,role);
  } else {
    console.error('roles list | roles set KONTO-ID standard|plus|pro|admin'); process.exit(1);
  }
  db.close(); process.exit(0);
}
const env = {...process.env, BUCKET:bucket, ACCOUNTS:accounts};
const authAttempts=new Map();
const cleanup=setInterval(()=>{for(const [key,entry] of authAttempts)if(entry.until<=Date.now())authAttempts.delete(key)},60000);
cleanup.unref();
http.createServer(async (incoming, outgoing) => {
  try {
    const path = incoming.url;
    if (!path.startsWith('/') || path.startsWith('//')) { outgoing.writeHead(400).end(); return; }
    const url = new URL(origin.origin + path);
    if (url.origin !== origin.origin) { outgoing.writeHead(400).end(); return; }
    if (url.pathname === '/healthz') { db.prepare('SELECT 1').get(); outgoing.end('ok'); return; }
    if (url.pathname === '/signout-with-chatgpt') { outgoing.writeHead(303,{Location:'/'}).end(); return; }
    const headers = new Headers();
    for (const name of ['origin','cookie','content-type','content-length']) {
      if (incoming.headers[name]) headers.set(name,incoming.headers[name]);
    }
    if(incoming.method==='POST'&&url.pathname.startsWith('/auth/local/')&&headers.get('origin')===origin.origin){
      const key=incoming.socket.remoteAddress,now=Date.now();
      let entry=authAttempts.get(key);
      if(!entry||entry.until<=now){entry={count:0,until:now+60000};authAttempts.set(key,entry)}
      if(++entry.count>60){outgoing.writeHead(429,{'Content-Type':'application/json','Retry-After':'60'}).end(JSON.stringify('Zu viele Versuche. Bitte später erneut versuchen.'));return}
    }
    let limit = 32*1024;
    let body;
    if (incoming.method === 'POST' && url.pathname === '/api/upload') {
      const owner = await identity(new Request(url,{headers}), env);
      if (!owner) { outgoing.writeHead(401,{'Content-Type':'application/json'}).end(JSON.stringify('Anmeldung erforderlich')); return; }
      limit = (accounts.profile(owner).maxMiB ?? Infinity) * 1024 * 1024;
      if (Number(headers.get('content-length')) > limit) {
        outgoing.writeHead(413,{'Content-Type':'application/json'}).end(JSON.stringify('Datei überschreitet dein Uploadlimit.')); return;
      }
      let received=0;
      const counter=new Transform({transform(chunk,encoding,done){
        received+=chunk.length;
        if(received>limit)return done(Object.assign(Error('Uploadlimit überschritten'),{status:413}));
        done(null,chunk);
      }});
      incoming.on('error',error=>counter.destroy(error));
      body=Readable.toWeb(incoming.pipe(counter));
    } else if (incoming.method === 'POST') {
      const parts = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > limit) { outgoing.writeHead(413).end(); return; }
        parts.push(chunk);
      }
      body = Buffer.concat(parts);
      headers.set('content-length',String(size));
    } else if (!['HEAD','GET'].includes(incoming.method)) { outgoing.writeHead(405).end(); return; }
    const response = await worker.fetch(new Request(url,{method:incoming.method,headers,body,duplex:'half'}),env);
    for (const [name,value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name,value);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) outgoing.setHeader('Set-Cookie',cookies);
    outgoing.statusCode = response.status;
    if (incoming.method === 'HEAD') outgoing.end();
    else if (response.headers.get('content-type')?.startsWith('text/html')) {
      const html = (await response.text()).replace('href="/signin-with-chatgpt?return_to=/"','href="#guest"')
        .replace('<a class="button" target="_top" href="/signin-with-chatgpt?return_to=/">Mit ChatGPT anmelden</a>','');
      outgoing.end(html);
    } else if(response.body)await pipeline(Readable.fromWeb(response.body),outgoing);
    else outgoing.end();
  } catch (error) {
    console.error('Viewdeck request failed:',error.name);
    if (!outgoing.headersSent) outgoing.writeHead(error.status||500);
    outgoing.end();
  }
}).listen(Number(process.env.PORT || 8080),'0.0.0.0');
