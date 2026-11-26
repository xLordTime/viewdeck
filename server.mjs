import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
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
const bucket = {
  head(key) {
    const row = metadata.get(key);
    return row && {customMetadata:JSON.parse(row.metadata)};
  },
  get(key) {
    const row = read.get(key);
    return row && {body:row.body, customMetadata:JSON.parse(row.metadata), json:()=>JSON.parse(Buffer.from(row.body).toString())};
  },
  async put(key, value, options={}) {
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
const accounts = {
  profile(owner) {
    db.prepare('INSERT OR IGNORE INTO accounts(owner) VALUES (?)').run(owner);
    const profile = db.prepare('SELECT * FROM accounts WHERE owner=?').get(owner);
    return {...profile, maxMiB:limits[profile.role]};
  },
  list(owner) {
    return db.prepare(`SELECT substr(key,instr(key,'/')+1) AS code,
      CASE WHEN key LIKE 'file/%' THEN 'file' ELSE 'group' END AS kind,
      CASE WHEN key LIKE 'file/%' THEN json_extract(metadata,'$.name')
           ELSE json_extract(CAST(body AS TEXT),'$.title') END AS name
      FROM objects WHERE json_extract(metadata,'$.owner')=? AND
      (key LIKE 'file/%' OR key LIKE 'group/%') ORDER BY rowid DESC`).all(owner);
  },
  save(owner, sorting, filter) {
    this.profile(owner);
    db.prepare('UPDATE accounts SET sorting=?, filter=? WHERE owner=?').run(sorting,filter,owner);
  }
};
if (process.argv[2] === 'roles') {
  const [command, owner, role] = process.argv.slice(3);
  if (command === 'list') {
    console.table(db.prepare('SELECT owner,role FROM accounts ORDER BY owner').all());
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
    let limit = 32*1024;
    if (incoming.method === 'POST' && url.pathname === '/api/upload') {
      const owner = await identity(new Request(url,{headers}), env);
      if (!owner) { outgoing.writeHead(401,{'Content-Type':'application/json'}).end(JSON.stringify('Anmeldung erforderlich')); return; }
      limit = (accounts.profile(owner).maxMiB ?? Infinity) * 1024 * 1024;
      if (Number(headers.get('content-length')) > limit) {
        outgoing.writeHead(413,{'Content-Type':'application/json'}).end(JSON.stringify('Datei überschreitet dein Uploadlimit.')); return;
      }
    }
    let body;
    if (incoming.method === 'POST') {
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
    const response = await worker.fetch(new Request(url,{method:incoming.method,headers,body}),env);
    for (const [name,value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name,value);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) outgoing.setHeader('Set-Cookie',cookies);
    outgoing.statusCode = response.status;
    if (incoming.method === 'HEAD') outgoing.end();
    else if (response.headers.get('content-type')?.startsWith('text/html')) {
      const html = (await response.text()).replace('href="/signin-with-chatgpt?return_to=/"','href="#guest"')
        .replace('<a class="button" target="_top" href="/signin-with-chatgpt?return_to=/">Mit ChatGPT anmelden</a>','');
      outgoing.end(html);
    } else outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('Viewdeck request failed:',error.name);
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
}).listen(Number(process.env.PORT || 8080),'0.0.0.0');
