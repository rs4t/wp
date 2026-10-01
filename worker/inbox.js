// Community submissions: setups ("my desk with your wallpaper") and wallpapers
// people made. Files wait in a private R2 bucket; details live in the Inbox
// Durable Object until an admin approves or rejects them. Nothing is public
// until approved, and anything left unhandled is deleted after 30 days.
//
// Needs: R2 binding SUBMISSIONS (bucket "wp-submissions"), and the secrets
// TURNSTILE_SITEKEY + TURNSTILE_SECRET. Until all three exist, submitting is off.
import { DurableObject } from 'cloudflare:workers';

const DAY = 864e5;
const KEEP_DAYS = 30;
const PER_DAY = 5;
const MAX_FILE = 50 * 1024 * 1024;
const MAX_FILES = { setup: 3, wallpaper: 5 };
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/tiff']);
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/tiff': 'tif' };

export class Inbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS subs (id TEXT PRIMARY KEY, type TEXT, status TEXT, created INTEGER, files TEXT, data TEXT);
                   CREATE TABLE IF NOT EXISTS limits (k TEXT PRIMARY KEY, day TEXT, n INTEGER);`);
  }

  // One visitor may start PER_DAY submissions per day.
  allow(visitor) {
    const day = new Date().toISOString().slice(0, 10);
    const row = this.sql.exec('SELECT day, n FROM limits WHERE k = ?', visitor).toArray()[0];
    const n = row && row.day === day ? row.n : 0;
    if (n >= PER_DAY) return false;
    this.sql.exec('INSERT INTO limits (k, day, n) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET day = excluded.day, n = excluded.n', visitor, day, n + 1);
    return true;
  }

  async create(sub) {
    this.sql.exec('INSERT INTO subs (id, type, status, created, files, data) VALUES (?, ?, ?, ?, ?, ?)',
      sub.id, sub.type, 'uploading', Date.now(), JSON.stringify(sub.files), JSON.stringify(sub.data));
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + DAY);
  }

  get(id) {
    const r = this.sql.exec('SELECT * FROM subs WHERE id = ?', id).toArray()[0];
    return r ? { ...r, files: JSON.parse(r.files), data: JSON.parse(r.data) } : null;
  }

  setStatus(id, status, from) {
    const cur = this.get(id);
    if (!cur || (from && cur.status !== from)) return false;
    this.sql.exec('UPDATE subs SET status = ? WHERE id = ?', status, id);
    return true;
  }

  list() {
    return this.sql.exec("SELECT * FROM subs WHERE status = 'new' ORDER BY created DESC").toArray()
      .map((r) => ({ ...r, files: JSON.parse(r.files), data: JSON.parse(r.data) }));
  }

  async remove(id) {
    const sub = this.get(id);
    if (!sub) return;
    await this.env.SUBMISSIONS?.delete(sub.files.map((f) => f.key));
    this.sql.exec('DELETE FROM subs WHERE id = ?', id);
  }

  // Daily cleanup: unfinished uploads after a day, everything else after KEEP_DAYS.
  async alarm() {
    const now = Date.now();
    const old = this.sql.exec("SELECT id FROM subs WHERE created < ? OR (status = 'uploading' AND created < ?)", now - KEEP_DAYS * DAY, now - DAY).toArray();
    for (const { id } of old) await this.remove(id);
    this.sql.exec('DELETE FROM limits WHERE day < ?', new Date(now - 2 * DAY).toISOString().slice(0, 10));
    if (this.sql.exec('SELECT COUNT(*) AS n FROM subs').one().n) await this.ctx.storage.setAlarm(now + DAY);
  }
}

// ---------- helpers ----------

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const fail = (status, error) => json({ error }, status);
const inbox = (env) => env.INBOX.get(env.INBOX.idFromName('global'));
const enc = new TextEncoder();
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

export const submissionsEnabled = (env) => !!(env.SUBMISSIONS && env.INBOX && env.TURNSTILE_SITEKEY && env.TURNSTILE_SECRET);

async function sign(env, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.TURNSTILE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// An upload ticket lets this browser add files to this one submission for an hour.
async function makeTicket(env, id) {
  const exp = Date.now() + 3600e3;
  return `${exp}.${await sign(env, `upload:${id}:${exp}`)}`;
}
async function checkTicket(env, id, ticket) {
  const [exp, sig] = String(ticket || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sig === (await sign(env, `upload:${id}:${exp}`));
}

async function visitorKey(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const d = await crypto.subtle.digest('SHA-256', enc.encode(`submit|${new Date().toISOString().slice(0, 10)}|${ip}`));
  return [...new Uint8Array(d).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyTurnstile(env, token, ip) {
  if (env.DEV_SKIP_TURNSTILE === '1') return true; // local testing only; never set in production
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', String(token || ''));
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const out = await res.json().catch(() => ({}));
  return out.success === true;
}

// ---------- public: /api/submit/* ----------

export async function handleSubmit(request, env, pathname) {
  if (pathname === '/api/submit/config') {
    return json(submissionsEnabled(env) ? { enabled: true, sitekey: env.TURNSTILE_SITEKEY } : { enabled: false });
  }
  if (!submissionsEnabled(env)) return fail(503, 'Submissions are not open yet');
  const url = new URL(request.url);

  if (pathname === '/api/submit/start' && request.method === 'POST') {
    const b = await request.json().catch(() => null);
    if (!b) return fail(400, 'Bad request');
    const type = b.type === 'setup' ? 'setup' : b.type === 'wallpaper' ? 'wallpaper' : null;
    if (!type) return fail(400, 'Pick what you are sending');
    const files = Array.isArray(b.files) ? b.files : [];
    if (!files.length) return fail(400, 'Add at least one image');
    if (files.length > MAX_FILES[type]) return fail(400, `Up to ${MAX_FILES[type]} images`);
    for (const f of files) {
      if (!TYPES.has(f.type)) return fail(400, `${clean(f.name, 80)}: only jpg, png, webp, avif or tiff`);
      if (!(f.size > 0) || f.size > MAX_FILE) return fail(400, `${clean(f.name, 80)}: images can be up to 50 MB`);
    }
    if (!b.consent) return fail(400, 'Please confirm the checkbox');
    const name = clean(b.name, 60);
    if (!name) return fail(400, 'Add a name or handle so you can be credited');
    const email = clean(b.email, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'That email address looks off');

    const ip = request.headers.get('CF-Connecting-IP');
    if (!(await verifyTurnstile(env, b.token, ip))) return fail(403, 'Spam check failed — please try again');
    if (!(await inbox(env).allow(await visitorKey(request)))) return fail(429, `That's ${PER_DAY} submissions today — please try again tomorrow`);

    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const data = {
      name, email,
      link: clean(b.link, 300),
      message: clean(b.message, 2000),
      caption: clean(b.caption, 200),
      category: clean(b.category, 40),
      wallpapers: (Array.isArray(b.wallpapers) ? b.wallpapers : []).filter((h) => /^[0-9a-f]{10}$/.test(h)).slice(0, 5),
    };
    const fileList = files.map((f, n) => ({ key: `sub/${id}/${n}.${EXT[f.type]}`, name: clean(f.name, 120), type: f.type, size: f.size }));
    await inbox(env).create({ id, type, files: fileList, data });
    return json({ id, ticket: await makeTicket(env, id) });
  }

  if (pathname === '/api/submit/file' && request.method === 'PUT') {
    const id = url.searchParams.get('id') || '', n = Number(url.searchParams.get('n'));
    if (!(await checkTicket(env, id, url.searchParams.get('ticket')))) return fail(403, 'Upload expired — please submit again');
    const sub = await inbox(env).get(id);
    const file = sub?.status === 'uploading' && sub.files[n];
    if (!file) return fail(400, 'Unknown file');
    const len = Number(request.headers.get('Content-Length'));
    if (!len || len > MAX_FILE || len !== file.size || !request.body) return fail(400, 'File size does not match');
    await env.SUBMISSIONS.put(file.key, request.body, { httpMetadata: { contentType: file.type } });
    return json({ ok: true });
  }

  if (pathname === '/api/submit/finish' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    if (!(await checkTicket(env, b.id, b.ticket))) return fail(403, 'Upload expired — please submit again');
    const sub = await inbox(env).get(b.id);
    if (!sub || sub.status !== 'uploading') return fail(400, 'Unknown submission');
    const stored = await env.SUBMISSIONS.list({ prefix: `sub/${b.id}/` });
    if (stored.objects.length !== sub.files.length) return fail(400, 'Some images did not finish uploading — please try again');
    await inbox(env).setStatus(b.id, 'new', 'uploading');
    return json({ ok: true });
  }
  return fail(404, 'Not found');
}

// ---------- admin: /api/inbox/* (called after the admin session check) ----------

export async function handleInbox(request, env, pathname) {
  if (!submissionsEnabled(env)) {
    if (pathname === '/api/inbox' && request.method === 'GET') return json({ enabled: false, items: [] });
    return fail(503, 'Submissions are not set up');
  }
  if (pathname === '/api/inbox' && request.method === 'GET') {
    return json({ enabled: true, items: await inbox(env).list() });
  }
  if (pathname === '/api/inbox/file' && request.method === 'GET') {
    const key = new URL(request.url).searchParams.get('key') || '';
    if (!/^sub\/[0-9a-f]{16}\/\d+\.\w+$/.test(key)) return fail(400, 'Bad key');
    const obj = await env.SUBMISSIONS.get(key);
    if (!obj) return fail(404, 'Gone');
    return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' } });
  }
  if (pathname === '/api/inbox/resolve' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    if (!/^[0-9a-f]{16}$/.test(b.id || '')) return fail(400, 'Bad id');
    await inbox(env).remove(b.id);
    return json({ ok: true });
  }
  return null;
}
