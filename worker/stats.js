// Download counts for the "popular" sort. One SQLite-backed Durable Object
// holds every count; it needs no setup beyond the binding in wrangler.jsonc.
import { DurableObject } from 'cloudflare:workers';

const DAY = 864e5;

export class Stats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS downloads (id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);
                   CREATE TABLE IF NOT EXISTS seen (k TEXT PRIMARY KEY, t INTEGER NOT NULL);`);
  }

  // Counts one download per visitor per wallpaper per day.
  hit(id, visitor) {
    const now = Date.now();
    const k = `${visitor}:${id}`;
    const row = this.sql.exec('SELECT t FROM seen WHERE k = ?', k).toArray()[0];
    if (row && now - row.t < DAY) return false;
    this.sql.exec('INSERT INTO seen (k, t) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET t = excluded.t', k, now);
    this.sql.exec('INSERT INTO downloads (id, n) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1', id);
    if (Math.random() < 0.02) this.sql.exec('DELETE FROM seen WHERE t < ?', now - DAY);
    return true;
  }

  all() {
    return Object.fromEntries(this.sql.exec('SELECT id, n FROM downloads').toArray().map((r) => [r.id, r.n]));
  }
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

// Known wallpaper hashes, from the deployed manifest, so random ids can't be counted.
let known = null, knownAt = 0;
async function knownHashes(env, request) {
  if (!known || Date.now() - knownAt > 5 * 60e3) {
    const res = await env.ASSETS.fetch(new URL('/manifest.json', request.url));
    const m = res.ok ? await res.json() : { items: [] };
    known = new Set(m.items.map((i) => i.hash).filter(Boolean));
    knownAt = Date.now();
  }
  return known;
}

async function visitorKey(request) {
  // Salted per day, so no IP address is ever stored.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const salt = new Date().toISOString().slice(0, 10);
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${ip}`));
  return [...new Uint8Array(d).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const stub = (env) => env.STATS.get(env.STATS.idFromName('global'));

export async function handleStats(request, env, pathname) {
  if (!env.STATS) return json({ error: 'Stats unavailable' }, 503);
  if (pathname === '/api/stats' && request.method === 'GET') {
    const cacheKey = new Request(new URL('/api/stats', request.url));
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
    const res = json(await stub(env).all(), 200, { 'Cache-Control': 'public, max-age=60' });
    await caches.default.put(cacheKey, res.clone());
    return res;
  }
  if (pathname === '/api/dl' && request.method === 'POST') {
    const id = (await request.text()).trim();
    if (!/^[0-9a-f]{10}$/.test(id) || !(await knownHashes(env, request)).has(id)) return json({ ok: false }, 400);
    const counted = await stub(env).hit(id, await visitorKey(request));
    return json({ ok: true, counted });
  }
  return null;
}
