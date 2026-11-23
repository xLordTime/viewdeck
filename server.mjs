import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import worker from './worker.mjs';

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

const env = {...process.env, BUCKET:bucket};
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
    const limit = url.pathname === '/api/upload' ? 25*1024*1024 : 32*1024;
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
