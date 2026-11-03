// Minimal in-memory GitHub git-data API for testing the admin Worker locally.
// Usage: node test/support/mock-github.mjs wallpapers.json collections.json (port 9999)
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const [, , wallsFile, collectionsFile] = process.argv;
const id = () => crypto.randomBytes(20).toString('hex');
const blobs = new Map(), trees = new Map(), commits = new Map();
const blob = (text) => { const s = id(); blobs.set(s, Buffer.from(text)); return s; };
const t0 = id();
trees.set(t0, [
  { path: 'wallpapers.json', type: 'blob', mode: '100644', sha: blob(readFileSync(wallsFile, 'utf8')) },
  { path: 'collections.json', type: 'blob', mode: '100644', sha: blob(readFileSync(collectionsFile, 'utf8')) },
]);
const c0 = id(); commits.set(c0, { tree: t0 });
let head = c0;

const body = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d ? JSON.parse(d) : {})); });
http.createServer(async (req, res) => {
  const send = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const p = new URL(req.url, 'http://x').pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
  let m;
  if (req.method === 'GET' && p === '/git/ref/heads/main') return send({ object: { sha: head } });
  if (req.method === 'GET' && (m = p.match(/^\/git\/commits\/(\w+)$/))) return send({ tree: { sha: commits.get(m[1]).tree } });
  if (req.method === 'GET' && (m = p.match(/^\/git\/trees\/(\w+)$/))) return send({ tree: trees.get(m[1]) });
  if (req.method === 'GET' && (m = p.match(/^\/git\/blobs\/(\w+)$/))) return send({ content: blobs.get(m[1]).toString('base64'), encoding: 'base64' });
  if (req.method === 'POST' && p === '/git/blobs') { const b = await body(req); return send({ sha: blob(b.content) }); }
  if (req.method === 'POST' && p === '/git/trees') {
    const b = await body(req);
    const map = new Map(trees.get(b.base_tree).map((e) => [e.path, e]));
    for (const e of b.tree) e.sha === null ? map.delete(e.path) : map.set(e.path, e);
    const s = id(); trees.set(s, [...map.values()]); return send({ sha: s });
  }
  if (req.method === 'POST' && p === '/git/commits') { const b = await body(req); const s = id(); commits.set(s, { tree: b.tree, message: b.message }); return send({ sha: s }); }
  if (req.method === 'PATCH' && p === '/git/refs/heads/main') { const b = await body(req); head = b.sha; return send({}); }
  // Test helper: current file contents.
  if (req.method === 'GET' && p === '/_file') {
    const path = new URL(req.url, 'http://x').searchParams.get('path');
    const e = trees.get(commits.get(head).tree).find((x) => x.path === path);
    res.writeHead(200); return res.end(blobs.get(e.sha));
  }
  send({ message: `mock: no route ${req.method} ${p}` }, 404);
}).listen(9999, () => console.log('mock github on 9999'));
